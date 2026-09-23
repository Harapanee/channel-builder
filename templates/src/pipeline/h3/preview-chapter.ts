/**
 * 1章ぶんを字幕と音つきの短い mp4 にして人間に見せる。
 *
 *   npm run h3:preview -- <epId> <章ID> [--out <名前.mp4>]
 *
 * **出力先は review/<epId>/<章ID>-preview.mp4 だけ。** episodes/<epId>/out/ には触らない。
 * review/ は .gitignore に入っており、承認済みの final.mp4 と同じ場所へは構造的に書けない
 * (--out はファイル名しか受け取らない。パス区切りが入っていたら引数の時点で止める)。
 *
 * 組み立ては assemble.ts と同一である。**別実装にしない。**
 * 区間の ffmpeg 引数(早回し・skipHeadFrames・章カードの紙色合成・図解と字幕の重ね方)は
 * chunk-filter.ts の buildChunkArgs を両方が使う(2026-09-23 C5。以前はここに複製があり、
 * skipHeadFrames・紙色合成・図解がプレビューにだけ欠けていた)。区間20本ずつの分割・
 * 中間ファイルの再利用判定(尺が読めるか)・音の検査は assemble.ts から import して使う。
 * ここでプレビュー用に軽くすると「プレビューでは出なかったズレが本番で出る」ので、
 * **見た目を本番と一致させることがこの道具の存在理由**になる。
 *
 * **恒等式は全カットで作ってから章で絞る。** buildSegments は
 * offsetFrames === Math.round(startSec * fps) を全カットの積み上げで検証しており、
 * 章のカットだけを渡すと先頭が 0 から積み上がって章の途中から始まる章では必ず落ちる。
 * 章の先頭フレーム(base)は絞ったあとの先頭 segment から取る。字幕窓も音の切り出しも
 * この base を基準にする。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { percentile, windowRmsDb } from "../check-audio";
import { OUT_FPS, ROOT, clipsDir, epBase } from "./config";
import {
  CHUNK,
  type MasterAudioFacts,
  type PartCacheClip,
  type Segment,
  ambientPath,
  ambientProblems,
  assertUniformFps,
  buildSegments,
  checkMasterAudio,
  durationOf,
  holdSlowShortfalls,
  isUsable,
  maxVolumeDb,
  overlayWindows,
  subsByLine,
  partCacheSpec,
  probeClip,
  runFfmpeg,
  sourceFrames,
} from "./assemble";
import { buildChunkArgs, effectiveSourceFrames, isSynthCard } from "./chunk-filter";
import { figureOverlaysForChunk } from "./figures";
import type { FigureIndex } from "./figures";
import { formatFreshness, loadEpisodeFreshness, readSubsLedger } from "./freshness";
import type { FreshnessResult, Inputs } from "./freshness";
import type { TimingLine } from "./plan";
import type { Chapter, CutsFile } from "./types";

export interface PreviewOptions {
  epId: string;
  chapterId: string;
  /** review/<epId>/ 直下のファイル名。パスは受け取らない */
  outName: string;
}

export function parseArgs(argv: string[]): PreviewOptions {
  const positional: string[] = [];
  let outName = "";
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") {
      outName = argv[i + 1] ?? "";
      i += 1;
    } else if (!a.startsWith("--")) {
      positional.push(a);
    } else {
      throw new Error("知らない引数です: " + a);
    }
  }
  if (positional.length > 2) {
    throw new Error("章は1つだけ指定してください(余分な引数: " + positional.slice(2).join(", ") + ")");
  }
  const [epId, chapterId] = positional;
  if (!epId || !chapterId) throw new Error("使い方: npm run h3:preview -- <epId> <章ID> [--out <名前.mp4>]");
  if (!outName) outName = chapterId + "-preview.mp4";
  if (outName !== basename(outName) || outName.startsWith(".")) {
    throw new Error("--out はファイル名だけで指定してください(review/<epId>/ の外へは書きません): " + outName);
  }
  return { epId, chapterId, outName };
}

/** 章IDから章を引く。打ち間違いを黙って0本にせず、候補を並べて止める */
export function findChapter(chapters: Chapter[], chapterId: string): Chapter {
  const hit = chapters.find((c) => c.id === chapterId);
  if (!hit) throw new Error("章 " + chapterId + " がありません。ある章: " + chapters.map((c) => c.id).join(", "));
  return hit;
}

export interface ChapterSlice {
  /** 時刻順に並べた章のカット */
  segments: Segment[];
  /** 章の先頭フレーム(完成品の先頭から数えた絶対位置)。字幕窓と音の切り出しの基準 */
  base: number;
  /** 章のフレーム数の合計 */
  frames: number;
}

/**
 * 全カットの segments から章のぶんだけ切り出す。
 * 章のカットが時間軸で連続していなければ、飛んだぶんだけ音と絵がずれるのでその場で止める
 * (章の宣言が cuts.json の並びと食い違っているときにだけ起きる)。
 */
export function chapterSlice(segments: Segment[], chapter: Chapter): ChapterSlice {
  const byId = new Map(segments.map((s) => [s.clipId, s]));
  const unknown = chapter.cuts.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(chapter.id + " のカットが cuts.json にありません: " + unknown.join(", "));
  }
  const picked = chapter.cuts.map((id) => byId.get(id) as Segment).sort((a, b) => a.offsetFrames - b.offsetFrames);
  if (picked.length === 0) throw new Error(chapter.id + " にカットが1本もありません");
  for (let i = 1; i < picked.length; i += 1) {
    const end = picked[i - 1].offsetFrames + picked[i - 1].frames;
    if (picked[i].offsetFrames !== end) {
      throw new Error(
        picked[i].clipId + " で章の区間が飛んでいます(前のカットの終わり " + end + "F / このカットの先頭 "
          + picked[i].offsetFrames + "F)。" + chapter.id + " のカット割りが連続していません",
      );
    }
  }
  return {
    segments: picked,
    base: picked[0].offsetFrames,
    frames: picked.reduce((n, s) => n + s.frames, 0),
  };
}

/** master.mp3 から章の区間だけを切り出して先頭へ寄せるフィルタ */
export function audioTrimFilter(base: number, frames: number, fps: number): string {
  return "atrim=start=" + (base / fps).toFixed(6) + ":end=" + ((base + frames) / fps).toFixed(6)
    + ",asetpts=N/SR/TB";
}

/**
 * 素材の欠けを列挙する。**見るのは渡された章のぶんだけ**で、
 * まだ生成していない他章のせいでプレビューが焼けなくならないようにする。
 */
export function missingMaterials(
  segments: Segment[],
  hasClip: (clipId: string) => boolean,
  hasSub: (lineId: string) => boolean,
): { clips: string[]; subs: string[] } {
  return {
    // 章カードは生成クリップを使わず紙色で合成する(assemble と同じ)。クリップを要求しない
    clips: segments.filter((s) => !isSynthCard(s)).map((s) => s.clipId).filter((id) => !hasClip(id)),
    // noSub のカットは字幕を敷かない(画面内に文字を持つカット)。字幕PNG も要求しない
    subs: segments.filter((s) => !s.noSub).flatMap((s) => s.lineIds).filter((id) => !hasSub(id)),
  };
}

/**
 * 鮮度の結果をプレビュー用に分ける。**図解の古さは止めずに「図解なしで焼く」**(章の検品は図解より先に
 * 行うことが多く、そこで h3:figures を強いると工程が詰まる)。字幕台帳と audio-cues の古さは
 * 見た目・音を取り違えるので本番と同じく止める。
 */
export function splitPreviewFreshness(r: FreshnessResult): { blocking: FreshnessResult; figuresStale: boolean } {
  const isFig = (n: string): boolean => n === "figures/index.json";
  return {
    blocking: { stale: r.stale.filter((x) => !isFig(x.name)), legacy: r.legacy },
    figuresStale: r.stale.some((x) => isFig(x.name)),
  };
}

// ───────────────────────── ここから CLI(import では走らない) ─────────────────────────

function main(): void {
  let opts: PreviewOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error("❌ " + (e as Error).message);
    process.exit(2);
  }
  const { epId, chapterId, outName } = opts;

  const timingPath = join(ROOT, "episodes", epId, "timing.json");
  const cutsPath = join(ROOT, "h3/episodes", epId, "cuts.json");
  const subsDir = join(ROOT, "h3/episodes", epId, "subs");
  const masterPath = join(ROOT, "episodes", epId, "narration", "master.mp3");
  for (const [what, p] of [["timing.json", timingPath], ["cuts.json", cutsPath], ["master.mp3", masterPath]]) {
    if (!existsSync(p)) {
      console.error("❌ " + what + " がありません: " + p);
      process.exit(1);
    }
  }

  const timing = JSON.parse(readFileSync(timingPath, "utf8")) as { totalDurationSec: number; lines: TimingLine[] };
  const cutsFile = JSON.parse(readFileSync(cutsPath, "utf8")) as CutsFile;
  const lineById = new Map(timing.lines.map((l) => [l.lineId, l]));

  let slice: ChapterSlice;
  try {
    // 恒等式は全カットで作る。章だけを渡すと途中から始まる章が必ず落ちる
    const all = buildSegments(cutsFile.cuts, timing.lines, timing.totalDurationSec, OUT_FPS);
    slice = chapterSlice(all, findChapter(cutsFile.chapters, chapterId));
  } catch (e) {
    console.error("❌ " + (e as Error).message);
    process.exit(1);
  }
  const { segments, base, frames } = slice;

  const clipPath = (s: Segment): string => join(clipsDir(epId), s.clipId + ".mp4");
  const subPath = (o: { lineId: string; png?: string }): string => o.png ?? join(subsDir, "sub_" + o.lineId + ".png");
  const ledgerPath = join(subsDir, "subs.json");
  const ledger = existsSync(ledgerPath)
    ? subsByLine(readSubsLedger(JSON.parse(readFileSync(ledgerPath, "utf8"))).entries)
    : undefined;
  // 伸縮・不足判定は assemble と同じく「skipHeadFrames を捨てた残り」で行う。章カードは合成
  const srcFrames = (s: Segment): number => (isSynthCard(s) ? s.frames : effectiveSourceFrames(s, sourceFrames(clipPath(s))));
  const srcMtime = (s: Segment): number => (isSynthCard(s) ? 0 : statSync(clipPath(s)).mtimeMs);
  const partClip = (s: Segment): PartCacheClip => ({
    id: s.clipId, frames: s.frames, src: srcFrames(s), holdSlow: s.holdSlow,
    ...(s.skipHeadFrames > 0 ? { skipHeadFrames: s.skipHeadFrames } : {}),
    mtimeMs: srcMtime(s),
  });

  console.log(chapterId + ": カット " + segments.length + "本 / " + frames + "F("
    + (frames / OUT_FPS).toFixed(2) + "秒)/ 本編の " + (base / OUT_FPS).toFixed(2)
    + "秒 〜 " + ((base + frames) / OUT_FPS).toFixed(2) + "秒");

  const missing = missingMaterials(
    segments,
    (id) => existsSync(join(clipsDir(epId), id + ".mp4")),
    (id) => overlayWindows({ clipId: "", lineIds: [id], startSec: 0, frames: 0, offsetFrames: 0, holdSlow: false, skipHeadFrames: 0, noSub: false }, lineById, 0, OUT_FPS, ledger).every((o) => existsSync(subPath(o))),
  );
  if (missing.clips.length > 0) {
    console.error("❌ この章の素材が足りません: " + missing.clips.length + "本(まだ生成されていないカット)");
    console.error("   " + missing.clips.join(", "));
    process.exit(1);
  }
  if (missing.subs.length > 0) {
    console.error("❌ この章の字幕PNGが足りません: " + missing.subs.length + "枚(" + missing.subs.slice(0, 10).join(", ") + ")");
    console.error("   先に: python3 src/pipeline/h3/render-subs.py " + epId);
    process.exit(1);
  }

  try {
    assertUniformFps(segments.filter((s) => !isSynthCard(s)).map((s) => ({ clipId: s.clipId, fps: probeClip(clipPath(s)).fps })), OUT_FPS);
  } catch (e) {
    console.error("❌ " + (e as Error).message);
    process.exit(1);
  }

  const slow = segments
    .map((s) => ({ s, ratio: s.frames / srcFrames(s) }))
    .filter((x) => x.ratio > 1);
  if (slow.length > 0) {
    // holdSlow でない限り、この不足は setpts が引き伸ばしてスロー再生で吸収する(実害は見た目だけ)。
    // holdSlow のクリップは下の holdSlowShortfalls が別に検出し、そちらは異常終了させる
    console.log("⚠️ 生成尺が足りず setpts で引き伸ばされる(スロー再生になる)クリップ: " + slow.length + "件"
      + "(holdSlow のカットはここに出ません。素材不足なら焼く前に異常終了します)");
    for (const x of slow) {
      console.log("   " + x.s.clipId + " 目標 " + x.s.frames + "F / 素材 " + srcFrames(x.s)
        + "F → ×" + x.ratio.toFixed(4));
    }
  }

  // holdSlow は伸縮の受け皿(setpts)を持たない。素材フレームが足りなければ trim が黙って
  // 欠損させるだけなので、焼く前にここで止める(assemble.ts と同じ砦。指摘1)
  {
    const clips: PartCacheClip[] = segments.map((s) => partClip(s));
    const shortfalls = holdSlowShortfalls(clips);
    if (shortfalls.length > 0) {
      console.error("❌ holdSlow のカットで素材フレームが目標に届きません(焼くと欠損したまま完走します): "
        + shortfalls.length + "件");
      for (const x of shortfalls) {
        console.error("   " + x.id + " 目標 " + x.frames + "F / 素材 " + x.src + "F(不足 " + (x.frames - x.src) + "F)");
      }
      console.error("   trim=end_frame は超過分を黙って無視するだけでエラーになりません。"
        + "cuts.json の seconds を伸ばすか、holdSlow を外してください");
      process.exit(1);
    }
  }

  /* 音の検査は assemble.ts と同じものを流用する。
     プレビューで古い master.mp3 を聞いて「音は問題ない」と判断されるのを防ぐ */
  {
    const cuesPath = join(ROOT, "episodes", epId, "audio-cues.json");
    const facts: MasterAudioFacts = {
      p10WindowDb: percentile(windowRmsDb(masterPath), 0.1),
      masterMtimeMs: statSync(masterPath).mtimeMs,
      cuesMtimeMs: existsSync(cuesPath) ? statSync(cuesPath).mtimeMs : 0,
    };
    const problems = checkMasterAudio(facts);
    console.log("master.mp3 の音の床(p10): " + facts.p10WindowDb.toFixed(1) + "dB"
      + (problems.length === 0 ? "(検査OK)" : ""));
    for (const m of problems) console.error("❌ " + m);
    if (problems.length > 0) process.exit(1);
  }

  /* 入力ハッシュの鮮度(assemble と同じ C1)。字幕・音の古さは止め、図解の古さは図解なしで焼く */
  const fresh = splitPreviewFreshness(loadEpisodeFreshness(ROOT, epId));
  {
    const fr = formatFreshness(fresh.blocking);
    for (const w of fr.warnings) console.log("⚠️ " + w);
    if (fr.errors.length > 0) {
      for (const m of fr.errors) console.error("❌ " + m);
      process.exit(2);
    }
  }

  /* 図解・章カードの板(h3:figures の出力)。あれば本番と同じく重ねる。無い・古いときは重ねずに焼く
     (章カードの下地は紙色で合成するので、板が無ければ紙色の無地になる) */
  let figEntries: FigureIndex["entries"] = [];
  {
    const figIndexPath = join(ROOT, "h3/episodes", epId, "figures", "index.json");
    const figDeclPath = join(ROOT, "h3/episodes", epId, "figures.json");
    if (existsSync(figDeclPath) && existsSync(figIndexPath)) {
      const idx = JSON.parse(readFileSync(figIndexPath, "utf8")) as FigureIndex & { inputs?: Inputs };
      const legacyStale = idx.inputs === undefined && statSync(figIndexPath).mtimeMs < statSync(figDeclPath).mtimeMs;
      const incomplete = idx.entries.some((e) =>
        !existsSync(join(e.dir, "f00000.png")) || !existsSync(join(e.dir, "f" + String(e.frames - 1).padStart(5, "0") + ".png")));
      if (fresh.figuresStale || legacyStale || idx.fps !== OUT_FPS || incomplete) {
        console.log("⚠️ 図解(figures/index.json)が古いか欠けているので、図解・章カードの板を重ねずに焼きます。"
          + "本番と同じ見た目で見るなら先に: npm run h3:figures -- " + epId);
      } else {
        figEntries = idx.entries;
      }
    } else {
      console.log("図解: figures/index.json が無いので重ねません(章カードは紙色の無地になります)");
    }
  }

  // 章ごとに1階層で作る(入れ子にすると rmSync が末端しか消せず、空の親が残る)
  const parts = join(epBase(epId), "preview-parts-" + chapterId);
  mkdirSync(parts, { recursive: true });

  const chunks: Segment[][] = [];
  for (let i = 0; i < segments.length; i += CHUNK) chunks.push(segments.slice(i, i + CHUNK));

  const partFiles: string[] = [];
  chunks.forEach((chunk, ci) => {
    const chunkBase = chunk[0].offsetFrames;
    const overlays = chunk.flatMap((s) => overlayWindows(s, lineById, chunkBase, OUT_FPS, ledger));
    const chunkFrames = chunk.reduce((a, s) => a + s.frames, 0);
    const figs = figureOverlaysForChunk(figEntries, chunkBase, chunkFrames, OUT_FPS)
      .map((f) => ({ ...f, mtimeMs: statSync(join(f.dir, "f" + String(f.startNumber).padStart(5, "0") + ".png")).mtimeMs }));

    const spec = partCacheSpec(chunkBase, chunk.map((s) => partClip(s)), overlays, figs);
    const tag = createHash("sha1").update(spec).digest("hex").slice(0, 8);
    const dest = join(parts, "part" + String(ci).padStart(3, "0") + "-" + tag + ".mp4");
    partFiles.push(dest);
    if (isUsable(dest)) {
      console.log("  区間 " + (ci + 1) + "/" + chunks.length + "(焼き済みを再利用)");
      return;
    }

    const args = buildChunkArgs({
      chunk, overlays, figs, fps: OUT_FPS, clipPath, subPath,
      rawSourceFrames: (s) => sourceFrames(clipPath(s)), dest,
    });
    const t0 = Date.now();
    runFfmpeg(args);
    console.log("  区間 " + (ci + 1) + "/" + chunks.length + "(" + ((Date.now() - t0) / 1000).toFixed(1) + "秒)");
  });

  const listPath = join(parts, "list.txt");
  writeFileSync(listPath, partFiles.map((p) => "file '" + p + "'").join("\n") + "\n");
  const silent = join(parts, "video-subbed.mp4");
  runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", silent]);

  const outDir = join(ROOT, "review", epId);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, outName);
  // プレビューと本番の音が食い違うと章ごとの人間判断が成立しない。ambient.wav にも
  // master.mp3 と同じ audioTrimFilter を当てて章の区間だけを切り出してから混ぜる
  const ambientWav = ambientPath(epId);
  const hasAmbient = existsSync(ambientWav);
  if (hasAmbient) {
    // ambient.wav の鮮度・尺を検査する(assemble.ts と同じ砦。入力記録があればクリップの差し替えも見る。C2)。
    // プレビューで古い ambient.wav を聴いて「音は問題ない」と判断されるのを防ぐ
    const all = buildSegments(cutsFile.cuts, timing.lines, timing.totalDurationSec, OUT_FPS);
    const problems = ambientProblems(epId, all, clipPath, timing.totalDurationSec, timingPath, cutsPath);
    if (problems.length > 0) {
      for (const m of problems) console.error("❌ " + m);
      process.exit(1);
    }
    console.log("環境音: ambient.wav を敷きます(検査OK)");
  } else {
    console.log("環境音: ambient.wav が無いので敷きません");
  }
  const trim = audioTrimFilter(base, frames, OUT_FPS);
  runFfmpeg(hasAmbient
    ? ["-y", "-i", silent, "-i", masterPath, "-i", ambientWav,
       "-filter_complex",
       "[1:a]" + trim + "[m];[2:a]" + trim + "[b];[m][b]amix=inputs=2:duration=first:normalize=0[a]",
       "-map", "0:v", "-map", "[a]",
       "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", outPath]
    : ["-y", "-i", silent, "-i", masterPath,
       "-filter_complex", "[1:a]" + trim + "[a]",
       "-map", "0:v", "-map", "[a]",
       "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", outPath]);
  // 中間ファイルは残さない(ディスクの空きが十数GBしかない)
  rmSync(parts, { recursive: true, force: true });

  const got = durationOf(outPath);
  console.log("できました: " + outPath + "(" + got.toFixed(2) + "秒 / 章の区間 "
    + (frames / OUT_FPS).toFixed(2) + "秒)");
  if (Math.abs(got - frames / OUT_FPS) > 0.5) console.log("⚠️ 尺がずれています");

  // 指摘4: §5.2.5「プレビューと本番の一致」の対象。本番と同じ検査をプレビューにも掛ける
  try {
    const maxDb = maxVolumeDb(outPath);
    console.log("音量ピーク(max_volume): " + maxDb.toFixed(1) + "dB");
    if (maxDb > -1.0) {
      console.log("⚠️ 音量ピークが -1.0dBFS を超えています(" + maxDb.toFixed(1)
        + "dB)。ambient.json の gainDb を下げることを検討してください");
    }
  } catch (e) {
    console.log("⚠️ 音量ピークを測れませんでした: " + (e as Error).message);
  }
}

if (process.argv[1] && basename(process.argv[1]) === "preview-chapter.ts") main();
