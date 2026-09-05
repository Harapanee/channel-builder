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
}

/** 既定の敷き量。ep016 を聴いて決めた値(2026-08-24) */
export const DEFAULT_AMBIENT = { gainDb: -18 };

export interface AmbientPiece {
  /** null なら無音で埋める */
  clipId: string | null;
  frames: number;
  gainDb: number;
}

export function resolveAmbientConfig(raw: {
  gainDb?: number;
  exclude?: string[];
  perClip?: Record<string, { gainDb: number }>;
} | undefined): AmbientConfig {
  return {
    gainDb: raw?.gainDb ?? DEFAULT_AMBIENT.gainDb,
    exclude: new Set(raw?.exclude ?? []),
    perClip: raw?.perClip ?? {},
  };
}

/**
 * 区間を音の断片へ写す。**区間はタイムラインを隙間なく覆っている**(buildSegments が
 * 恒等式を検査している)ので、順に連結するだけで総尺に一致する。
 */
export function ambientPlan(segments: Segment[], config: AmbientConfig): AmbientPiece[] {
  return segments.map((s) => ({
    clipId: config.exclude.has(s.clipId) ? null : s.clipId,
    frames: s.frames,
    gainDb: config.perClip[s.clipId]?.gainDb ?? config.gainDb,
  }));
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
