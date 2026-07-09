/**
 * motion ヘルパー(§7.6)。
 *
 * すべて純関数 `(frame, fps, params) => transform / style 値`。
 * React / DOM に依存せず、Remotion の `interpolate` / `spring` のみ使う。
 * 乱数は使わず、揺らぎは noise.ts のシード付き決定論ノイズから導出する。
 *
 * 返り値は「素の数値」(px, deg, 倍率, opacity)。CSS 文字列化は呼び出し側が行う。
 */
import { interpolate, spring, Easing, type InterpolateOptions } from "remotion";
import { seededUnit, steppedNoise } from "./noise";

export * from "./noise";

// ---- safeInterpolate: 縮退inputRangeで落ちない interpolate ----------------
/**
 * `interpolate` の安全版。inputRange が「厳密な単調増加」でない場合
 * (縮退 = 同値・逆転、および Infinity / NaN 混入、長さ不一致を含む)、
 * throw せずに outputRange の**末尾値**を返す。
 *
 * 背景: Remotion の `interpolate` は inputRange が単調増加でないと実行時に
 * throw し、tsc では検出できないままレンダー本番でクラッシュする
 * (ep006 で `Infinity` 混入により4回連続レンダー失敗の実測あり)。
 *
 * **使い方の規律**: inputRange に三項演算子で状態分岐を書かない
 * (例: `[start, cond ? start : end]` は縮退を生む)。状態によって定数を
 * 返したいときは interpolate の**外側**で分岐し、interpolate には常に
 * 単調増加のレンジだけを渡すこと。本関数はその規律が破れた場合の
 * 最後の安全網であり、縮退を書いてよい免罪符ではない。
 */
export function safeInterpolate(
  frame: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  opts?: InterpolateOptions
): number {
  const degenerate =
    inputRange.length < 2 ||
    inputRange.length !== outputRange.length ||
    inputRange.some((v) => !Number.isFinite(v)) ||
    outputRange.some((v) => !Number.isFinite(v)) ||
    inputRange.some((v, i) => i > 0 && v <= inputRange[i - 1]);
  if (degenerate) {
    return outputRange.length > 0 ? outputRange[outputRange.length - 1] : 0;
  }
  return interpolate(frame, inputRange, outputRange, opts);
}

// ---- popIn: バウンス出現 -------------------------------------------------
export type PopInParams = {
  delayFrames?: number;
  damping?: number;
  stiffness?: number;
  mass?: number;
};
export type PopInResult = { scale: number; opacity: number };

export function popIn(
  frame: number,
  fps: number,
  params: PopInParams = {}
): PopInResult {
  const { delayFrames = 0, damping = 11, stiffness = 150, mass = 0.7 } = params;
  const f = frame - delayFrames;
  if (f < 0) return { scale: 0, opacity: 0 };
  const scale = spring({ frame: f, fps, config: { damping, stiffness, mass } });
  const opacity = interpolate(f, [0, fps * 0.12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return { scale, opacity };
}

// ---- slideIn: 方向指定スライド出現 --------------------------------------
export type SlideDirection = "left" | "right" | "up" | "down";
export type SlideInParams = {
  direction: SlideDirection;
  distancePx?: number;
  delayFrames?: number;
  durationFrames?: number;
};
export type SlideInResult = { x: number; y: number; opacity: number };

export function slideIn(
  frame: number,
  fps: number,
  params: SlideInParams
): SlideInResult {
  const {
    direction,
    distancePx = 420,
    delayFrames = 0,
    durationFrames = 18,
  } = params;
  const f = frame - delayFrames;
  const t = interpolate(f, [0, durationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const off = (1 - t) * distancePx;
  let x = 0;
  let y = 0;
  if (direction === "left") x = -off;
  else if (direction === "right") x = off;
  else if (direction === "up") y = -off;
  else y = off;
  const opacity = interpolate(f, [0, durationFrames * 0.55], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return { x, y, opacity };
}

// ---- shake: 強度・減衰つき振動 ------------------------------------------
export type ShakeParams = {
  seed: number;
  intensityPx?: number;
  rotDeg?: number;
  hz?: number;
  /** 指定するとこのフレーム数で振動を 1→0 に減衰させる。省略で減衰なし。 */
  decayFrames?: number;
};
export type ShakeResult = { x: number; y: number; rotate: number };

export function shake(
  frame: number,
  fps: number,
  params: ShakeParams
): ShakeResult {
  const { seed, intensityPx = 12, rotDeg = 3, hz = 18, decayFrames } = params;
  const env =
    decayFrames && decayFrames > 0
      ? interpolate(frame, [0, decayFrames], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 1;
  const nx = steppedNoise(seed ^ 0x111, frame, fps, hz);
  const ny = steppedNoise(seed ^ 0x222, frame, fps, hz);
  const nr = steppedNoise(seed ^ 0x333, frame, fps, hz);
  return {
    x: nx * intensityPx * env,
    y: ny * intensityPx * env,
    rotate: nr * rotDeg * env,
  };
}

// ---- squash: 押し潰し(体積ほぼ保存) -----------------------------------
export type SquashParams = {
  atFrame?: number;
  amount?: number;
  durationFrames?: number;
};
export type SquashResult = { scaleX: number; scaleY: number };

export function squash(
  frame: number,
  _fps: number,
  params: SquashParams = {}
): SquashResult {
  const { atFrame = 0, amount = 0.3, durationFrames = 10 } = params;
  const f = frame - atFrame;
  if (f < 0 || f > durationFrames) return { scaleX: 1, scaleY: 1 };
  const s = Math.sin((f / durationFrames) * Math.PI); // 0 → 1 → 0
  const scaleY = 1 - amount * s;
  const scaleX = 1 + amount * s * 0.85; // 横に膨らませて体積を近似保存
  return { scaleX, scaleY };
}

// ---- bounceIdle: 待機の呼吸 ---------------------------------------------
export type BounceIdleParams = {
  amplitudePx?: number;
  periodSec?: number;
  seed?: number;
  breathPct?: number;
};
export type BounceIdleResult = { y: number; scaleX: number; scaleY: number };

export function bounceIdle(
  frame: number,
  fps: number,
  params: BounceIdleParams = {}
): BounceIdleResult {
  const { amplitudePx = 7, periodSec = 2.4, seed = 0, breathPct = 1.5 } = params;
  const phase = seededUnit(seed, 7) * Math.PI * 2;
  const w = (2 * Math.PI) / (periodSec * fps);
  const s = Math.sin(frame * w + phase);
  return {
    y: -s * amplitudePx,
    scaleY: 1 + (breathPct / 100) * s,
    scaleX: 1 - (breathPct / 100) * s * 0.6,
  };
}

// ---- fallImpact: 落下 → 着地潰れ → 復帰 --------------------------------
export type FallImpactParams = {
  startFrame?: number;
  fallDistancePx?: number;
  fallDurationFrames?: number;
  squashAmount?: number;
  recoverFrames?: number;
};
export type FallImpactResult = {
  y: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
};

export function fallImpact(
  frame: number,
  _fps: number,
  params: FallImpactParams = {}
): FallImpactResult {
  const {
    startFrame = 0,
    fallDistancePx = 520,
    fallDurationFrames = 13,
    squashAmount = 0.38,
    recoverFrames = 12,
  } = params;
  const f = frame - startFrame;
  if (f < 0) {
    return { y: -fallDistancePx, scaleX: 1, scaleY: 1, opacity: 0 };
  }
  if (f < fallDurationFrames) {
    const t = f / fallDurationFrames;
    // 加速落下: -dist → 0(ease-in)。少し縦に伸ばして勢いを出す。
    const y = -fallDistancePx * (1 - t * t);
    const stretch = 1 + 0.1 * t;
    const opacity = interpolate(f, [0, fallDurationFrames * 0.35], [0, 1], {
      extrapolateRight: "clamp",
    });
    return { y, scaleX: 1 / stretch, scaleY: stretch, opacity };
  }
  const rf = f - fallDurationFrames;
  if (rf < recoverFrames) {
    const s = Math.sin((rf / recoverFrames) * Math.PI); // 0 → 1 → 0
    return {
      y: 0,
      scaleX: 1 + squashAmount * s,
      scaleY: 1 - squashAmount * s,
      opacity: 1,
    };
  }
  return { y: 0, scaleX: 1, scaleY: 1, opacity: 1 };
}

// ---- boiling: 手描きの揺らぎ(常時薄く適用) ---------------------------
export type BoilingParams = {
  seed: number;
  rotAmpDeg?: number;
  scaleAmpPct?: number;
  hz?: number;
};
export type BoilingResult = { rotate: number; scale: number };

/**
 * 約 6fps で段階変化する ±0.5°回転 + ±0.5%スケール。
 * 全描画に薄く適用して手描きの「boiling(コマの揺れ)」を出す。
 */
export function boiling(
  frame: number,
  fps: number,
  params: BoilingParams
): BoilingResult {
  const { seed, rotAmpDeg = 0.5, scaleAmpPct = 0.5, hz = 6 } = params;
  const r = steppedNoise(seed ^ 0xa5a5, frame, fps, hz);
  const s = steppedNoise(seed ^ 0x5a5a, frame, fps, hz);
  return { rotate: r * rotAmpDeg, scale: 1 + (s * scaleAmpPct) / 100 };
}

// ---- crowdMultiply: N体の出現タイミングと配置オフセット -----------------
export type CrowdMember = {
  /** 中心からの水平オフセット(キャンバス幅に対する %) */
  xPctOffset: number;
  /** 中心からの垂直オフセット(キャンバス高さに対する %) */
  yPctOffset: number;
  /** 出現遅延フレーム(スタッガー) */
  delayFrames: number;
  /** 個体スケール(遠近の擬似表現) */
  scale: number;
  /** 左右反転するか */
  flip: boolean;
  /** 重なり順(奥=小さいほど後ろ) */
  z: number;
};
export type CrowdParams = {
  seed: number;
  spreadXPct?: number;
  spreadYPct?: number;
  baseDelayFrames?: number;
  staggerFrames?: number;
  scaleMin?: number;
  scaleMax?: number;
};

/**
 * N 体を「画面外まで増殖」させる用途の配置・タイミング配列を返す(§8 力の差)。
 * 位置・スケール・反転・出現遅延をすべてシードから決定論的に生成する。
 */
export function crowdMultiply(count: number, params: CrowdParams): CrowdMember[] {
  const {
    seed,
    spreadXPct = 42,
    spreadYPct = 12,
    baseDelayFrames = 0,
    staggerFrames = 3,
    scaleMin = 0.68,
    scaleMax = 1.04,
  } = params;
  const out: CrowdMember[] = [];
  for (let i = 0; i < count; i++) {
    const xPctOffset = (seededUnit(seed, i * 5 + 1) * 2 - 1) * spreadXPct;
    const yPctOffset = (seededUnit(seed, i * 5 + 2) * 2 - 1) * spreadYPct;
    const scale = scaleMin + seededUnit(seed, i * 5 + 3) * (scaleMax - scaleMin);
    const flip = seededUnit(seed, i * 5 + 4) < 0.5;
    out.push({
      xPctOffset,
      yPctOffset,
      delayFrames: baseDelayFrames + i * staggerFrames,
      scale,
      flip,
      z: Math.round(scale * 1000),
    });
  }
  return out;
}
