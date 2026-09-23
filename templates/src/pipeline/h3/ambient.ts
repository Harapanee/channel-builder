/**
 * MiniMax H3 が映像と同時に生成した音を、環境音として敷くための計画(純粋関数のみ)。
 *
 * **音は映像の早回しに追従させない。** 早回しは最大2.61倍あり(ep016 実測)、
 * 同じ倍率で音を伸縮すると環境音として使えなくなる。区間ぶんを**原速で頭から**使う。
 * 映像と厳密には合わないが、羽音・水音・風のような音では問題にならない。
 *
 * 実行(ffmpeg)は build-ambient.ts が持つ。ここは計画だけを持つ。
 */
import type { Segment } from "./assemble";

export interface AmbientConfig {
  gainDb: number;
  exclude: ReadonlySet<string>;
  perClip: Record<string, { gainDb: number }>;
  /** noise floor(dBFS)がこれを超えるクリップを検出する。null で検査を切る。既定 -40 */
  noiseFloorMaxDb: number | null;
  /** 真なら検出したクリップを exclude へ足す(無音に置換)。既定は偽=報告のみ */
  autoExclude: boolean;
}

/** 既定の敷き量。ep016 を聴いて決めた値(2026-08-24)。noise floor の閾値は ep039 の実測から(2026-09-18) */
export const DEFAULT_AMBIENT = { gainDb: -18, noiseFloorMaxDb: -40 };

export interface AmbientPiece {
  /** null なら無音で埋める */
  clipId: string | null;
  frames: number;
  gainDb: number;
  /**
   * クリップの先頭から捨てるフレーム数(cuts.json の skipHeadFrames)。映像は assemble がこのぶんを捨てて
   * から区間へ収めるので、音も同じぶん捨ててから区間ぶんを頭から使う(2026-09-23 C4)。
   */
  skipHeadFrames: number;
}

export function resolveAmbientConfig(raw: {
  gainDb?: number;
  exclude?: string[];
  perClip?: Record<string, { gainDb: number }>;
  noiseFloorMaxDb?: number | null;
  autoExclude?: boolean;
} | undefined): AmbientConfig {
  return {
    gainDb: raw?.gainDb ?? DEFAULT_AMBIENT.gainDb,
    exclude: new Set(raw?.exclude ?? []),
    perClip: raw?.perClip ?? {},
    noiseFloorMaxDb: raw?.noiseFloorMaxDb === undefined ? DEFAULT_AMBIENT.noiseFloorMaxDb : raw.noiseFloorMaxDb,
    autoExclude: raw?.autoExclude ?? false,
  };
}

/**
 * 音を無音にする区間か。exclude に書いたカットに加え、**章カード(cuts.json の card)は自動で無音**
 * (2026-09-23 C3)。章カードは映像も紙色で合成して生成クリップを使わないので、音だけ使う理由が無い。
 * ep040〜045 は全話で exclude に章カードと同じ集合を手書きしていた(その書き方も引き続き有効)。
 */
function silenced(s: Segment, config: AmbientConfig): boolean {
  return Boolean(s.card) || config.exclude.has(s.clipId);
}

/**
 * 区間を音の断片へ写す。**区間はタイムラインを隙間なく覆っている**(buildSegments が
 * 恒等式を検査している)ので、順に連結するだけで総尺に一致する。
 */
export function ambientPlan(segments: Segment[], config: AmbientConfig): AmbientPiece[] {
  return segments.map((s) => ({
    clipId: silenced(s, config) ? null : s.clipId,
    frames: s.frames,
    gainDb: config.perClip[s.clipId]?.gainDb ?? config.gainDb,
    skipHeadFrames: Math.max(0, Math.floor(s.skipHeadFrames ?? 0)),
  }));
}

/** 音を使うクリップのID(章カードと exclude を除く・重複なし) */
export function ambientClipIds(segments: Segment[], config: AmbientConfig): string[] {
  return [...new Set(segments.filter((s) => !silenced(s, config)).map((s) => s.clipId))];
}

/**
 * 断片1つを wav にする ffmpeg 引数。**すべて同じ形式にそろえる**(concat demuxer が -c copy で繋げる条件)。
 * skipHeadFrames があれば入力側の -ss で頭を捨てる。apad + -t で「クリップが短い」場合も必ず区間ぶんの長さになる。
 */
export function ambientPieceArgs(p: AmbientPiece, clipPath: string, dest: string, fps: number, sampleRate: number): string[] {
  const seconds = (p.frames / fps).toFixed(6);
  if (p.clipId === null) {
    return ["-y", "-f", "lavfi", "-i", "anullsrc=r=" + sampleRate + ":cl=stereo", "-t", seconds, "-c:a", "pcm_s16le", dest];
  }
  const seek = p.skipHeadFrames > 0 ? ["-ss", (p.skipHeadFrames / fps).toFixed(6)] : [];
  return ["-y", ...seek, "-i", clipPath, "-vn",
    "-af", "aresample=" + sampleRate + ",apad,volume=" + p.gainDb + "dB",
    "-ac", "2", "-t", seconds, "-c:a", "pcm_s16le", dest];
}

/**
 * `exclude` / `perClip` のキーが `cuts.json` に実在することを検査する。
 *
 * `exclude` は「音が破綻しているカットを消す」ためだけの欄で、`ambientPlan` は
 * `config.exclude.has(s.clipId)` を素通りさせるだけの集合演算なので、**IDを1文字
 * 間違えても何も起きない**(素通りしてそのカットの音がそのまま乗るだけで、意図した
 * 除外は無言で不発になる)。JSON Schema の pattern も `cL025` と `cL25` を区別できない
 * (どちらも `^cL[0-9]+$` に一致する)。ここで cuts.json との突合まで見る。
 */
export function unknownAmbientKeys(config: AmbientConfig, cutIds: ReadonlySet<string>): string[] {
  const unknown = new Set<string>();
  for (const id of config.exclude) if (!cutIds.has(id)) unknown.add(id);
  for (const id of Object.keys(config.perClip)) if (!cutIds.has(id)) unknown.add(id);
  return [...unknown].sort();
}

/* ---- noise floor による検出(2026-09-18 channel-refine) ----
 *
 * H3 は「steady wind + continuous rustle」のような広帯域の持続音を重ねた文面を、時間変化のない
 * 広帯域ノイズ床として描く(ep039 cL23 / cL86 / cL115 / cL97 の実測)。文面側は check:h3 の A13 が
 * 生成前に拾うが、生成後の実物も測っておく。測定(ffmpeg astats)は build-ambient.ts が持ち、
 * ここは解析と判定だけを持つ。
 */

export interface NoisyClip {
  clipId: string;
  noiseFloorDb: number;
}

/** ffmpeg `-af astats` の stderr から Overall の Noise floor(dBFS)を読む。無ければ null */
export function parseNoiseFloorDb(stderr: string): number | null {
  const overall = stderr.split(/Overall/)[1] ?? "";
  const m = overall.match(/Noise floor dB:\s*(-?[0-9.]+)/);
  return m ? Number(m[1]) : null;
}

/** 閾値を**超えた**クリップだけを、うるさい順(noise floor の高い順)に返す */
export function flagNoisyClips(noiseFloors: Record<string, number>, thresholdDb: number): NoisyClip[] {
  return Object.entries(noiseFloors)
    .filter(([, db]) => db > thresholdDb)
    .map(([clipId, noiseFloorDb]) => ({ clipId, noiseFloorDb }))
    .sort((a, b) => b.noiseFloorDb - a.noiseFloorDb);
}

/** autoExclude が真のときだけ、検出したクリップを exclude へ足した新しい設定を返す(元は書き換えない) */
export function applyNoiseExclusion(config: AmbientConfig, flagged: NoisyClip[]): AmbientConfig {
  if (!config.autoExclude || flagged.length === 0) return config;
  return { ...config, exclude: new Set([...config.exclude, ...flagged.map((f) => f.clipId)]) };
}
