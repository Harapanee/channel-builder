import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { popIn as popInHelper, seedFrom } from "../../../motion";
import { roughLinePath } from "../../doodle-svg";
import { PALETTE } from "../../style";
import { DOODLE_FONT_STACK, useDoodleFont } from "../../use-doodle-font";

/**
 * ショート用ランキング見出し(縦型 1080x1920 前提)。
 * 「第N位」を大きくポップイン → 手描き下線 → お題タイトルの順に出す。
 * 1位はアクセントを赤に格上げする。文字サイズは幅基準(縦長画面対策)。
 */
export type RankCardProps = {
  /** 順位(1〜) */
  rank: number;
  /** お題(例「エサが回ってこない」) */
  title: string;
  subtitle?: string;
  /** 見出しラベル。既定は「第{rank}位」 */
  rankLabel?: string;
};

export const RankCard: React.FC<RankCardProps> = ({
  rank,
  title,
  subtitle,
  rankLabel,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const fontFamily = useDoodleFont();
  const font = `${fontFamily}, ${DOODLE_FONT_STACK}`;
  const accent = rank === 1 ? PALETTE.red : PALETTE.indigo;
  const label = rankLabel ?? `第${rank}位`;

  const rank$ = popInHelper(frame, fps, { delayFrames: 2 });
  const underlineProgress = interpolate(frame, [10, 24], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const title$ = popInHelper(frame, fps, { delayFrames: 12 });
  const subOpacity = interpolate(frame, [22, 34], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const labelSize = width * 0.2;
  const underlineSeed = seedFrom("rank-underline", `${rank}-${title}`);
  const ulW = width * 0.6;
  const underline = roughLinePath(0, 14, ulW, 14, underlineSeed, 6, 9);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: PALETTE.paper,
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          fontFamily: font,
          fontSize: labelSize,
          color: accent,
          lineHeight: 1,
          transform: `scale(${rank$.scale})`,
          opacity: rank$.opacity,
          WebkitTextStroke: `${Math.max(2, labelSize * 0.012)}px ${accent}`,
          letterSpacing: "0.02em",
        }}
      >
        {label}
      </div>
      <svg
        width={ulW}
        height={28}
        viewBox={`0 0 ${ulW} 28`}
        style={{ marginTop: height * 0.012 }}
      >
        <path
          d={underline}
          pathLength={100}
          fill="none"
          stroke={accent}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={100}
          strokeDashoffset={100 * (1 - underlineProgress)}
        />
      </svg>
      <div
        style={{
          fontFamily: font,
          fontSize: width * 0.09,
          color: PALETTE.ink,
          marginTop: height * 0.03,
          lineHeight: 1.3,
          textAlign: "center",
          maxWidth: "86%",
          transform: `scale(${title$.scale})`,
          opacity: title$.opacity,
        }}
      >
        {title}
      </div>
      {subtitle ? (
        <div
          style={{
            fontFamily: font,
            fontSize: width * 0.045,
            color: PALETTE.ink,
            marginTop: height * 0.015,
            opacity: subOpacity,
            textAlign: "center",
            maxWidth: "86%",
          }}
        >
          {subtitle}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
