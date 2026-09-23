/**
 * assemble の素材確認(焼く前に止める)の純関数。2026-09-23 積み残し。
 *
 * - zeroByteFiles: 0バイトの生成物(クリップ・ff 画像・字幕PNG・図解PNG)。ep032 で cL06 が 0バイトのまま
 *   run-chapter を ✅ で通った(④)。生成側は B7(.tmp→rename・isUsable)で塞いだが、手で置いた・コピーに失敗した
 *   ファイルは assemble まで届くので、全素材が揃うこの時点でもう一度見る。
 * - headSkipShortfalls: skipHeadFrames を捨てた残りがカットの区間(frames)に届かないカット。
 *   早回し(setpts)が黙って引き伸ばすのでスロー再生になる(ep042 cL119=50 で ×1.24)。
 *   holdSlow は holdSlowShortfalls が別に止めるので対象外。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function zeroByteFiles(paths: string[]): string[] {
  return paths.filter((p) => existsSync(p) && statSync(p).isFile() && statSync(p).size === 0);
}

export function pngsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".png")).sort().map((f) => join(dir, f));
}

/**
 * skipHeadFrames による引き伸ばしの許容上限(区間 ÷ 残り)。これを超えたら止める。
 * 較正(2026-09-23・手元にクリップが残る ep043〜045): 残りが区間を割ったカットは14件で ×1.003〜1.063、
 * いずれも工程12の目視で合格している。止めたいのは ep042 cL119(skip 50 → ×1.24)・ep040 cL72(×1.147)の型。
 */
export const HEAD_SKIP_MAX_STRETCH = 1.1;

export interface HeadSkipShortfall {
  clipId: string;
  /** 区間のフレーム数 */
  frames: number;
  /** クリップの生フレーム数 */
  raw: number;
  skip: number;
  /** 捨てた後の残り */
  remain: number;
  /** 引き伸ばし率(区間 ÷ 残り) */
  stretch: number;
  /** 許容を超える(止める) */
  block: boolean;
}

export function headSkipShortfalls(
  segments: { clipId: string; frames: number; skipHeadFrames: number; holdSlow: boolean; card?: boolean }[],
  rawFramesOf: (clipId: string) => number,
  opts: { maxStretch?: number } = {},
): HeadSkipShortfall[] {
  const max = opts.maxStretch ?? HEAD_SKIP_MAX_STRETCH;
  const out: HeadSkipShortfall[] = [];
  for (const s of segments) {
    if (s.card || s.holdSlow || s.skipHeadFrames <= 0) continue;
    const raw = rawFramesOf(s.clipId);
    const remain = raw - s.skipHeadFrames;
    if (remain >= s.frames) continue;
    const stretch = remain > 0 ? s.frames / remain : Infinity;
    out.push({ clipId: s.clipId, frames: s.frames, raw, skip: s.skipHeadFrames, remain, stretch, block: stretch > max });
  }
  return out;
}
