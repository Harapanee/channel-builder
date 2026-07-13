import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { safeInterpolate } from "../../motion";
import { MINCHO_FONT_STACK, PALETTE } from "../style";

/**
 * TimelineBar — 年表(bible §8「時間経過・年代 → 年表バー+年号テロップ」)。
 *
 * paper背景+ink水平線+目盛り。emphasis マーカーは深紅。年号は明朝体。
 * 事実を扱う画面なので誇張しない(bible §9)— 演出は静かなフェードのみ。
 * 上下黒帯(各12%)+字幕域は Episode.tsx が重畳するため、
 * 全要素を縦 15%〜78% の帯内に収める。
 */
export type TimelineBarProps = {
  startYear: number;
  endYear: number;
  markers: Array<{ year: number; label: string; emphasis?: boolean }>;
  caption?: string;
};

/** 年の表示(負値は紀元前として「前N年」)。 */
function formatYear(year: number): string {
  return year < 0 ? `前${-year}年` : `${year}年`;
}

export const TimelineBar: React.FC<TimelineBarProps> = ({
  startYear,
  endYear,
  markers,
  caption,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // 水平線の配置(帯・字幕を避けた画面中央のやや下)
  const lineY = height * 0.54;
  const lineX0 = width * 0.1;
  const lineX1 = width * 0.9;
  const span = Math.max(1e-6, endYear - startYear);
  const xOf = (year: number) =>
    lineX0 + ((year - startYear) / span) * (lineX1 - lineX0);

  // 線が左から静かに引かれる(誇張しない)
  const lineProgress = safeInterpolate(frame, [0, 0.8 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // マーカーは左から順に静かにフェードイン
  const sorted = [...markers].sort((a, b) => a.year - b.year);
  const markerOpacity = (i: number) =>
    safeInterpolate(
      frame,
      [(0.5 + i * 0.25) * fps, (1.0 + i * 0.25) * fps],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );

  const captionOpacity = safeInterpolate(frame, [0.2 * fps, 0.9 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const tickH = height * 0.03;
  const labelSize = height * 0.036;
  const yearSize = height * 0.03;
  const endYearSize = height * 0.026;

  // 両端の年ラベルは、同じ年のマーカーがある場合は重複するので出さない
  const hasMarkerAt = (year: number) =>
    sorted.some((m) => Math.abs(xOf(m.year) - xOf(year)) < width * 0.04);
  const showStartYear = !hasMarkerAt(startYear);
  const showEndYear = !hasMarkerAt(endYear);

  return (
    <AbsoluteFill style={{ backgroundColor: PALETTE.paper }}>
      {/* 見出し(任意) */}
      {caption ? (
        <div
          style={{
            position: "absolute",
            top: height * 0.2,
            width: "100%",
            textAlign: "center",
            fontFamily: MINCHO_FONT_STACK,
            fontSize: height * 0.044,
            fontWeight: 600,
            color: PALETTE.ink,
            letterSpacing: "0.14em",
            opacity: captionOpacity,
          }}
        >
          {caption}
        </div>
      ) : null}

      {/* 水平線+目盛り(SVG) */}
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: "absolute", inset: 0 }}
      >
        <line
          x1={lineX0}
          y1={lineY}
          x2={lineX0 + (lineX1 - lineX0) * lineProgress}
          y2={lineY}
          stroke={PALETTE.ink}
          strokeWidth={Math.max(3, height * 0.004)}
        />
        {/* 両端の小目盛り */}
        {[lineX0, lineX1].map((x, i) => (
          <line
            key={`end-${i}`}
            x1={x}
            y1={lineY - tickH * 0.5}
            x2={x}
            y2={lineY + tickH * 0.5}
            stroke={PALETTE.ink}
            strokeWidth={Math.max(3, height * 0.004)}
            opacity={i === 0 ? lineProgress * 2 : lineProgress >= 1 ? 1 : 0}
          />
        ))}
        {/* マーカーの目盛り */}
        {sorted.map((m, i) => {
          const x = xOf(m.year);
          const color = m.emphasis ? PALETTE.red : PALETTE.ink;
          return (
            <g key={`tick-${i}`} opacity={markerOpacity(i)}>
              <line
                x1={x}
                y1={lineY - tickH * 0.6}
                x2={x}
                y2={lineY + tickH * 0.6}
                stroke={color}
                strokeWidth={Math.max(3, height * 0.005)}
              />
              {m.emphasis ? (
                // 強調は深紅の点をひとつ添えるだけ(誇張しない)
                <circle cx={x} cy={lineY} r={height * 0.008} fill={color} />
              ) : null}
            </g>
          );
        })}
      </svg>

      {/* 両端の年(明朝体・小さめ。同じ年のマーカーがある端は出さない) */}
      {showStartYear ? (
        <div
          style={{
            position: "absolute",
            left: lineX0,
            top: lineY + tickH * 1.1,
            transform: "translateX(-50%)",
            fontFamily: MINCHO_FONT_STACK,
            fontSize: endYearSize,
            color: PALETTE.ink,
            opacity: 0.75 * lineProgress,
            whiteSpace: "nowrap",
          }}
        >
          {formatYear(startYear)}
        </div>
      ) : null}
      {showEndYear ? (
        <div
          style={{
            position: "absolute",
            left: lineX1,
            top: lineY + tickH * 1.1,
            transform: "translateX(-50%)",
            fontFamily: MINCHO_FONT_STACK,
            fontSize: endYearSize,
            color: PALETTE.ink,
            opacity: lineProgress >= 1 ? 0.75 : 0,
            whiteSpace: "nowrap",
          }}
        >
          {formatYear(endYear)}
        </div>
      ) : null}

      {/* マーカーの年号+ラベル(隣接の重なりを避けるため上下2段を交互に使う) */}
      {sorted.map((m, i) => {
        const x = xOf(m.year);
        const color = m.emphasis ? PALETTE.red : PALETTE.ink;
        const above = i % 2 === 0;
        return (
          <div
            key={`label-${i}`}
            style={{
              position: "absolute",
              left: x,
              top: above ? lineY - tickH * 0.6 : lineY + tickH * 0.6,
              transform: above ? "translate(-50%, -100%)" : "translate(-50%, 0)",
              display: "flex",
              flexDirection: above ? "column-reverse" : "column",
              alignItems: "center",
              opacity: markerOpacity(i),
            }}
          >
            <div
              style={{
                fontFamily: MINCHO_FONT_STACK,
                fontSize: yearSize,
                color,
                whiteSpace: "nowrap",
                margin: `${height * 0.006}px 0`,
              }}
            >
              {formatYear(m.year)}
            </div>
            <div
              style={{
                fontFamily: MINCHO_FONT_STACK,
                fontSize: labelSize,
                fontWeight: m.emphasis ? 600 : 400,
                color,
                whiteSpace: "nowrap",
                margin: `${height * 0.004}px 0`,
              }}
            >
              {m.label}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
