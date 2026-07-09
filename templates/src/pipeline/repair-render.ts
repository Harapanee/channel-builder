/**
 * 部分再レンダー+継ぎ接ぎ(壊れたショットだけ焼き直す)。
 *
 * 全編レンダー(数十分〜)をやり直さずに、指定ショット群の区間だけを
 * `remotion render --frames=a-b` で再生成し、既存の out mp4 に ffmpeg で
 * 継ぎ接ぎする。修正が数ショットに閉じているときの修理ツール。
 *
 * 仕組み:
 * 1. shots.json から対象ショット群の連続フレーム範囲(fps=30、隣接ショットは
 *    1つの範囲にまとめる)を計算
 * 2. `npx remotion render ... --frames=a-b` で区間mp4を生成
 *    (codec/crf等のフラグは scripts/render-episode.sh と同じく**指定しない**
 *    = Remotion既定 h264/crf18。継ぎ接ぎの再エンコードもこれに合わせる)
 * 3. ffmpeg で 元mp4を [0,a) / (b,end] に切り、区間mp4と結合。
 *    **映像は再エンコード**(libx264 / crf18 / 元と同じfps・解像度・pix_fmt)、
 *    **音声は元mp4のトラックをそのまま全長コピー**(音声タイムラインは不変の
 *    ため。区間mp4の音声は破棄する)
 * 4. 出来上がりの duration が元と ±0.1s 以内であることを自己検証してから
 *    out/<out>.mp4 を置換(元は out/<out>.backup.mp4 に退避)
 *
 * ffmpeg/ffprobe はシステムの `which` で探し、無ければ Remotion 同梱
 * (node_modules/@remotion/compositor-*)のバイナリを使う。
 *
 * CLI: tsx src/pipeline/repair-render.ts episodes/<epId> <shotId>[,<shotId>...] [--out preview]
 */
import path from "node:path";
import os from "node:os";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import type { ShotsFile } from "../schemas/types";

/** Remotion既定のh264品質(render-episode.shはフラグ未指定=この既定でエンコードする) */
const REMOTION_DEFAULT_CRF = "18";
/** 置換前の自己検証: durationの許容ずれ(秒) */
const DURATION_TOLERANCE_SEC = 0.1;

type FrameRange = { start: number; end: number; shotIds: string[] }; // 両端含む

function findBinary(name: "ffmpeg" | "ffprobe"): string {
  try {
    const p = execSync(`which ${name}`, { encoding: "utf-8" }).trim();
    if (p) return p;
  } catch {
    /* fallthrough */
  }
  // Remotion同梱バイナリ(@remotion/compositor-<platform>-<arch>/ffmpeg)を探す
  const remotionDir = path.resolve("node_modules/@remotion");
  if (existsSync(remotionDir)) {
    for (const entry of readdirSync(remotionDir)) {
      if (!entry.startsWith("compositor-")) continue;
      const candidate = path.join(remotionDir, entry, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    `${name} が見つかりません(システムにも node_modules/@remotion/compositor-* にも無い)`
  );
}

function probe(ffprobe: string, file: string) {
  const json = execFileSync(
    ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,pix_fmt,r_frame_rate,nb_frames",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf-8" }
  );
  const data = JSON.parse(json) as {
    streams: {
      codec_name: string;
      width: number;
      height: number;
      pix_fmt: string;
      r_frame_rate: string;
      nb_frames?: string;
    }[];
    format: { duration: string };
  };
  const v = data.streams[0];
  const [num, den] = v.r_frame_rate.split("/").map(Number);
  return {
    codec: v.codec_name,
    width: v.width,
    height: v.height,
    pixFmt: v.pix_fmt,
    fps: num / den,
    nbFrames: v.nb_frames ? Number(v.nb_frames) : undefined,
    durationSec: Number(data.format.duration),
  };
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let out = "preview";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      out = argv[++i] ?? "";
      if (!out) throw new Error("--out に名前を指定してください");
    } else positional.push(a);
  }
  return { episodeDir: positional[0], shotIdsCsv: positional[1], out };
}

function main() {
  const { episodeDir, shotIdsCsv, out } = parseArgs(process.argv.slice(2));
  if (!episodeDir || !shotIdsCsv) {
    console.error(
      "usage: repair-render.ts episodes/<epId> <shotId>[,<shotId>...] [--out preview]"
    );
    process.exit(1);
  }

  const shotsFile = JSON.parse(
    readFileSync(path.join(episodeDir, "shots.json"), "utf-8")
  ) as ShotsFile;
  const fps = shotsFile.fps;

  const targetIds = shotIdsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  const byId = new Map(shotsFile.shots.map((s) => [s.shotId, s]));
  for (const id of targetIds) {
    if (!byId.has(id)) {
      console.error(`shotId "${id}" が shots.json にありません`);
      process.exit(1);
    }
  }

  const origPath = path.join(episodeDir, "out", `${out}.mp4`);
  if (!existsSync(origPath)) {
    console.error(`${origPath} がありません(先に全編レンダーが必要)`);
    process.exit(1);
  }

  const ffmpeg = findBinary("ffmpeg");
  const ffprobe = findBinary("ffprobe");
  const orig = probe(ffprobe, origPath);
  const totalFrames =
    orig.nbFrames ?? Math.round(orig.durationSec * orig.fps);
  console.log(
    `original: ${origPath} — ${orig.codec} ${orig.width}x${orig.height} ` +
      `${orig.fps}fps ${orig.pixFmt}, ${orig.durationSec.toFixed(3)}s (${totalFrames} frames)`
  );
  if (Math.round(orig.fps) !== fps) {
    console.error(
      `元mp4のfps(${orig.fps})が shots.json のfps(${fps})と一致しません`
    );
    process.exit(1);
  }

  // ---- 対象ショット → フレーム範囲(隣接・重複はまとめる) --------------
  const rawRanges: FrameRange[] = targetIds
    .map((id) => {
      const s = byId.get(id)!;
      const start = Math.max(0, Math.floor(s.startSec * fps));
      const end = Math.min(totalFrames - 1, Math.ceil(s.endSec * fps) - 1);
      return { start, end, shotIds: [id] };
    })
    .sort((a, b) => a.start - b.start);

  const ranges: FrameRange[] = [];
  for (const r of rawRanges) {
    const last = ranges[ranges.length - 1];
    if (last && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
      last.shotIds.push(...r.shotIds);
    } else {
      ranges.push({ ...r });
    }
  }
  for (const r of ranges) {
    console.log(
      `range: frames ${r.start}-${r.end} (${((r.end - r.start + 1) / fps).toFixed(1)}s) — ${r.shotIds.join(", ")}`
    );
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "repair-render-"));
  try {
    // ---- 区間mp4のレンダー(render-episode.shと同じ既定エンコード) ------
    const segPaths: string[] = [];
    for (const [i, r] of ranges.entries()) {
      const segPath = path.join(tmpDir, `segment-${i}.mp4`);
      segPaths.push(segPath);
      console.log(`=== rendering segment ${i + 1}/${ranges.length}: frames ${r.start}-${r.end} ===`);
      // render-episode.sh 同様、codec/crf等は指定しない(Remotion既定に揃える)
      execSync(
        `npx remotion render src/remotion/Root.tsx Episode ${JSON.stringify(segPath)} ` +
          `--props=${JSON.stringify(JSON.stringify({ episodeDir }))} ` +
          `--frames=${r.start}-${r.end} 2>&1 | grep -vE "^Rendering|^Encoded" || true`,
        { stdio: "inherit", shell: "/bin/bash" }
      );
      if (!existsSync(segPath)) {
        console.error(`segment ${i} のレンダーに失敗しました`);
        process.exit(1);
      }
      const seg = probe(ffprobe, segPath);
      const expectFrames = r.end - r.start + 1;
      if (seg.nbFrames !== undefined && seg.nbFrames !== expectFrames) {
        console.error(
          `segment ${i} のフレーム数が不正です(期待 ${expectFrames}, 実際 ${seg.nbFrames})`
        );
        process.exit(1);
      }
    }

    // ---- ffmpeg 継ぎ接ぎ(映像: 再エンコード / 音声: 元をそのままコピー) --
    type Part =
      | { type: "orig"; from: number; to: number } // 両端含む
      | { type: "seg"; index: number };
    const parts: Part[] = [];
    let cursor = 0;
    for (const [i, r] of ranges.entries()) {
      if (r.start > cursor) parts.push({ type: "orig", from: cursor, to: r.start - 1 });
      parts.push({ type: "seg", index: i });
      cursor = r.end + 1;
    }
    if (cursor <= totalFrames - 1) {
      parts.push({ type: "orig", from: cursor, to: totalFrames - 1 });
    }

    const filters: string[] = [];
    const labels: string[] = [];
    for (const [k, p] of parts.entries()) {
      const label = `v${k}`;
      if (p.type === "orig") {
        // trim: start_frame含む/end_frame含まない → to+1
        filters.push(
          `[0:v]trim=start_frame=${p.from}:end_frame=${p.to + 1},setpts=PTS-STARTPTS[${label}]`
        );
      } else {
        filters.push(`[${1 + p.index}:v]setpts=PTS-STARTPTS[${label}]`);
      }
      labels.push(`[${label}]`);
    }
    filters.push(`${labels.join("")}concat=n=${parts.length}:v=1:a=0[vout]`);

    const mergedPath = path.join(tmpDir, "merged.mp4");
    const ffmpegArgs = [
      "-y",
      "-i", origPath,
      ...segPaths.flatMap((p) => ["-i", p]),
      "-filter_complex", filters.join(";"),
      "-map", "[vout]",
      "-map", "0:a", // 音声は元mp4を全長コピー(タイムライン不変)
      "-c:v", "libx264",
      "-crf", REMOTION_DEFAULT_CRF,
      "-pix_fmt", orig.pixFmt,
      "-r", String(fps),
      "-c:a", "copy",
      "-movflags", "+faststart",
      mergedPath,
    ];
    console.log("=== splicing with ffmpeg ===");
    execFileSync(ffmpeg, ffmpegArgs, { stdio: ["ignore", "inherit", "inherit"] });

    // ---- 自己検証: duration が元と ±0.1s 以内 ---------------------------
    const merged = probe(ffprobe, mergedPath);
    const durationDiff = Math.abs(merged.durationSec - orig.durationSec);
    console.log(
      `self-check: duration ${merged.durationSec.toFixed(3)}s vs ${orig.durationSec.toFixed(3)}s ` +
        `(diff ${durationDiff.toFixed(3)}s, 許容 ${DURATION_TOLERANCE_SEC}s) / ` +
        `frames ${merged.nbFrames ?? "?"} vs ${totalFrames} / ` +
        `${merged.width}x${merged.height} ${merged.fps}fps ${merged.pixFmt}`
    );
    if (durationDiff > DURATION_TOLERANCE_SEC) {
      console.error(
        `NG: duration が許容差 ${DURATION_TOLERANCE_SEC}s を超えています。元mp4は変更していません`
      );
      process.exit(1);
    }
    if (
      merged.width !== orig.width ||
      merged.height !== orig.height ||
      Math.round(merged.fps) !== Math.round(orig.fps)
    ) {
      console.error("NG: 解像度/fpsが元と一致しません。元mp4は変更していません");
      process.exit(1);
    }

    // ---- 置換(元は .backup.mp4 に退避) ---------------------------------
    const backupPath = path.join(episodeDir, "out", `${out}.backup.mp4`);
    renameSync(origPath, backupPath);
    try {
      renameSync(mergedPath, origPath);
    } catch {
      // tmpが別ボリュームの場合(EXDEV)はコピーで代替
      copyFileSync(mergedPath, origPath);
    }
    console.log(`OK: ${origPath} を置換しました(元: ${backupPath})`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
