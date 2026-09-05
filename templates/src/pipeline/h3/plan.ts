/**
 * timing.json → 束ね候補。
 *
 * **尺の基準はタイムライン区間である。** 台本行の endSec と次の行の startSec の間には
 * 無音がある(ep015 実測: 302箇所すべてに 0.35〜0.70秒)。発話区間の合計で尺を決めると
 * Σ(endSec - startSec) = 844.89秒 に対し総尺 974.94秒 で、130.05秒短い動画になる。
 *
 * 1台本行=1クリップだと 5.167秒(124フレーム)未満の区間が学習レンジを外れるうえ、
 * 必要尺の何倍もの映像を生成して早回しで圧縮することになる。短い行を隣とまとめると
 * 生成本数と GPU 時間が下がる。ただし「まとめてよいか」は意味判断なので planner が決め、
 * ここは候補と数値を出すだけにする。
 */
import { FPS, TRAINED_MIN_FRAMES, framesForSeconds, secondsForFrames } from "./frames";
import type { Cut } from "./types";

export const MIN_CLIP_SEC = secondsForFrames(TRAINED_MIN_FRAMES);
/** 束ねる上限。これを超えると1カット1被写体の原則が守れない */
export const MAX_MERGE = 3;

export interface TimingLine {
  lineId: string;
  text: string;
  startSec: number;
  endSec: number;
}

export interface MergeCandidate {
  lineIds: string[];
  /** タイムライン上で受け持つ長さ。組み立ての目標尺になる */
  spanSeconds: number;
  /** 生成する尺。spanSeconds 以上・MIN_CLIP_SEC 以上(早回しで縮めるため) */
  seconds: number;
  /** 17k+5 グリッドのフレーム数。グリッド外(上限超え)は -1 */
  frames: number;
  texts: string[];
}

/** lines[from] の開始から lines[to] の次の行の開始まで(最終行は総尺まで) */
export function spanSeconds(lines: TimingLine[], from: number, to: number, totalDurationSec: number): number {
  const stop = to + 1 < lines.length ? lines[to + 1].startSec : totalDurationSec;
  return stop - lines[from].startSec;
}

function gridFrames(seconds: number): number {
  try {
    return framesForSeconds(seconds);
  } catch {
    return -1;
  }
}

export function planMergeCandidates(
  lines: TimingLine[],
  totalDurationSec: number,
  opts: { boundaries?: string[] } = {},
): MergeCandidate[] {
  const boundaries = new Set(opts.boundaries ?? []);
  const out: MergeCandidate[] = [];
  let i = 0;
  while (i < lines.length) {
    let last = i;
    while (
      spanSeconds(lines, i, last, totalDurationSec) < MIN_CLIP_SEC &&
      last - i + 1 < MAX_MERGE &&
      last + 1 < lines.length &&
      !boundaries.has(lines[last + 1].lineId) &&
      // 次の行が単独で下限を満たすなら、そちらは束ねずに独立したカットへ残す
      spanSeconds(lines, last + 1, last + 1, totalDurationSec) < MIN_CLIP_SEC
    ) {
      last += 1;
    }
    const span = spanSeconds(lines, i, last, totalDurationSec);
    // 生成尺は区間以上・下限以上。0.1秒単位へ切り上げる(v2 と同じ)
    const seconds = Math.max(MIN_CLIP_SEC, Math.ceil(span * 10) / 10);
    out.push({
      lineIds: lines.slice(i, last + 1).map((l) => l.lineId),
      spanSeconds: span,
      seconds,
      frames: gridFrames(seconds),
      texts: lines.slice(i, last + 1).map((l) => l.text),
    });
    i = last + 1;
  }
  return out;
}

/**
 * 早回しが「不自然に速い」と見なす倍率。
 * ep016 実測では 1.4 以上が 70/248 本(28%)あり、最大 2.61 倍だった。
 * **生成音は映像と同時生成なので、この倍率でそのまま音を使うと破綻する。**
 */
export const SPEEDUP_ADVISE = 1.4;

export interface SpeedupRow {
  cutId: string;
  /** タイムライン上で受け持つ長さ */
  spanSeconds: number;
  /** 実際に焼かれる長さ(17k+5 グリッドに乗せたあと) */
  generatedSeconds: number;
  /** generatedSeconds / spanSeconds。1 を超えるぶんが早回し */
  ratio: number;
}

/**
 * 各カットの早回し倍率。**宣言の seconds ではなくグリッドに乗せたフレーム数で測る**
 * (宣言 5.0 秒でも実際に焼かれるのは 124F = 5.167 秒)。
 */
export function speedupRatios(
  cuts: Record<string, Cut>,
  lines: TimingLine[],
  totalDurationSec: number,
): SpeedupRow[] {
  const indexOf = new Map(lines.map((l, i) => [l.lineId, i]));
  const at = (cutId: string, lineId: string): number => {
    const i = indexOf.get(lineId);
    if (i === undefined) throw new Error(cutId + ": timing.json に " + lineId + " がありません");
    return i;
  };
  return Object.entries(cuts).map(([cutId, cut]) => {
    const from = at(cutId, cut.lineIds[0]);
    const to = at(cutId, cut.lineIds[cut.lineIds.length - 1]);
    const span = spanSeconds(lines, from, to, totalDurationSec);
    const generated = framesForSeconds(cut.seconds) / FPS;
    return { cutId, spanSeconds: span, generatedSeconds: generated, ratio: generated / span };
  });
}
