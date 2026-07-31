/**
 * 空フレーム検出(HF経路のレンダー後QA)。
 *
 * なぜ必要か:
 *   ep012-octopus の cL53 は「紙地しか描かれていないclip」を 3.6秒ぶん出力したが、
 *   `npm run check`(lint/runtime/layout/motion/contrast)も既存QAも1つも赤にならず、
 *   レンダー・承認・コミットまで通った。どのゲートも「絵が出ているか」を見ていなかった。
 *   原因は clip 内の生成順(paper() が world より後に来て紙地が全面を覆った)で、
 *   コードとしては正常に走るため静的検査では捕まらない。**出力を見る**検査でしか
 *   止められない種類の事故である。
 *
 * 指標に輝度の標準偏差を使う理由(ep012 実測で較正):
 *   最初は「最頻色が画面に占める割合」で測ったが、指標として逆だった —
 *   壊れたフレームは紙地+水の層+grain の微細なムラで最頻色が割れて 59%、
 *   意図的な図解カット(紙地に小さな記号だけ)は逆に純粋な紙地なので 98% になる。
 *   輝度の標準偏差なら、直接レンダーした実測で
 *     壊れた cL53 = 0.7 / 意図的な最小構成カット(cL94・cL207・cL213)= 2.8〜5.4 /
 *     通常カット = 11〜45
 *   と分離する。閾値 1.5 は両側に約2倍の余裕がある。
 *   ※「単色かどうか」ではなく「**何も描かれていないか**」を見る検査である。
 *   紙地に記号1つの図解は正しく通る(チャンネルの画風を殺さない)。
 *
 * 使い方:
 *   npx tsx src/pipeline/qa-flat-frames.ts episodes/<epId> [out名]
 *
 * exit: 0 = OK / 1 = 空clipあり / 2 = 実行エラー
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/** 字幕帯は常に同じ見た目なので測定から外す(下 18% = review-checklist の字幕ゾーン) */
export const SUBTITLE_ZONE_TOP = 0.82;
/** 輝度の標準偏差がこの値未満のフレームを「何も描かれていない」とみなす(実測較正値) */
export const BLANK_STD_THRESHOLD = 1.5;
/** clip の標本のうち空フレームがこの割合以上ならそのclipを指摘する */
export const BLANK_CLIP_COVERAGE = 0.6;
/**
 * 指摘に必要な最低標本数。
 * 0.5秒間隔なので尺1秒未満のclipは標本1つになり、白フェードの途中に当たっただけで
 * 100%空と判定され得る。実際に捕まえたい事故(ep012 cL53)は3.6秒=7標本なので、
 * 2標本を下限にしても検出力は落ちない。
 */
export const MIN_BLANK_SAMPLES = 2;
/** サンプリング間隔(秒) */
export const SAMPLE_INTERVAL_SEC = 0.5;
/** 解析解像度(字幕帯を落とした 1920x886 を縮めた比率) */
export const SAMPLE_W = 128;
export const SAMPLE_H = 59;

export interface ClipSpan {
  id: string;
  startSec: number;
  durationSec: number;
}

export interface FrameSample {
  timeSec: number;
  /** 字幕帯を除いた領域の輝度の標準偏差。0 に近いほど「何も描かれていない」 */
  lumaStd: number;
}

export interface BlankFinding {
  clipId: string;
  startSec: number;
  durationSec: number;
  /** 空と判定された標本の数 / そのclipの標本総数 */
  blankSamples: number;
  totalSamples: number;
  /** そのclipの標本の標準偏差の最大値(いちばん絵があった瞬間でどれだけか) */
  bestLumaStd: number;
}

/**
 * clip 区間と標本から、空clipを求める(純粋関数 — I/Oを持たない)。
 * 標本が1つも無いclipは判定しない(尺がサンプリング間隔より短い場合)。
 */
export function findBlankClips(
  clips: ClipSpan[],
  samples: FrameSample[],
  opts: { stdThreshold?: number; coverage?: number } = {}
): BlankFinding[] {
  const stdThreshold = opts.stdThreshold ?? BLANK_STD_THRESHOLD;
  const coverage = opts.coverage ?? BLANK_CLIP_COVERAGE;
  const findings: BlankFinding[] = [];
  for (const clip of clips) {
    const end = clip.startSec + clip.durationSec;
    const mine = samples.filter((s) => s.timeSec >= clip.startSec && s.timeSec < end);
    if (mine.length === 0) continue;
    const blank = mine.filter((s) => s.lumaStd < stdThreshold);
    if (blank.length < MIN_BLANK_SAMPLES) continue;
    if (blank.length / mine.length < coverage) continue;
    findings.push({
      clipId: clip.id,
      startSec: clip.startSec,
      durationSec: clip.durationSec,
      blankSamples: blank.length,
      totalSamples: mine.length,
      bestLumaStd: Math.max(...mine.map((s) => s.lumaStd)),
    });
  }
  return findings;
}

/** グレースケール生フレーム1枚の輝度標準偏差(純粋関数) */
export function lumaStdOfFrame(gray: Uint8Array | Buffer): number {
  const n = gray.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += gray[i];
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (gray[i] - mean) ** 2;
  return Math.sqrt(v / n);
}

/** composition.html の clip 一覧(id / data-start / data-duration)を読む */
export function parseClipSpans(html: string): ClipSpan[] {
  const spans: ClipSpan[] = [];
  const re = /<section[^>]*class="clip[^"]*"[^>]*>/g;
  for (const m of html.match(re) ?? []) {
    const id = /\sid="([^"]+)"/.exec(m)?.[1];
    const start = /\sdata-start="([\d.]+)"/.exec(m)?.[1];
    const dur = /\sdata-duration="([\d.]+)"/.exec(m)?.[1];
    if (!id || start === undefined || dur === undefined) continue;
    spans.push({ id, startSec: Number(start), durationSec: Number(dur) });
  }
  return spans.sort((a, b) => a.startSec - b.startSec);
}

export function formatMmSs(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

/* ----------------------------- 以下 CLI(I/O) ----------------------------- */

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

/** mp4 を1パスで走査し、SAMPLE_INTERVAL_SEC ごとの標本を返す */
export function sampleVideo(mp4Path: string): FrameSample[] {
  const fps = 1 / SAMPLE_INTERVAL_SEC;
  const vf =
    `fps=${fps},crop=iw:ih*${SUBTITLE_ZONE_TOP}:0:0,scale=${SAMPLE_W}:${SAMPLE_H},format=gray`;
  const r = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", mp4Path, "-vf", vf, "-f", "rawvideo", "-"],
    { maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" }
  );
  if (r.error) fail(`ffmpeg の起動に失敗: ${r.error.message}`);
  if (r.status !== 0) fail(`ffmpeg が失敗: ${r.stderr?.toString().slice(0, 400)}`);
  const raw = r.stdout as Buffer;
  const frameBytes = SAMPLE_W * SAMPLE_H;
  const n = Math.floor(raw.length / frameBytes);
  const samples: FrameSample[] = [];
  for (let i = 0; i < n; i++) {
    samples.push({
      timeSec: i * SAMPLE_INTERVAL_SEC,
      lumaStd: lumaStdOfFrame(raw.subarray(i * frameBytes, (i + 1) * frameBytes)),
    });
  }
  return samples;
}

function main(): void {
  const epArg = process.argv[2];
  if (!epArg) fail("使い方: npx tsx src/pipeline/qa-flat-frames.ts episodes/<epId> [out名]");
  const epDir = path.resolve(process.cwd(), epArg);
  const outName = process.argv[3] ?? "final";
  const mp4 = path.join(epDir, "out", `${outName}.mp4`);
  const compositionPath = path.join(epDir, "composition.html");
  if (!existsSync(mp4)) fail(`mp4 がありません: ${mp4}`);
  if (!existsSync(compositionPath)) fail("composition.html がありません(HF経路専用の検査です)");

  const clips = parseClipSpans(readFileSync(compositionPath, "utf8"));
  if (clips.length === 0) fail("composition.html に clip がありません");
  const samples = sampleVideo(mp4);
  const findings = findBlankClips(clips, samples);

  console.log(
    `空フレーム検査: ${clips.length} clip / ${samples.length} 標本` +
      `(${SAMPLE_INTERVAL_SEC}秒毎・字幕帯を除外・輝度std < ${BLANK_STD_THRESHOLD} を空と判定)`
  );
  if (findings.length === 0) {
    console.log("OK: 何も描かれていないclipはありません");
    process.exit(0);
  }
  for (const f of findings) {
    console.error(
      `NG ${f.clipId} ${formatMmSs(f.startSec)}(${f.startSec.toFixed(2)}s / ${f.durationSec.toFixed(2)}s): ` +
        `標本 ${f.blankSamples}/${f.totalSamples} が空(最大でも輝度std ${f.bestLumaStd.toFixed(2)})`
    );
  }
  console.error(
    `\n${findings.length} clip に何も描かれていません。clip内の生成順(紙地 paper() が` +
      ` world より後に来て全面を覆っていないか)・素材の読み込み失敗・z-index を疑ってください。`
  );
  process.exit(1);
}

/* テストから import したときは走らせない(basename 完全一致でCLI起動だけを判定する) */
if (process.argv[1] && path.basename(process.argv[1]) === "qa-flat-frames.ts") main();
