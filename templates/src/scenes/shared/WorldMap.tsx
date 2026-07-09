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
  LANDS,
  WORLD_VIEWBOX_H,
  WORLD_VIEWBOX_W,
  lookupWorldPlace,
} from "./world-geometry";

/**
 * bible §9「地理形状は実データ」— 世界史題材の地理説明はこの世界全図で行う。
 * 大陸輪郭は Natural Earth 110m 由来(world-geometry.ts)。使い方・propsの
 * 契約は JapanMap と同一(places / focus / arrows)で、gazetteer だけが世界の
 * 地点辞書になる。地点が無ければ world-geometry の lonLatToXY で追加する。
 *
 * viewBox は 1000×540(非正方形)。カメラ・ラベル字幕帯回避・de-overlap は
 * JapanMap と同じ実装方針。
 */

export type MarkerKind = "circle" | "cross" | "flag";

export type PlaceSpec = {
  /** gazetteer キー(rome, caribbean, ...)。指定時は xPct/yPct より優先。 */
  id?: string;
  xPct?: number;
  yPct?: number;
  /** ラベル文字。省略時は gazetteer の既定ラベル。空文字でラベル無し。 */
  label?: string;
  color?: PaletteColor;
  marker?: MarkerKind;
  appearFrame?: number;
};

export type FocusSpec = {
  id?: string;
  xPct?: number;
  yPct?: number;
  /** 1=全図, 2〜5=寄り。既定 2。 */
  zoom?: number;
  startFrame?: number;
  durationFrames?: number;
};

export type ArrowSpec = {
  fromId: string;
  toId: string;
  color?: PaletteColor;
  appearFrame?: number;
  /** 破線(推定・仮定のルート)。既定 false=実線。 */
  dashed?: boolean;
};

export type WorldMapProps = {
  places?: PlaceSpec[];
  focus?: FocusSpec;
  arrows?: ArrowSpec[];
  backgroundColor?: string;
};

const VW = WORLD_VIEWBOX_W;
const VH = WORLD_VIEWBOX_H;
const CX = VW / 2;
const CY = VH / 2;

function resolveViewPoint(
  spec: { id?: string; xPct?: number; yPct?: number } | undefined
): [number, number] | null {
  if (!spec) return null;
  if (spec.id) {
    const g = lookupWorldPlace(spec.id);
    return g ? [g.x, g.y] : null;
  }
  if (typeof spec.xPct === "number" && typeof spec.yPct === "number") {
    return [(spec.xPct / 100) * VW, (spec.yPct / 100) * VH];
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
  cx: number;
  cy: number;
  halfW: number;
  halfH: number;
  text: string;
  color: PaletteColor;
  appearFrame: number;
};

export const WorldMap: React.FC<WorldMapProps> = ({
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
  const s = Math.min(width / VW, height / VH);
  const offX = (width - VW * s) / 2;
  const offY = (height - VH * s) / 2;

  // ---- カメラ(全図→focus へのズーム) ----
  let fx = CX;
  let fy = CY;
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
    fx = interpolate(t, [0, 1], [CX, fp[0]]);
    fy = interpolate(t, [0, 1], [CY, fp[1]]);
    z = interpolate(t, [0, 1], [1, focus.zoom ?? 2]);
  }
  const camTransform = `translate(${CX} ${CY}) scale(${z}) translate(${-fx} ${-fy})`;
  const project = (px: number, py: number): [number, number] => {
    const cx = (px - fx) * z + CX;
    const cy = (py - fy) * z + CY;
    return [offX + cx * s, offY + cy * s];
  };

  // 手描きの boiling。線幅は /z で画面上ほぼ一定に。
  const step = boilStep(frame, fps, 7);
  const landStroke = 5 / z;

  // ---- ラベル配置(画面px、字幕帯・画面端回避、簡易 de-overlap) ----
  const topMargin = height * 0.05;
  const bandTop = height * 0.86;
  const sideMargin = width * 0.03;
  const labelFontPx = height * 0.038;
  const labelHalfH = labelFontPx * 0.85;

  const boxes: LabelBox[] = [];
  places.forEach((pl, i) => {
    const vp = resolveViewPoint(pl);
    if (!vp) return;
    const defaultLabel = pl.id ? lookupWorldPlace(pl.id)?.label ?? "" : "";
    const text = pl.label ?? defaultLabel;
    if (!text) return;
    const [mx, my] = project(vp[0], vp[1]);
    if (mx < -width * 0.1 || mx > width * 1.1) return;
    if (my < -height * 0.1 || my > height * 1.1) return;

    const kind = pl.marker ?? "circle";
    const markerScreenR = kind === "circle" ? 24 * s * z : 16 * s * Math.max(1, z * 0.5);
    const gap = markerScreenR + labelHalfH + 12;

    let cy = my - gap;
    if (cy - labelHalfH < topMargin) cy = my + gap;
    if (cy + labelHalfH > bandTop) {
      cy = my - gap;
      if (cy - labelHalfH < topMargin) cy = topMargin + labelHalfH;
    }
    const halfW = (text.length * labelFontPx * 1.02) / 2 + labelFontPx * 0.9;
    const cx = Math.max(sideMargin + halfW, Math.min(width - sideMargin - halfW, mx));
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
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ position: "absolute", inset: 0, overflow: "hidden" }}
      >
        <g transform={camTransform}>
          {/* 陸地シルエット(Natural Earth 110m 由来) */}
          {Object.entries(LANDS).map(([name, pts]) => (
            <path
              key={name}
              d={roughClosedPath(pts, (seedFrom("wm-land", name) ^ step) >>> 0, 1.2)}
              fill={PALETTE.paper}
              stroke={PALETTE.ink}
              strokeWidth={landStroke}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {/* 航路・進軍矢印 */}
          {arrows.map((ar, i) => {
            const a = lookupWorldPlace(ar.fromId);
            const b = lookupWorldPlace(ar.toId);
            if (!a || !b) return null;
            const seed = seedFrom("wm-arrow", ar.fromId, ar.toId);
            const { shaft, head } = roughArrow(a.x, a.y, b.x, b.y, seed, 16, 0.16);
            const p = drawOn(frame, ar.appearFrame ?? 0, 16);
            const col = PALETTE[ar.color ?? "indigo"];
            const sw = 4.5 / z;
            return (
              <g key={`ar-${i}`}>
                <path
                  d={shaft}
                  pathLength={100}
                  fill="none"
                  stroke={col}
                  strokeWidth={sw}
                  strokeLinecap="round"
                  strokeDasharray={ar.dashed ? `${100 / 22} ${100 / 22}` : 100}
                  strokeDashoffset={ar.dashed ? 0 : 100 * (1 - p)}
                  opacity={ar.dashed ? p : 1}
                />
                <path
                  d={head}
                  fill="none"
                  stroke={col}
                  strokeWidth={sw}
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
            const seed = seedFrom("wm-mark", i, pl.id ?? "", px, py);

            if (kind === "circle") {
              const r = 24;
              const p = drawOn(frame, appear, 16);
              return (
                <path
                  key={`m-${i}`}
                  d={roughCirclePath(px, py, r, (seed ^ step) >>> 0, 0.06)}
                  pathLength={100}
                  fill="none"
                  stroke={col}
                  strokeWidth={5.5 / z}
                  strokeLinecap="round"
                  strokeDasharray={100}
                  strokeDashoffset={100 * (1 - p)}
                />
              );
            }
            if (kind === "cross") {
              const h = 16;
              const p = drawOn(frame, appear, 14);
              const l1 = roughLinePath(px - h, py - h, px + h, py + h, seed ^ step, 2, 5);
              const l2 = roughLinePath(px - h, py + h, px + h, py - h, seed ^ (step + 9), 2, 5);
              return (
                <g key={`m-${i}`}>
                  {[l1, l2].map((d, k) => (
                    <path
                      key={k}
                      d={d}
                      pathLength={100}
                      fill="none"
                      stroke={col}
                      strokeWidth={6 / z}
                      strokeLinecap="round"
                      strokeDasharray={100}
                      strokeDashoffset={100 * (1 - p)}
                    />
                  ))}
                </g>
              );
            }
            const { scale } = popIn(frame, fps, { delayFrames: appear });
            const poleH = 32;
            const flagW = 24;
            const flagDrop = 11;
            const top = py - poleH;
            const pennant = `M ${px} ${top} L ${px + flagW} ${top + flagDrop * 0.5} L ${px} ${top + flagDrop} Z`;
            return (
              <g
                key={`m-${i}`}
                transform={`translate(${px} ${py}) scale(${scale}) translate(${-px} ${-py})`}
                style={{ transformOrigin: `${px}px ${py}px` }}
              >
                <path
                  d={roughLinePath(px, py, px, top, seed, 1.2, 4)}
                  fill="none"
                  stroke={PALETTE.ink}
                  strokeWidth={5 / z}
                  strokeLinecap="round"
                />
                <path d={pennant} fill={col} stroke={PALETTE.ink} strokeWidth={2.5 / z} strokeLinejoin="round" />
                <circle cx={px} cy={py} r={4 / z + 2} fill={PALETTE.ink} />
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
export const WORLD_PLACE_IDS = Object.keys(GAZETTEER);
