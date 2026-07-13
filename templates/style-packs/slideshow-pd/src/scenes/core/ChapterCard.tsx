import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { safeInterpolate } from "../../motion";
import { MINCHO_FONT_STACK, PALETTE } from "../style";

/**
 * ChapterCard — 章カード(bible §8)。
 *
 * band色背景+明朝体白文字+深紅の細罫(横線)。静かなフェードインのみで
 * 誇張しない(ドキュメンタリーの静けさ)。SEはショット側(shots.json の sfx)で付与。
 */
export type ChapterCardProps = {
  /** 章番号。数値は「第一章」表記へ変換。文字列(「序章」「終章」等)はそのまま使う */
  chapterNo: number | string;
  title: string;
  subtitle?: string;
};

/** 1〜99 を漢数字へ(第X章の表記用)。 */
function toKanjiNumber(n: number): string {
  const digits = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (!Number.isFinite(n) || n <= 0 || n >= 100 || !Number.isInteger(n)) {
    return String(n);
  }
  if (n < 10) return digits[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${tens > 1 ? digits[tens] : ""}十${digits[ones]}`;
}

export const ChapterCard: React.FC<ChapterCardProps> = ({
  chapterNo,
  title,
  subtitle,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const kicker =
    typeof chapterNo === "number" ? `第${toKanjiNumber(chapterNo)}章` : chapterNo;

  // 静かなフェードイン(章番号 → 罫 → タイトル → サブタイトルの順に僅かに遅らせる)
  const fade = (delaySec: number) =>
    safeInterpolate(
      frame,
      [delaySec * fps, (delaySec + 0.8) * fps],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
  const kickerOpacity = fade(0.1);
  const ruleOpacity = fade(0.35);
  const titleOpacity = fade(0.5);
  const subOpacity = fade(0.9);

  // 深紅の細罫が中央から静かに伸びる
  const ruleScale = safeInterpolate(
    frame,
    [0.35 * fps, 1.2 * fps],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // タイトルが長くても1行で収まるよう縮小(横幅の8割)
  const baseTitleSize = height * 0.085;
  const maxByWidth = (width * 0.8) / Math.max(1, title.length);
  const titleSize = Math.min(baseTitleSize, maxByWidth);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: PALETTE.band,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <div
          style={{
            fontFamily: MINCHO_FONT_STACK,
            fontSize: height * 0.04,
            color: PALETTE.sepia,
            letterSpacing: "0.5em",
            // letter-spacing は末尾にも付くため、中央揃えの見た目を保つ補正
            paddingLeft: "0.5em",
            opacity: kickerOpacity,
          }}
        >
          {kicker}
        </div>

        {/* 深紅の細罫(横線) */}
        <div
          style={{
            width: width * 0.14,
            height: Math.max(2, height * 0.003),
            backgroundColor: PALETTE.red,
            marginTop: height * 0.035,
            marginBottom: height * 0.045,
            opacity: ruleOpacity,
            transform: `scaleX(${ruleScale})`,
          }}
        />

        <div
          style={{
            fontFamily: MINCHO_FONT_STACK,
            fontSize: titleSize,
            fontWeight: 600,
            color: "#F2EFE6",
            letterSpacing: "0.12em",
            paddingLeft: "0.12em",
            whiteSpace: "nowrap",
            textAlign: "center",
            opacity: titleOpacity,
          }}
        >
          {title}
        </div>

        {subtitle ? (
          <div
            style={{
              fontFamily: MINCHO_FONT_STACK,
              fontSize: height * 0.032,
              color: PALETTE.sepia,
              letterSpacing: "0.2em",
              paddingLeft: "0.2em",
              marginTop: height * 0.04,
              textAlign: "center",
              opacity: subOpacity,
            }}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
