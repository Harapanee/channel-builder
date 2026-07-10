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
 * ショート用タイトル/締めカード(縦型 1080x1920 前提)。
 * opening: お題の宣言。ending: 本編誘導CTA + creditNotice(音声クレジット義務)。
 * TitleCard と異なりタイトルの折返しを許容し、幅基準でサイズを決める。
 */
export type ShortTitleCardProps = {
  title: string;
  subtitle?: string;
  variant: "opening" | "ending";
  /** ending 用のクレジット表記(channel/voice.json の creditNotice) */
  creditNotice?: string;
};

export const ShortTitleCard: React.FC<ShortTitleCardProps> = ({
  title,
  subtitle,
  variant,
  creditNotice,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const fontFamily = useDoodleFont();
  const font = `${fontFamily}, ${DOODLE_FONT_STACK}`;
  const accent = variant === "ending" ? PALETTE.indigo : PALETTE.red;

  const title$ = popInHelper(frame, fps, { delayFrames: 2 });
  const underlineProgress = interpolate(frame, [10, 26], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const subOpacity = interpolate(frame, [16, 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const underlineSeed = seedFrom("short-title-underline", title);
  const ulW = width * 0.55;
  const underline = roughLinePath(0, 14, ulW, 14, underlineSeed, 6, 9);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: PALETTE.paper,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          transform: `scale(${title$.scale})`,
          opacity: title$.opacity,
          maxWidth: "88%",
        }}
      >
        <div
          style={{
            fontFamily: font,
            fontSize: width * 0.105,
            color: PALETTE.ink,
            lineHeight: 1.25,
            letterSpacing: "0.04em",
            textAlign: "center",
            WebkitTextStroke: `${Math.max(1, width * 0.001)}px ${PALETTE.ink}`,
          }}
        >
          {title}
        </div>
        <svg
          width={ulW}
          height={28}
          viewBox={`0 0 ${ulW} 28`}
          style={{ marginTop: height * 0.008 }}
        >
          <path
            d={underline}
            pathLength={100}
            fill="none"
            stroke={accent}
            strokeWidth={9}
            strokeLinecap="round"
            strokeDasharray={100}
            strokeDashoffset={100 * (1 - underlineProgress)}
          />
        </svg>
        {subtitle ? (
          <div
            style={{
              fontFamily: font,
              fontSize: width * 0.05,
              color: PALETTE.ink,
              marginTop: height * 0.02,
              opacity: subOpacity,
              textAlign: "center",
            }}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
      {variant === "ending" && creditNotice ? (
        <div
          style={{
            position: "absolute",
            bottom: height * 0.05,
            width: "100%",
            textAlign: "center",
            fontFamily: font,
            fontSize: width * 0.028,
            color: PALETTE.ink,
            opacity: subOpacity * 0.7,
          }}
        >
          {creditNotice}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
