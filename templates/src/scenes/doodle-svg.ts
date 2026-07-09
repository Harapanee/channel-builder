/**
 * 手描き風の SVG パス生成(純関数、決定論)。
 *
 * すべてシード付き擬似乱数で歪みを与える。frame からシードを段階変化させれば
 * 線自体がコマ変わりで揺れる(boiling)。ここでは幾何のみを扱い、色・線幅は
 * 呼び出し側が与える。
 */
import { seededRange } from "../motion/noise";

type Pt = [number, number];

function fmt(n: number): string {
  return n.toFixed(2);
}

/** 閉じた点列を Catmull-Rom → 3次ベジェで滑らかな閉曲線にする。 */
function catmullRomClosed(pts: Pt[]): string {
  const n = pts.length;
  if (n < 3) return "";
  let d = `M ${fmt(pts[0][0])} ${fmt(pts[0][1])} `;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C ${fmt(c1x)} ${fmt(c1y)}, ${fmt(c2x)} ${fmt(c2y)}, ${fmt(p2[0])} ${fmt(p2[1])} `;
  }
  return d + "Z";
}

/** 開いた点列を Catmull-Rom → 3次ベジェで滑らかな開曲線にする。 */
function catmullRomOpen(pts: Pt[]): string {
  const n = pts.length;
  if (n < 2) return "";
  let d = `M ${fmt(pts[0][0])} ${fmt(pts[0][1])} `;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C ${fmt(c1x)} ${fmt(c1y)}, ${fmt(c2x)} ${fmt(c2y)}, ${fmt(p2[0])} ${fmt(p2[1])} `;
  }
  return d;
}

/**
 * 任意の閉じた点列を、なめらかな手描き風の閉曲線パスにする。
 * wobble>0 のとき各頂点をシードで微小ジッタ(手描きの震え/boiling用)。
 * 地図の海岸線(粗い多角形をなめらかに)などに使う。
 */
export function roughClosedPath(
  pts: Pt[],
  seed = 0,
  wobble = 0
): string {
  if (pts.length < 3) return "";
  if (wobble <= 0) return catmullRomClosed(pts);
  const jittered: Pt[] = pts.map((p, i) => [
    p[0] + seededRange(seed, i * 2 + 1, -wobble, wobble),
    p[1] + seededRange(seed, i * 2 + 2, -wobble, wobble),
  ]);
  return catmullRomClosed(jittered);
}

/** シード付きで歪ませた楕円の閉パス(吹き出し・強調枠など)。 */
export function roughEllipsePath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seed: number,
  wobble = 0.07,
  n = 16
): string {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const w = 1 + seededRange(seed, i, -wobble, wobble);
    pts.push([cx + Math.cos(a) * rx * w, cy + Math.sin(a) * ry * w]);
  }
  return catmullRomClosed(pts);
}

/**
 * 一筆書きの手描き円(開いた曲線、始点と終点がわずかに重なる)。
 * DangerCircle の描き起こしアニメ用。pathLength="100" 前提で使うと
 * strokeDasharray/offset を [100,0] で扱える。
 */
export function roughCirclePath(
  cx: number,
  cy: number,
  r: number,
  seed: number,
  wobble = 0.05,
  n = 22,
  turns = 1.08
): string {
  const pts: Pt[] = [];
  const total = Math.round(n * turns);
  const startAngle = -Math.PI / 2 - 0.25;
  for (let i = 0; i <= total; i++) {
    const a = startAngle + (i / n) * Math.PI * 2;
    const w = 1 + seededRange(seed, i % n, -wobble, wobble);
    pts.push([cx + Math.cos(a) * r * w, cy + Math.sin(a) * r * w]);
  }
  return catmullRomOpen(pts);
}

/** ギザギザの爆発型(shout の吹き出し輪郭)。角は直線でつなぐ。 */
export function roughBurstPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  seed: number,
  spikes = 16
): string {
  const pts: Pt[] = [];
  const total = spikes * 2;
  for (let i = 0; i < total; i++) {
    const a = (i / total) * Math.PI * 2 - Math.PI / 2;
    const base = i % 2 === 0 ? rOuter : rInner;
    const w = 1 + seededRange(seed, i, -0.09, 0.09);
    pts.push([cx + Math.cos(a) * base * w, cy + Math.sin(a) * base * w]);
  }
  let d = `M ${fmt(pts[0][0])} ${fmt(pts[0][1])} `;
  for (let i = 1; i < pts.length; i++) {
    d += `L ${fmt(pts[i][0])} ${fmt(pts[i][1])} `;
  }
  return d + "Z";
}

/** もくもくした思考の雲(thought の吹き出し輪郭)。 */
export function roughCloudPath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seed: number,
  bumps = 9
): string {
  const pts: Pt[] = [];
  const n = bumps * 3;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const scallop = 1 + 0.13 * Math.abs(Math.sin((a * bumps) / 2));
    const w = 1 + seededRange(seed, i, -0.05, 0.05);
    pts.push([cx + Math.cos(a) * rx * scallop * w, cy + Math.sin(a) * ry * scallop * w]);
  }
  return catmullRomClosed(pts);
}

/** 手描き風の直線(わずかに震える)。ラベル下線・区切り線などに。 */
export function roughLinePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  seed: number,
  wobble = 4,
  segments = 8
): string {
  const pts: Pt[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    const jitter = i === 0 || i === segments ? 0 : seededRange(seed, i, -wobble, wobble);
    // 進行方向に対して垂直方向へ揺らす
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    pts.push([x + nx * jitter, y + ny * jitter]);
  }
  return catmullRomOpen(pts);
}

/**
 * 手描き風の進軍矢印。始点→終点の緩いカーブ本体 + 二本の矢じり線。
 * 返り値は本体パスと矢じりパスの2本(strokeで別々に描ける)。
 */
export function roughArrow(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  seed: number,
  headLen = 34,
  curve = 0.18
): { shaft: string; head: string } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  // ゆるいアーチにする制御点
  const midx = (x1 + x2) / 2 + nx * len * curve;
  const midy = (y1 + y2) / 2 + ny * len * curve;
  const pts: Pt[] = [];
  const segs = 10;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // 2次ベジェ上の点
    const bx = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * midx + t * t * x2;
    const by = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * midy + t * t * y2;
    const j = i === 0 || i === segs ? 0 : seededRange(seed, i, -3, 3);
    pts.push([bx + nx * j, by + ny * j]);
  }
  const shaft = catmullRomOpen(pts);
  // 矢じり: 終点の接線方向から左右へ
  const ang = Math.atan2(y2 - midy, x2 - midx);
  const a1 = ang + Math.PI - 0.5;
  const a2 = ang + Math.PI + 0.5;
  const h1: Pt = [x2 + Math.cos(a1) * headLen, y2 + Math.sin(a1) * headLen];
  const h2: Pt = [x2 + Math.cos(a2) * headLen, y2 + Math.sin(a2) * headLen];
  const head = `M ${fmt(h1[0])} ${fmt(h1[1])} L ${fmt(x2)} ${fmt(y2)} L ${fmt(h2[0])} ${fmt(h2[1])}`;
  return { shaft, head };
}
