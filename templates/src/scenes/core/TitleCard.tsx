import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { popIn as popInHelper, seedFrom } from "../../motion";
import { roughLinePath } from "../doodle-svg";
import { PALETTE } from "../style";
import { DOODLE_FONT_STACK, useDoodleFont } from "../use-doodle-font";

/**
 * §7.6 TitleCard — タイトル / 章見出し / エンドカード。
 * 太い手描き風タイトル(Yusei Magic)。ending は creditNotice を小さく表示。
 */
export type TitleCardProps = {
  title: string;
  subtitle?: string;
  variant: "opening" | "chapter" | "ending";
  /** ending 用のクレジット表記(例「voice.jsonのcreditNotice」) */
  creditNotice?: string;
  /**
   * chapter バリアントの小見出し(既定「章」)。空文字を渡すと非表示。
   * 既定は従来通り「章」なので非破壊(§9 ドキュメンタリー風カード用の追加)。
   */
  chapterLabel?: string;
  /**
   * 反転配色(黒背景・白文字)。既定 false=従来のオフホワイト背景。
   * s08「教育係、切腹。」のドキュメンタリー風の突き放し表現に使う(非破壊の追加)。
   */
  invert?: boolean;
};

export const TitleCard: React.FC<TitleCardProps> = ({
  title,
  subtitle,
  variant,
  creditNotice,
  chapterLabel,
  invert = false,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const fontFamily = useDoodleFont();
  const font = `${fontFamily}, ${DOODLE_FONT_STACK}`;

  // 文字数に応じて縮小し、語中改行を防ぐ(横幅の9割に1行で収める)
  const baseTitleSize =
    variant === "opening" ? height * 0.15 : height * 0.12;
  const maxByWidth = (width * 0.9) / Math.max(1, title.length);
  const titleSize = Math.min(baseTitleSize, maxByWidth);
  const accent = variant === "ending" ? PALETTE.indigo : PALETTE.red;
  const bg = invert ? PALETTE.ink : PALETTE.paper;
  const textColor = invert ? PALETTE.paper : PALETTE.ink;
  const kicker = chapterLabel === undefined ? "章" : chapterLabel;

  // タイトルのバウンス出現
  const title$ = popInHelper(frame, fps, { delayFrames: 2 });

  // 下線の描き起こし(タイトル出現後)
  const underlineProgress = interpolate(
    frame,
    [10, 28],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // subtitle / credit のフェードイン
  const subOpacity = interpolate(frame, [16, 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const underlineSeed = seedFrom("title-underline", title);
  const ulY = height * 0.03;
  const underline = roughLinePath(0, ulY, width * 0.42, ulY, underlineSeed, 6, 9);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: bg,
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
        }}
      >
        {variant === "chapter" && kicker ? (
          <div
            style={{
              fontFamily: font,
              fontSize: height * 0.045,
              color: accent,
              letterSpacing: "0.3em",
              marginBottom: height * 0.01,
            }}
          >
            {kicker}
          </div>
        ) : null}
        <div
          style={{
            fontFamily: font,
            fontSize: titleSize,
            color: textColor,
            lineHeight: 1.1,
            letterSpacing: "0.04em",
            textAlign: "center",
            whiteSpace: "nowrap",
            WebkitTextStroke: `${Math.max(1, titleSize * 0.01)}px ${textColor}`,
            padding: "0 4%",
          }}
        >
          {title}
        </div>

        {/* 手描き下線 */}
        <svg
          width={width * 0.42}
          height={height * 0.06}
          viewBox={`0 0 ${width * 0.42} ${height * 0.06}`}
          style={{ marginTop: height * 0.01 }}
        >
          <path
            d={underline}
            pathLength={100}
            fill="none"
            stroke={accent}
            strokeWidth={Math.max(6, height * 0.008)}
            strokeLinecap="round"
            strokeDasharray={100}
            strokeDashoffset={100 * (1 - underlineProgress)}
          />
        </svg>

        {subtitle ? (
          <div
            style={{
              fontFamily: font,
              fontSize: height * 0.05,
              color: textColor,
              marginTop: height * 0.025,
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
            bottom: height * 0.06,
            width: "100%",
            textAlign: "center",
            fontFamily: font,
            fontSize: height * 0.028,
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
