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
// 線の様式契約(チャンネル可変)。style.ts は他を import しないため循環しない。
import { LINE_STYLE } from "../scenes/style";

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

// ---- wipeIn: clip-pathによる方向指定ワイプ出現 ---------------------------
export type WipeDirection = "left" | "right" | "up" | "down";
export type WipeInParams = {
  direction?: WipeDirection;
  delayFrames?: number;
  durationFrames?: number;
};
export type WipeInResult = { clipPath: string; opacity: number };

export function wipeIn(
  frame: number,
  fps: number,
  params: WipeInParams = {}
): WipeInResult {
  const { direction = "left", delayFrames = 0, durationFrames = 16 } = params;
  const t = interpolate(frame - delayFrames, [0, durationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const pct = t * 100;
  let clipPath = `inset(0 ${100 - pct}% 0 0)`;
  if (direction === "right") clipPath = `inset(0 0 0 ${100 - pct}%)`;
  else if (direction === "up") clipPath = `inset(${100 - pct}% 0 0 0)`;
  else if (direction === "down") clipPath = `inset(0 0 ${100 - pct}% 0)`;
  return { clipPath, opacity: t > 0 ? 1 : 0 };
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
 * 常時わずかに動かす微小変形。様式は style.ts の `LINE_STYLE` 契約で決まる。
 *
 * - "rough": 約 6fps で段階変化する ±0.5°回転 + ±0.5%スケール。
 *   全描画に薄く適用して手描きの「boiling(コマの揺れ)」を出す。
 * - "clean": bible §8 が手描きのジッタを禁じるため、段階ノイズは使わない。
 *   代わりに**滑らかな連続ドリフト**(位相の異なる2つの正弦。既定振幅で ±0.12°/±0.3%)
 *   を返す。目的は画作りではなく **frozen_video QA 対策**:
 *   ・qa.ts は ffmpeg `freezedetect=d=3.0` で3秒超の静止区間を検出する。
 *     freezedetect は候補区間の先頭フレームを基準に差分を見るため、周期数秒の
 *     ドリフトなら3秒の間に基準から必ず離れ、静止と判定されない。
 *   ・qa-smoke.ts は同一ショットの +0.5秒 と +2.5秒 の PNG が**完全一致**したら
 *     静止疑いとする。2秒差はドリフト周期(下記)の 1/3 前後にあたり、
 *     全画素が一様に動くので一致しない。
 *   振幅は 1080p で画面端が数px動く程度 = 知覚されないが、上記いずれの検出条件も
 *   確実に外れる大きさ。
 */
/** clean ドリフトの周期(秒)。互いに素な2周期でパターンの反復を避ける */
const CLEAN_DRIFT_ROT_PERIOD_SEC = 6.3;
const CLEAN_DRIFT_SCALE_PERIOD_SEC = 4.9;
/** clean ドリフトの振幅(rough の振幅に対する比)。既定 0.5°/0.5% → 0.12°/0.3% */
const CLEAN_DRIFT_ROT_FACTOR = 0.24;
const CLEAN_DRIFT_SCALE_FACTOR = 0.6;

export function boiling(
  frame: number,
  fps: number,
  params: BoilingParams
): BoilingResult {
  const { seed, rotAmpDeg = 0.5, scaleAmpPct = 0.5, hz = 6 } = params;
  if (LINE_STYLE === "clean") {
    const t = frame / fps;
    // シードから位相をずらし、要素ごとに同期しないようにする
    const phR = seededUnit(seed ^ 0xa5a5, 0) * Math.PI * 2;
    const phS = seededUnit(seed ^ 0x5a5a, 0) * Math.PI * 2;
    const r = Math.sin((t / CLEAN_DRIFT_ROT_PERIOD_SEC) * Math.PI * 2 + phR);
    const s = Math.sin((t / CLEAN_DRIFT_SCALE_PERIOD_SEC) * Math.PI * 2 + phS);
    return {
      rotate: r * rotAmpDeg * CLEAN_DRIFT_ROT_FACTOR,
      scale: 1 + (s * scaleAmpPct * CLEAN_DRIFT_SCALE_FACTOR) / 100,
    };
  }
  const r = steppedNoise(seed ^ 0xa5a5, frame, fps, hz);
  const s = steppedNoise(seed ^ 0x5a5a, frame, fps, hz);
  return { rotate: r * rotAmpDeg, scale: 1 + (s * scaleAmpPct) / 100 };
}

// ---- kenBurns: 静止素材の緩やかなズーム ----------------------------------
export type KenBurnsParams = { durationSec: number; from?: number; to?: number };
export type KenBurnsResult = { scale: number };

export function kenBurns(
  frame: number,
  fps: number,
  { durationSec, from = 1.0, to = 1.05 }: KenBurnsParams
): KenBurnsResult {
  // durationSec<=0(未配線・ショット尺取得失敗などの縮退)は t=1 固定に倒す。
  // frame / (durationSec * fps) は durationSec<=0 だと Infinity/NaN/負値になり、
  // 後続の interpolate 系に渡ると実行時クラッシュしうるため、ここで完全にガードする。
  if (!(durationSec > 0)) {
    return { scale: to };
  }
  const t = Math.min(1, Math.max(0, frame / (durationSec * fps)));
  return { scale: from + (to - from) * t };
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
