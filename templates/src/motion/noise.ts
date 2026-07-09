/**
 * 決定論的なシード付き擬似乱数とノイズ。
 *
 * 方針(タスク「決定性」):
 * - `Math.random()` / `Date.now()` は使わない。
 * - すべての揺らぎは props / shotId から導出したシードと frame から計算する。
 * - 同じ (seed, index) / (seed, frame) は常に同じ値を返す(ステートレス)。
 *   → 同じフレームは常に同じ絵になる。
 */

/** FNV-1a 32bit ハッシュ。文字列をシード(uint32)へ変換する。 */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 複数の値(文字列・数値)からシードを合成する便利関数。 */
export function seedFrom(...parts: Array<string | number | boolean | undefined>): number {
  return hashString(parts.map((p) => String(p)).join("|"));
}

/** mulberry32 PRNG。seed から [0,1) の乱数列を返す関数を生成する。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * seed と index から決定論的に [0,1) を返す(ステートレスなハッシュ)。
 * PRNG のように状態を持ち回さずに、任意の index を直接引ける。
 */
export function seededUnit(seed: number, index = 0): number {
  let t = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** seed と index から [min,max) の決定論的な値。 */
export function seededRange(
  seed: number,
  index: number,
  min: number,
  max: number
): number {
  return min + seededUnit(seed, index) * (max - min);
}

/**
 * hz 回/秒で「段階的に」変化する [-1,1] のノイズ。
 * 手描きの boiling(線の揺らぎ)や shake のジッタに使う。
 * frame をステップに量子化し、各ステップで決定論的な値を返す。
 */
export function steppedNoise(
  seed: number,
  frame: number,
  fps: number,
  hz: number
): number {
  const framesPerStep = Math.max(1, Math.round(fps / hz));
  const step = Math.floor(frame / framesPerStep);
  return seededUnit(seed >>> 0, step) * 2 - 1;
}

/**
 * boiling / tremble 用の「現在のステップ番号」。
 * 手描き線のパスを ~hz 回/秒で描き直して揺らすときに、
 * この番号をパス生成のシードへ混ぜると線自体がコマ変わりで揺れる。
 */
export function boilStep(frame: number, fps: number, hz = 6): number {
  const framesPerStep = Math.max(1, Math.round(fps / hz));
  return Math.floor(frame / framesPerStep);
}
