/**
 * 較正用(使い捨て)。指定ディレクトリの全クリップを測って TSV で出す。
 *
 * measureClip の値に加えて、設計 §6.5 が候補に挙げている「先頭/末尾フレームの差」
 * (edgeDiff)もここで測る。相関が出たときだけ clip-metrics.ts へ昇格させる。
 * 相関が出なければ採用しない(既存規約「解析できない検査は緑にしない」)。
 */
import { basename, join } from "node:path";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { measureClip } from "./clip-metrics";

const EDGE_W = 128;
const EDGE_H = 72;

/** 指定時刻の1フレームを 128x72 グレースケール生バッファで取る */
function grabGray(mp4: string, atSec: number): Buffer {
  const r = spawnSync(
    "ffmpeg",
    [
      "-v", "error", "-ss", atSec.toFixed(3), "-i", mp4,
      "-vf", `scale=${EDGE_W}:${EDGE_H},format=gray`,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.error) throw new Error(`ffmpeg の起動に失敗: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg が失敗(${r.status}): ${r.stderr.toString("utf8").slice(0, 300)}`);
  if (r.stdout.length < EDGE_W * EDGE_H) throw new Error(`${mp4} @${atSec}: フレームが取れない`);
  return r.stdout.subarray(0, EDGE_W * EDGE_H);
}

/** 先頭フレームと末尾フレームの平均絶対差(0〜255)。大きいほど「別の絵になった」 */
export function edgeDiff(mp4: string, durationSec: number): number {
  const a = grabGray(mp4, 0);
  const b = grabGray(mp4, Math.max(0, durationSec - 0.15));
  let acc = 0;
  for (let i = 0; i < a.length; i += 1) acc += Math.abs(a[i] - b[i]);
  return acc / a.length;
}

function main(): void {
  const dir = process.argv[2];
  const label = process.argv[3] ?? "";
  const header = process.argv.includes("--no-header") ? null
    : ["id", "label", "frames", "dur", "w", "diffMean", "diffMax", "diffSamples", "lumaMin", "lumaMax", "edgeDiff"];
  if (header) console.log(header.join("\t"));
  let failures = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".mp4")).sort()) {
    try {
      const p = join(dir, f);
      const m = measureClip(p);
      console.log([
        f.replace(/\.mp4$/, ""), label, m.frames, m.durationSec.toFixed(2), m.width,
        m.frameDiffMean.toFixed(3), m.frameDiffMax.toFixed(3), m.diffSamples,
        Math.min(...m.lumaStd).toFixed(1), Math.max(...m.lumaStd).toFixed(1),
        edgeDiff(p, m.durationSec).toFixed(3),
      ].join("\t"));
    } catch (e) {
      failures += 1;
      console.error("計測失敗 " + f + ": " + (e as Error).message);
    }
  }
  if (failures > 0) {
    console.error(`計測失敗 ${failures} 件`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && basename(process.argv[1]) === "calibrate.ts") main();
