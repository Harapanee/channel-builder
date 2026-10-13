/**
 * 英語版の音の ffmpeg 引数(純粋関数)。BGM/SE の混ぜ方は audio-mix.ts の buildMixArgs をそのまま使い、
 * ここは「行の配置」と「環境音を敷いて尺に合わせる最終段」だけを持つ。
 */
import { LIMITER_CEILING_LINEAR } from "../audio-mix";

/** 日本語ナレーション(VOICEVOX)の実測ラウドネス。ep064 narration.wav = -14.7 LUFS(2026-10-12) */
export const TARGET_NARRATION_LUFS = -14.7;

export function buildPlacementArgs(pieces: { file: string; startSec: number }[], totalSec: number, outFile: string): string[] {
  const inputs = pieces.flatMap((p) => ["-i", p.file]);
  const chains = pieces.map((p, i) => {
    const ms = Math.max(0, Math.round(p.startSec * 1000));
    return `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[a${i}]`;
  });
  const labels = pieces.map((_, i) => `[a${i}]`).join("");
  const mix = `${labels}amix=inputs=${pieces.length}:normalize=0:dropout_transition=0,apad,` +
    `loudnorm=I=${TARGET_NARRATION_LUFS}:TP=-1.5:LRA=11[m]`;
  return ["-y", "-v", "error", ...inputs, "-filter_complex", [...chains, mix].join(";"),
    "-map", "[m]", "-t", totalSec.toFixed(3), "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", outFile];
}

export function buildFinalArgs(masterFile: string, ambientFile: string | null, totalSec: number, outFile: string): string[] {
  const tail = ["-t", totalSec.toFixed(3), "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", outFile];
  if (!ambientFile) return ["-y", "-v", "error", "-i", masterFile, "-af", "apad", ...tail];
  return ["-y", "-v", "error", "-i", masterFile, "-i", ambientFile,
    "-filter_complex", `[0:a][1:a]amix=inputs=2:duration=first:normalize=0,apad,alimiter=limit=${LIMITER_CEILING_LINEAR}:level=disabled[o]`,
    "-map", "[o]", ...tail];
}

/** Studio へは Claude in Chrome の file_upload(1回 10MB まで)で渡すので、MP3 を 9.5MB に収めるビットレート(上限 96k) */
export const STUDIO_MP3_MAX_BYTES = 9.5e6;
/** MPEG-1 Layer III(48kHz)の CBR 有効値。libmp3lame はこれ以外を切り上げるので、ここから切り下げて選ぶ */
const MP3_CBR_KBPS = [32, 40, 48, 56, 64, 80, 96];
export function mp3KbpsFor(durationSec: number): number {
  const limit = (STUDIO_MP3_MAX_BYTES * 8) / durationSec / 1000;
  return MP3_CBR_KBPS.filter((k) => k <= limit).at(-1) ?? MP3_CBR_KBPS[0];
}
