/**
 * SVG パス生成(純関数、決定論)。ここでは幾何のみを扱い、色・線幅は呼び出し側が与える。
 *
 * 線の様式は style.ts の `LINE_STYLE` 契約が唯一の参照で、関数はその値で内部分岐する
 * (関数シグネチャは両様式で同一。呼び出し側は様式を意識しない)。
 *
 * - "rough"(既定・手描き画風): シード付き擬似乱数で頂点に歪みを与え、Catmull-Rom →
 *   3次ベジェで平滑化する。frame からシードを段階変化させれば線自体がコマ変わりで
 *   揺れる(boiling)。
 * - "clean"(bible §8「均一で太い線」): **パス生成そのものを変える**。
 *   ジッタ(wobble)は 0 にするだけでは足りない — 矩形の4頂点を Catmull-Rom で
 *   通すと角の丸いブヨブヨした図形になり「均一で太い輪郭」にならないため、
 *   閉/開パスは直線セグメント(M/L/Z)、円・楕円は正確な円弧(A)で描く。
 *   seed / wobble 引数は無視される(= 決定論的に同一の形になる)。
 */
import { seededRange } from "../motion/noise";
import { LINE_STYLE } from "./style";

type Pt = [number, number];

function fmt(n: number): string {
  return n.toFixed(2);
}

/** 点列を直線セグメントでつなぐ(clean の閉/開パス)。 */
function polyPath(pts: Pt[], close: boolean): string {
  if (pts.length < 2) return "";
  let d = `M ${fmt(pts[0][0])} ${fmt(pts[0][1])} `;
  for (let i = 1; i < pts.length; i++) {
    d += `L ${fmt(pts[i][0])} ${fmt(pts[i][1])} `;
  }
  return close ? d + "Z" : d.trimEnd();
}

/**
 * 楕円弧を A コマンドで描く(clean の円・楕円)。
 * a0 → a1 を 90°以下のセグメントへ分割するため large-arc-flag は常に 0 でよい。
 * turns>1(始点と終点が重なる一筆書き)にもそのまま対応する。
 */
function arcPath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  a0: number,
  a1: number,
  close = false
): string {
  const total = a1 - a0;
  if (total === 0) return "";
  const segs = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2)));
  const step = total / segs;
  const sweep = total > 0 ? 1 : 0;
  let d = `M ${fmt(cx + Math.cos(a0) * rx)} ${fmt(cy + Math.sin(a0) * ry)} `;
  for (let i = 1; i <= segs; i++) {
    const a = a0 + step * i;
    d += `A ${fmt(rx)} ${fmt(ry)} 0 0 ${sweep} ${fmt(cx + Math.cos(a) * rx)} ${fmt(cy + Math.sin(a) * ry)} `;
  }
  return close ? d + "Z" : d.trimEnd();
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
  // clean: 与えられた頂点をそのまま直線でつなぐ(平滑化しない = 角が立つ)
  if (LINE_STYLE === "clean") return polyPath(pts, true);
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
  // clean: 正確な楕円(4本の90°円弧)
  if (LINE_STYLE === "clean") {
    return arcPath(cx, cy, rx, ry, 0, Math.PI * 2, true);
  }
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
  const startAngle = -Math.PI / 2 - 0.25;
  // clean: 正確な円弧。turns 分だけ回る開いたパス(描き起こしアニメの
  // pathLength/strokeDasharray はそのまま効く)
  if (LINE_STYLE === "clean") {
    return arcPath(cx, cy, r, r, startAngle, startAngle + Math.PI * 2 * turns);
  }
  const pts: Pt[] = [];
  const total = Math.round(n * turns);
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
  const clean = LINE_STYLE === "clean";
  for (let i = 0; i < total; i++) {
    const a = (i / total) * Math.PI * 2 - Math.PI / 2;
    const base = i % 2 === 0 ? rOuter : rInner;
    // clean: 半径を歪ませない = 全ての棘が等長の正確な星形
    const w = clean ? 1 : 1 + seededRange(seed, i, -0.09, 0.09);
    pts.push([cx + Math.cos(a) * base * w, cy + Math.sin(a) * base * w]);
  }
  return polyPath(pts, true);
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
  // clean: 楕円上に等間隔で取った境界点を、外へ膨らむ正確な円弧でつなぐ
  // (= 大きさの揃ったもくもく)。large-arc=1 で半円より大きい puff にする。
  if (LINE_STYLE === "clean") {
    const bp: Pt[] = [];
    for (let i = 0; i < bumps; i++) {
      const a = (i / bumps) * Math.PI * 2;
      bp.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
    }
    let d = `M ${fmt(bp[0][0])} ${fmt(bp[0][1])} `;
    for (let i = 0; i < bumps; i++) {
      const p = bp[(i + 1) % bumps];
      const q = bp[i];
      const chord = Math.hypot(p[0] - q[0], p[1] - q[1]);
      const rBump = Math.max(chord * 0.56, chord / 2 + 0.01);
      d += `A ${fmt(rBump)} ${fmt(rBump)} 0 1 1 ${fmt(p[0])} ${fmt(p[1])} `;
    }
    return d + "Z";
  }
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
  // clean: 正確な直線
  if (LINE_STYLE === "clean") {
    return `M ${fmt(x1)} ${fmt(y1)} L ${fmt(x2)} ${fmt(y2)}`;
  }
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

  // clean: 本体は制御点そのままの正確な2次ベジェ(震えなし)。矢じりは元々直線。
  if (LINE_STYLE === "clean") {
    const shaft = `M ${fmt(x1)} ${fmt(y1)} Q ${fmt(midx)} ${fmt(midy)}, ${fmt(x2)} ${fmt(y2)}`;
    const ang = Math.atan2(y2 - midy, x2 - midx);
    const h1: Pt = [
      x2 + Math.cos(ang + Math.PI - 0.5) * headLen,
      y2 + Math.sin(ang + Math.PI - 0.5) * headLen,
    ];
    const h2: Pt = [
      x2 + Math.cos(ang + Math.PI + 0.5) * headLen,
      y2 + Math.sin(ang + Math.PI + 0.5) * headLen,
    ];
    const head = `M ${fmt(h1[0])} ${fmt(h1[1])} L ${fmt(x2)} ${fmt(y2)} L ${fmt(h2[0])} ${fmt(h2[1])}`;
    return { shaft, head };
  }

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
