import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { boiling, popIn, seedFrom } from "../../motion";
import { roughClosedPath, roughLinePath } from "../doodle-svg";
import { PALETTE } from "../style";
import { DOODLE_FONT_STACK, useDoodleFont } from "../use-doodle-font";

/**
 * 共有スパイン(bible §4 固定アウトロ・チャンネル署名・全動画共通)。
 * 本編の締め(祝福回収)の後に毎回置く約6〜8秒のアウトロ。
 *
 * 内容: チャンネル名カード(手描き大文字・中央)→ 下部にクレジット表記 →
 * 終盤にゆっくりフェード暗転。固定ナレーションと BGM/SE は shots.json 側で
 * 設計する(このコンポーネントは絵のみ)。
 *
 * 内部タイムライン(既定・fps=30 / durationFrames=210 ≒ 7秒):
 *   0〜      カードが popIn で中央に出現(紙背景)
 *   credit〜 下部にクレジットがフェードイン
 *   終盤     durationFrames の手前でゆっくり暗転(ink 色)して締める
 */
export type OutroProps = {
  /** チャンネル名。カード中央に手描き大文字で表示 */
  channelName?: string;
  /** クレジット表記(voice.json の creditNotice)。空文字なら非表示 */
  creditNotice?: string;
  /** アウトロ全体のフレーム数(フェード暗転の基準)。既定 210(7秒) */
  durationFrames?: number;
  /** クレジットが出始めるフレーム。既定 40 */
  creditDelayFrames?: number;
  /** フェード暗転にかけるフレーム数。既定 55 */
  fadeDurationFrames?: number;
};

export const Outro: React.FC<OutroProps> = ({
  channelName = "チャンネル名", // チャンネル展開時に固有名へ調整(または shots.json 側で必ず渡す)
  creditNotice = "", // 例: voice.json の creditNotice を shots.json 側から渡す
  durationFrames = 210,
  creditDelayFrames = 40,
  fadeDurationFrames = 55,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const fontFamily = useDoodleFont();
  const font = `${fontFamily}, ${DOODLE_FONT_STACK}`;
  const seed = seedFrom("outro", width, height);

  // ---- チャンネル名カード(中央・手描き枠)-------------------------------
  const cardW = width * 0.74;
  const cardH = height * 0.34;
  const cardCx = width * 0.5;
  const cardCy = height * 0.44;
  const cardIn = popIn(frame, fps, { delayFrames: 4 });
  const boil = boiling(frame, fps, { seed });

  // Catmull-Rom 平滑化で角が丸まりすぎないよう、各辺に中間点を挿入して
  // 「角の立った手描きカード」にする(TruckIsekai と同じ手当て)。
  const subdivide = (
    corners: Array<[number, number]>,
    step: number
  ): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < corners.length; i++) {
      const [x1, y1] = corners[i];
      const [x2, y2] = corners[(i + 1) % corners.length];
      const len = Math.hypot(x2 - x1, y2 - y1);
      const n = Math.max(1, Math.round(len / step));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        out.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
      }
    }
    return out;
  };
  const cardPath = roughClosedPath(
    subdivide(
      [
        [cardCx - cardW / 2, cardCy - cardH / 2],
        [cardCx + cardW / 2, cardCy - cardH / 2],
        [cardCx + cardW / 2, cardCy + cardH / 2],
        [cardCx - cardW / 2, cardCy + cardH / 2],
      ],
      110
    ),
    seed ^ 0x0c,
    7
  );

  // チャンネル名が長くてもカードに収まるフォントサイズ(手描き大文字)
  const nameLen = Math.max(1, channelName.length);
  const nameSize = Math.min(height * 0.1, (cardW * 0.88) / nameLen);

  // カード内・チャンネル名の下の手描き下線
  const underlineY = cardCy + cardH * 0.24;
  const underline = roughLinePath(
    cardCx - cardW * 0.32,
    underlineY,
    cardCx + cardW * 0.32,
    underlineY,
    seed ^ 0x1d,
    4,
    10
  );
  const underlineIn = interpolate(
    frame,
    [16, 16 + fps * 0.4],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // ---- クレジット(下部)-------------------------------------------------
  const creditOpacity = interpolate(
    frame,
    [creditDelayFrames, creditDelayFrames + fps * 0.5],
    [0, 0.85],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // ---- 終盤のゆっくり暗転(ink 色・パレット準拠)-------------------------
  const fadeStart = Math.max(0, durationFrames - fadeDurationFrames - 6);
  const dark = interpolate(frame, [fadeStart, fadeStart + fadeDurationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: PALETTE.paper }}>
      {/* --- チャンネル名カード --- */}
      <AbsoluteFill
        style={{
          opacity: cardIn.opacity,
          transform: `scale(${cardIn.scale * boil.scale}) rotate(${boil.rotate}deg)`,
          transformOrigin: `${cardCx}px ${cardCy}px`,
        }}
      >
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ position: "absolute", inset: 0, overflow: "visible" }}
        >
          <path
            d={cardPath}
            fill={PALETTE.paper}
            stroke={PALETTE.ink}
            strokeWidth={10}
            strokeLinejoin="round"
          />
          {underlineIn > 0.01 ? (
            <path
              d={underline}
              fill="none"
              stroke={PALETTE.red}
              strokeWidth={7}
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={100}
              strokeDashoffset={(1 - underlineIn) * 100}
            />
          ) : null}
        </svg>
        <div
          style={{
            position: "absolute",
            left: cardCx,
            top: cardCy - cardH * 0.06,
            transform: "translate(-50%, -50%)",
            fontFamily: font,
            fontSize: nameSize,
            fontWeight: 400,
            color: PALETTE.ink,
            whiteSpace: "nowrap",
            letterSpacing: "0.02em",
          }}
        >
          {channelName}
        </div>
      </AbsoluteFill>

      {/* --- クレジット(下部) --- */}
      {creditNotice && creditOpacity > 0.01 ? (
        <div
          style={{
            position: "absolute",
            left: "50%",
            // 字幕帯(画面下端~12%)と重ならない高さに置く(クレジットはライセンス義務表記)
            top: height * 0.8,
            transform: "translate(-50%, -50%)",
            fontFamily: font,
            fontSize: height * 0.034,
            color: PALETTE.ink,
            opacity: creditOpacity,
            whiteSpace: "nowrap",
          }}
        >
          {creditNotice}
        </div>
      ) : null}

      {/* --- ゆっくりフェード暗転 --- */}
      {dark > 0.005 ? (
        <AbsoluteFill
          style={{ backgroundColor: PALETTE.ink, opacity: dark, pointerEvents: "none" }}
        />
      ) : null}
    </AbsoluteFill>
  );
};
