import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { boiling, seedFrom, seededRange } from "../../motion";
import { roughLinePath } from "../doodle-svg";
import { PALETTE, SUBTITLE_SAFE_BOTTOM_PCT } from "../style";
import { DOODLE_FONT_STACK, useDoodleFont } from "../use-doodle-font";
import { useOptionalAsset } from "../asset-context";

/**
 * §7.6 ComparisonSplit — 二分割比較(兵力差 / before-after)。
 * mode: bars(手描きの太い棒) / count(数字カウントアップ) / size(大小の比較)。
 * 数字・ラベルは Yusei Magic。左=藍・右=赤で対比を示す。
 */
export type ComparisonSide = {
  label: string;
  value: number;
  assetId?: string;
};
export type ComparisonSplitProps = {
  left: ComparisonSide;
  right: ComparisonSide;
  mode: "bars" | "count" | "size";
  countUpDurationFrames?: number;
};

/** シード付きの歪んだ矩形パス(手描きの棒)。 */
function roughRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  seed: number,
  j = 6
): string {
  const p = (i: number) => seededRange(seed, i, -j, j);
  const x0 = x + p(1);
  const y0 = y + p(2);
  const x1 = x + w + p(3);
  const y1 = y + p(4);
  const x2 = x + w + p(5);
  const y2 = y + h + p(6);
  const x3 = x + p(7);
  const y3 = y + h + p(8);
  return `M ${x0} ${y0} L ${x1} ${y1} L ${x2} ${y2} L ${x3} ${y3} Z`;
}

/** target(最終値)の小数桁数だけ表示に保持する。中身は count-up アニメーションで
 * 常に動いている(shownValue = value * progress)ため、瞬間値そのものの
 * Number.isInteger 判定に頼ると 65 のような整数ターゲットでも "32.5" のような
 * 途中経過の半端な小数が出てしまう。target の桁数(0 = 整数)に固定して丸めることで、
 * 整数ターゲットは従来通り整数のみで動き、小数ターゲット(例 38.7)は
 * 常に同じ桁数の小数(38.7 が 39 に化けない)で表示される。 */
function decimalsOf(target: number): number {
  if (Number.isInteger(target)) return 0;
  const s = target.toString();
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

function formatNum(n: number, targetDecimals: number): string {
  if (targetDecimals === 0) {
    return Math.round(n).toLocaleString("en-US");
  }
  const factor = 10 ** targetDecimals;
  const rounded = Math.round(n * factor) / factor;
  return rounded.toLocaleString("en-US", {
    minimumFractionDigits: targetDecimals,
    maximumFractionDigits: targetDecimals,
  });
}

const EMPTY_SIDE: ComparisonSide = { label: "", value: 0 };

export const ComparisonSplit: React.FC<ComparisonSplitProps> = ({
  left,
  right,
  mode = "bars",
  countUpDurationFrames = 30,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const fontFamily = useDoodleFont();
  const l = left ?? EMPTY_SIDE;
  const r = right ?? EMPTY_SIDE;
  const leftUrl = useOptionalAsset(l.assetId);
  const rightUrl = useOptionalAsset(r.assetId);

  const progress = interpolate(frame, [0, countUpDurationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const maxValue = Math.max(l.value, r.value, 1);

  const dividerSeed = seedFrom("cmp-div", l.label, r.label);
  const dividerPath = roughLinePath(
    width / 2,
    height * 0.14,
    width / 2,
    height * 0.86,
    dividerSeed,
    8,
    10
  );

  const font = `${fontFamily}, ${DOODLE_FONT_STACK}`;

  const renderSide = (
    side: ComparisonSide,
    url: string | undefined,
    accent: string,
    isLeft: boolean
  ) => {
    const shownValue = side.value * progress;
    const targetDecimals = decimalsOf(side.value);
    const centerX = isLeft ? width * 0.25 : width * 0.75;
    const seed = seedFrom("cmp", side.label, isLeft);

    // 数字とラベルは共通
    const numberEl = (
      <div
        style={{
          fontFamily: font,
          fontSize: height * 0.13,
          color: accent,
          lineHeight: 1,
          textShadow: "none",
          whiteSpace: "nowrap",
        }}
      >
        {formatNum(shownValue, targetDecimals)}
      </div>
    );
    const labelEl = (
      <div
        style={{
          fontFamily: font,
          fontSize: height * 0.055,
          color: PALETTE.ink,
          marginTop: height * 0.02,
          whiteSpace: "nowrap",
        }}
      >
        {side.label}
      </div>
    );

    if (mode === "count") {
      return (
        <div
          style={{
            position: "absolute",
            left: centerX,
            top: "50%",
            transform: "translate(-50%, -50%)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          {numberEl}
          {labelEl}
        </div>
      );
    }

    if (mode === "size") {
      const frac = side.value / maxValue;
      // 円+数字+ラベルの合計高さが字幕セーフゾーン(SUBTITLE_SAFE_BOTTOM_PCT)を
      // 超えないよう、ラベル下端を固定アンカーにして円の拡大方向を上向きだけにする
      // (中央寄せだと value が大きいほどラベルが字幕帯に沈み込んでいた)。
      const maxSize = height * 0.48;
      const sizePx = maxSize * (0.28 + 0.72 * frac) * (0.3 + 0.7 * progress);
      const anchorBottomFrac = SUBTITLE_SAFE_BOTTOM_PCT - 0.02;
      return (
        <div
          style={{
            position: "absolute",
            left: centerX,
            bottom: height * (1 - anchorBottomFrac),
            width: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <div
            style={{
              height: sizePx,
              width: sizePx,
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
            }}
          >
            {url ? (
              <img
                src={url}
                alt=""
                style={{ height: "100%", width: "100%", objectFit: "contain" }}
              />
            ) : (
              <svg width={sizePx} height={sizePx} viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="42"
                  fill={accent}
                  stroke={PALETTE.ink}
                  strokeWidth={4}
                />
              </svg>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: height * 0.015 }}>
            {numberEl}
            {labelEl}
          </div>
        </div>
      );
    }

    // mode === "bars"
    // ラベルは棒の下(baseY以深)に置くと字幕帯(SUBTITLE_SAFE_BOTTOM_PCT)と
    // 重なるため、数字と同じく棒の上に「数字→ラベル」の縦積みで置く。
    const maxBarH = height * 0.44;
    const barW = width * 0.16;
    const barH = maxBarH * (side.value / maxValue) * progress;
    const baseY = height * 0.8;
    const barX = centerX - barW / 2;
    const barTopY = baseY - barH;
    return (
      <div style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%" }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: "absolute", inset: 0 }}>
          {barH > 2 ? (
            <path
              d={roughRectPath(barX, barTopY, barW, barH, seed, 6)}
              fill={accent}
              stroke={PALETTE.ink}
              strokeWidth={7}
              strokeLinejoin="round"
            />
          ) : null}
        </svg>
        <div
          style={{
            position: "absolute",
            left: centerX,
            top: barTopY - height * 0.02,
            transform: "translate(-50%, -100%)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
          }}
        >
          {numberEl}
          {labelEl}
        </div>
      </div>
    );
  };

  // 手描きの boiling を薄く常時適用(カウントアップ完了後の完全静止=frozen_video QA落ち防止)。
  // 背景は外側に固定し、中身だけを ±0.5° / ±0.5% で揺らす(回転しても縁は見えない)。
  const boil = boiling(frame, fps, { seed: dividerSeed });
  return (
    <AbsoluteFill style={{ backgroundColor: PALETTE.paper }}>
      <AbsoluteFill style={{ transform: `rotate(${boil.rotate}deg) scale(${boil.scale})` }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: "absolute", inset: 0 }}>
          <path d={dividerPath} fill="none" stroke={PALETTE.ink} strokeWidth={5} strokeLinecap="round" opacity={0.75} />
        </svg>
        {renderSide(l, leftUrl, PALETTE.indigo, true)}
        {renderSide(r, rightUrl, PALETTE.red, false)}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
