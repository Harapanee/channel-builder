/**
 * Remotion 回(ep003〜ep008)の音を audio-cues の形へ起こす(純粋関数)。
 * 再現の元は src/remotion/Episode.tsx の BgmSegment(区間内ループ・曲替わりで1.5秒フェード+3秒無音・
 * 地続きの同一曲はフェードなし・最終区間は末尾フェードのみ)と、shot.startSec + sfx.atSec で鳴る SE。
 * buildMixArgs はループもフェードも持たないので、BGM は区間ごとに ffmpeg で先に「ベッド」を焼いて1キューで渡す。
 */
import type { AudioCue } from "../audio-mix";

const FADE_SEC = 1.5;
const GAP_SEC = 3;
const dbToVol = (db: number) => 10 ** (db / 20);

export interface BgmSeg {
  file: string;
  startSec: number;
  durSec: number;
  audibleSec: number;
  fadeSec: number;
  volume: number;
}

export function legacyBgmSegments(tracks: { file: string; startSec: number; endSec: number; gainDb: number }[]): BgmSeg[] {
  return tracks.map((t, i) => {
    const durSec = t.endSec - t.startSec;
    const next = tracks[i + 1];
    const contiguous = !!next && next.file === t.file && Math.abs(t.endSec - next.startSec) < 0.05;
    const gap = next && !contiguous ? Math.min(durSec, GAP_SEC) : 0;
    const fadeSec = contiguous ? 0 : Math.min(durSec - gap, FADE_SEC);
    return { file: `assets/${t.file}`, startSec: t.startSec, durSec, audibleSec: durSec - gap, fadeSec, volume: dbToVol(t.gainDb) };
  });
}

export function legacySeCues(shots: { startSec: number; sfx?: { cue: string; atSec: number; gainDb?: number }[] }[]): AudioCue[] {
  return shots.flatMap((s) =>
    (s.sfx ?? []).map((x) => ({
      src: `assets/audio/se/${x.cue}`,
      start: Math.round((s.startSec + x.atSec) * 1000) / 1000,
      volume: dbToVol(x.gainDb ?? -9),
    })),
  );
}

export function bedArgs(seg: BgmSeg, outFile: string): string[] {
  const fade = seg.fadeSec > 0 ? `,afade=t=out:st=${seg.audibleSec - seg.fadeSec}:d=${seg.fadeSec}` : "";
  return ["-y", "-v", "error", "-stream_loop", "-1", "-i", seg.file,
    "-af", `atrim=0:${seg.audibleSec}${fade},apad=whole_dur=${seg.durSec}`,
    "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", outFile];
}
