import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { boilStep, popIn, seedFrom } from "../../motion";
import {
  roughArrow,
  roughCirclePath,
  roughClosedPath,
  roughLinePath,
} from "../doodle-svg";
import { PALETTE, type PaletteColor } from "../style";
import { DOODLE_FONT_STACK, useDoodleFont } from "../use-doodle-font";
import {
  GAZETTEER,
  ISLANDS,
  JAPAN_VIEWBOX,
  lookupPlace,
} from "./japan-geometry";

/**
 * §8「場所の説明は日本地図で」— 日本全図の上で地名をハイライトし、
 * 必要ならその地域へカメラをズームして「日本のどの辺か」を一目で見せる。
 *
 * 描画は全て viewBox 0..1000(japan-geometry と同一座標系)で行い、
 * カメラは <g transform> で表現する。ラベルだけは非ズームの HTML 層に
 * 投影配置し(ズームで文字が伸びない)、画面下部12%の字幕帯を自動回避する。
 *
 * SVGロード方式: 素材ファイルを fetch せず、島の頂点データ(japan-geometry)を
 * インラインで描く。理由は報告参照(座標系一致・ズーム精度・字幕回避のため)。
 */

export type MarkerKind = "circle" | "cross" | "flag" | "dot";

/** 地点指定: gazetteer の id か、キャンバス%座標(xPct/yPct)のいずれか。 */
export type PlaceSpec = {
  /** gazetteer キー(owari, kyoto, ...)。指定時は xPct/yPct より優先。 */
  id?: string;
  /** キャンバス幅に対する % (0-100)。id 未指定時に使用。 */
  xPct?: number;
  /** キャンバス高さに対する % (0-100)。id 未指定時に使用。 */
  yPct?: number;
  /** ラベル文字。省略時は gazetteer の既定ラベル(id指定時)。空文字でラベル無し。 */
  label?: string;
  /** マーカー/円の色。既定 "red"。 */
  color?: PaletteColor;
  /** マーカー種別。既定 "circle"(赤の手描き円)。 */
  marker?: MarkerKind;
  /**
   * マーカー半径(viewBox 0..1000 単位)。circle/dot のみ有効。
   * 省略時は circle=40(既定の「1か所を丸で囲む」強調サイズ)、dot=10。
   * 多数の地点を同時に置く用途(散布)では、島の面積に対して過大にならない
   * よう明示的に小さい値を渡すこと(既定のまま多数配置すると重なって塊に見える)。
   */
  radius?: number;
  /** 出現フレーム(ショット内相対)。既定 0。 */
  appearFrame?: number;
};

export type FocusSpec = {
  id?: string;
  xPct?: number;
  yPct?: number;
  /** 1=全図, 2〜4=寄り。既定 2。 */
  zoom?: number;
  /** ズーム開始フレーム。既定 0。 */
  startFrame?: number;
  /** ズーム所要フレーム。既定 30。 */
  durationFrames?: number;
};

export type ArrowSpec = {
  fromId: string;
  toId: string;
  color?: PaletteColor;
  appearFrame?: number;
};

export type JapanMapProps = {
  places?: PlaceSpec[];
  focus?: FocusSpec;
  arrows?: ArrowSpec[];
  /** 背景色(既定 紙色)。 */
  backgroundColor?: string;
};

const VIEW = JAPAN_VIEWBOX;
const CENTER = VIEW / 2;

/** viewBox 座標(0..1000)を返す。解決不能なら null。 */
function resolveViewPoint(
  spec: { id?: string; xPct?: number; yPct?: number } | undefined
): [number, number] | null {
  if (!spec) return null;
  if (spec.id) {
    const g = lookupPlace(spec.id);
    return g ? [g.x, g.y] : null;
  }
  if (typeof spec.xPct === "number" && typeof spec.yPct === "number") {
    return [(spec.xPct / 100) * VIEW, (spec.yPct / 100) * VIEW];
  }
  return null;
}

const drawOn = (frame: number, appearFrame: number, len = 16) =>
  interpolate(frame, [appearFrame, appearFrame + len], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

type LabelBox = {
  key: string;
  cx: number; // 画面px 中心
  cy: number;
  halfW: number;
  halfH: number;
  text: string;
  color: PaletteColor;
  appearFrame: number;
};

export const JapanMap: React.FC<JapanMapProps> = ({
  places = [],
  focus,
  arrows = [],
  backgroundColor,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const fontFamily = useDoodleFont();
  const font = `${fontFamily}, ${DOODLE_FONT_STACK}`;

  // ---- viewBox → 画面 の投影(preserveAspectRatio=xMidYMid meet と一致) ----
  const s = Math.min(width, height) / VIEW;
  const offX = (width - VIEW * s) / 2;
  const offY = (height - VIEW * s) / 2;

  // ---- カメラ(全図→focus へのズーム) ----
  let fx = CENTER;
  let fy = CENTER;
  let z = 1;
  const fp = resolveViewPoint(focus);
  if (focus && fp) {
    const start = focus.startFrame ?? 0;
    const dur = Math.max(1, focus.durationFrames ?? 30);
    const t = interpolate(frame, [start, start + dur], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.inOut(Easing.cubic),
    });
    fx = interpolate(t, [0, 1], [CENTER, fp[0]]);
    fy = interpolate(t, [0, 1], [CENTER, fp[1]]);
    z = interpolate(t, [0, 1], [1, focus.zoom ?? 2]);
  }
  // SVG <g> 用のカメラ変換(viewBox 単位)。point → (point-f)*z + center。
  const camTransform = `translate(${CENTER} ${CENTER}) scale(${z}) translate(${-fx} ${-fy})`;
  // 上と同じ写像を JS でも行い、ラベルを画面へ投影する。
  const project = (px: number, py: number): [number, number] => {
    const cx = (px - fx) * z + CENTER;
    const cy = (py - fy) * z + CENTER;
    return [offX + cx * s, offY + cy * s];
  };

  // 手描きの boiling(線を ~7fps でコマ変わり)
  const step = boilStep(frame, fps, 7);
  // 線幅はズームしても画面上でほぼ一定に見えるよう /z で相殺。
  const islandStroke = 9 / z;

  // ---- ラベル配置(画面px、字幕帯・画面端回避、簡易 de-overlap) ----
  const topMargin = height * 0.05;
  const bandTop = height * 0.86; // 下部12%字幕帯の上端付近
  const sideMargin = width * 0.03;
  const labelFontPx = height * 0.038;
  const labelHalfH = labelFontPx * 0.85; // 箱の半高(padding込みの目安)

  const boxes: LabelBox[] = [];
  places.forEach((pl, i) => {
    const vp = resolveViewPoint(pl);
    if (!vp) return;
    const defaultLabel = pl.id ? lookupPlace(pl.id)?.label ?? "" : "";
    const text = pl.label ?? defaultLabel;
    if (!text) return;
    const [mx, my] = project(vp[0], vp[1]);
    // 画面外(大きくはみ出す)マーカーのラベルは出さない
    if (mx < -width * 0.1 || mx > width * 1.1) return;
    if (my < -height * 0.1 || my > height * 1.1) return;

    const kind = pl.marker ?? "circle";
    // マーカーの画面半径(円/点は viewBox 単位がズームで拡大)。
    const markerScreenR =
      kind === "circle"
        ? (pl.radius ?? 40) * s * z
        : kind === "dot"
          ? (pl.radius ?? 10) * s * z
          : 26 * s * Math.max(1, z * 0.5);
    const gap = markerScreenR + labelHalfH + 12;

    let cy = my - gap; // まず上に置く
    if (cy - labelHalfH < topMargin) {
      cy = my + gap; // 上が窮屈なら下へ
    }
    if (cy + labelHalfH > bandTop) {
      // 下が字幕帯に掛かるなら上に戻し、上端でクランプ
      cy = my - gap;
      if (cy - labelHalfH < topMargin) cy = topMargin + labelHalfH;
    }
    const halfW = (text.length * labelFontPx * 1.02) / 2 + labelFontPx * 0.9;
    const cx = Math.max(
      sideMargin + halfW,
      Math.min(width - sideMargin - halfW, mx)
    );
    boxes.push({
      key: `lbl-${i}`,
      cx,
      cy,
      halfW,
      halfH: labelHalfH,
      text,
      color: pl.color ?? "ink",
      appearFrame: pl.appearFrame ?? 0,
    });
  });

  // 簡易 de-overlap: x が重なるラベル同士を縦に押し分ける(字幕帯は跨がない)。
  for (let pass = 0; pass < 3; pass++) {
    boxes.sort((a, b) => a.cy - b.cy);
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        const A = boxes[a];
        const B = boxes[b];
        const xOverlap = Math.abs(A.cx - B.cx) < A.halfW + B.halfW;
        const need = A.halfH + B.halfH + 6;
        const dy = B.cy - A.cy;
        if (xOverlap && dy < need) {
          const push = (need - dy) / 2;
          const upTarget = A.cy - push;
          const downTarget = B.cy + push;
          if (downTarget + B.halfH <= bandTop) {
            A.cy = Math.max(topMargin + A.halfH, upTarget);
            B.cy = downTarget;
          } else {
            // 下げると字幕帯 → 両方上へ寄せる
            B.cy = A.cy;
            A.cy = Math.max(topMargin + A.halfH, A.cy - need);
          }
        }
      }
    }
  }

  return (
    <AbsoluteFill style={{ backgroundColor: backgroundColor ?? PALETTE.paper }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ position: "absolute", inset: 0, overflow: "hidden" }}
      >
        <g transform={camTransform}>
          {/* 日本列島シルエット(4島) */}
          {Object.entries(ISLANDS).map(([name, pts]) => (
            <path
              key={name}
              d={roughClosedPath(pts, (seedFrom("island", name) ^ step) >>> 0, 2.5)}
              fill={PALETTE.paper}
              stroke={PALETTE.ink}
              strokeWidth={islandStroke}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {/* 進軍矢印 */}
          {arrows.map((ar, i) => {
            const a = lookupPlace(ar.fromId);
            const b = lookupPlace(ar.toId);
            if (!a || !b) return null;
            const seed = seedFrom("jm-arrow", ar.fromId, ar.toId);
            const { shaft, head } = roughArrow(a.x, a.y, b.x, b.y, seed, 26, 0.16);
            const p = drawOn(frame, ar.appearFrame ?? 0, 16);
            const col = PALETTE[ar.color ?? "indigo"];
            return (
              <g key={`ar-${i}`}>
                <path
                  d={shaft}
                  pathLength={100}
                  fill="none"
                  stroke={col}
                  strokeWidth={7 / z}
                  strokeLinecap="round"
                  strokeDasharray={100}
                  strokeDashoffset={100 * (1 - p)}
                />
                <path
                  d={head}
                  fill="none"
                  stroke={col}
                  strokeWidth={7 / z}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={p > 0.85 ? 1 : 0}
                />
              </g>
            );
          })}

          {/* 地点マーカー(円/バツ/旗) */}
          {places.map((pl, i) => {
            const vp = resolveViewPoint(pl);
            if (!vp) return null;
            const [px, py] = vp;
            const appear = pl.appearFrame ?? 0;
            const kind = pl.marker ?? "circle";
            const col = PALETTE[pl.color ?? "red"];
            const seed = seedFrom("jm-mark", i, pl.id ?? "", px, py);

            if (kind === "circle") {
              const r = pl.radius ?? 40;
              const p = drawOn(frame, appear, 16);
              return (
                <path
                  key={`m-${i}`}
                  d={roughCirclePath(px, py, r, (seed ^ step) >>> 0, 0.06)}
                  pathLength={100}
                  fill="none"
                  stroke={col}
                  strokeWidth={9 / z}
                  strokeLinecap="round"
                  strokeDasharray={100}
                  strokeDashoffset={100 * (1 - p)}
                />
              );
            }
            if (kind === "dot") {
              // 多数地点の散布用: 縁取りの手描き円ではなく、塗りの小さな点で
              // 「一つ一つが識別できる個」を保つ(縁取り円を多数詰めると
              // 縁の太さ自体が面積を食い塊化するため、塗り点に分離した)。
              const r = pl.radius ?? 10;
              const { scale, opacity } = popIn(frame, fps, { delayFrames: appear });
              return (
                <circle
                  key={`m-${i}`}
                  cx={px}
                  cy={py}
                  r={r * scale}
                  fill={col}
                  opacity={opacity}
                />
              );
            }
            if (kind === "cross") {
              const h = 26;
              const p = drawOn(frame, appear, 14);
              const l1 = roughLinePath(px - h, py - h, px + h, py + h, seed ^ step, 2.5, 5);
              const l2 = roughLinePath(px - h, py + h, px + h, py - h, seed ^ (step + 9), 2.5, 5);
              return (
                <g key={`m-${i}`}>
                  {[l1, l2].map((d, k) => (
                    <path
                      key={k}
                      d={d}
                      pathLength={100}
                      fill="none"
                      stroke={col}
                      strokeWidth={10 / z}
                      strokeLinecap="round"
                      strokeDasharray={100}
                      strokeDashoffset={100 * (1 - p)}
                    />
                  ))}
                </g>
              );
            }
            // flag: 竿 + 三角ペナント。base(px,py)で popIn。
            const { scale } = popIn(frame, fps, { delayFrames: appear });
            const poleH = 52;
            const flagW = 40;
            const flagDrop = 18;
            const top = py - poleH;
            const pennant = `M ${px} ${top} L ${px + flagW} ${top + flagDrop * 0.5} L ${px} ${top + flagDrop} Z`;
            return (
              <g
                key={`m-${i}`}
                transform={`translate(${px} ${py}) scale(${scale}) translate(${-px} ${-py})`}
                style={{ transformOrigin: `${px}px ${py}px` }}
              >
                <path
                  d={roughLinePath(px, py, px, top, seed, 1.5, 4)}
                  fill="none"
                  stroke={PALETTE.ink}
                  strokeWidth={8 / z}
                  strokeLinecap="round"
                />
                <path d={pennant} fill={col} stroke={PALETTE.ink} strokeWidth={4 / z} strokeLinejoin="round" />
                <circle cx={px} cy={py} r={7 / z + 3} fill={PALETTE.ink} />
              </g>
            );
          })}
        </g>
      </svg>

      {/* ラベル層(非ズーム。字幕帯・画面端回避済み) */}
      {boxes.map((bx) => {
        const { scale, opacity } = popIn(frame, fps, { delayFrames: bx.appearFrame });
        return (
          <div
            key={bx.key}
            style={{
              position: "absolute",
              left: bx.cx,
              top: bx.cy,
              transform: `translate(-50%, -50%) scale(${scale})`,
              opacity,
              display: "flex",
              alignItems: "center",
              gap: "0.35em",
              background: PALETTE.paper,
              border: `3px solid ${PALETTE.ink}`,
              borderRadius: 10,
              padding: "0.14em 0.5em",
              fontFamily: font,
              fontSize: labelFontPx,
              lineHeight: 1.15,
              color: PALETTE[bx.color],
              whiteSpace: "nowrap",
              boxShadow: "3px 3px 0 rgba(27,26,23,0.18)",
            }}
          >
            <span
              style={{
                width: "0.42em",
                height: "0.42em",
                borderRadius: "50%",
                background: PALETTE.red,
                display: "inline-block",
                flex: "0 0 auto",
              }}
            />
            {bx.text}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

/** テスト/参照用: gazetteer の全キー。 */
export const JAPAN_PLACE_IDS = Object.keys(GAZETTEER);
