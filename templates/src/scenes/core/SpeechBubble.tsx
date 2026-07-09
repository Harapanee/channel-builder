import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { boilStep, popIn as popInHelper, seedFrom } from "../../motion";
import { roughBurstPath, roughCloudPath, roughEllipsePath } from "../doodle-svg";
import { PALETTE } from "../style";
import { DOODLE_FONT_STACK, useDoodleFont } from "../use-doodle-font";

/**
 * §7.6 SpeechBubble — 手描き風の歪んだ吹き出し。
 * speech(揺れた楕円)/ shout(ギザギザ)/ thought(もくもく雲)。
 * 輪郭はシード付きジッタの SVG path、テキストは Yusei Magic。
 */
export type SpeechBubbleProps = {
  text: string;
  /** 中心の水平位置(%)。既定 50 */
  xPct?: number;
  /** 中心の垂直位置(%)。既定 30 */
  yPct?: number;
  /** 幅(キャンバス幅に対する %)。既定 32 */
  widthPct?: number;
  /** しっぽの向き。既定 "left" */
  tail?: "left" | "right" | "none";
  /** 種類。既定 "speech" */
  style?: "speech" | "shout" | "thought";
  /** 出現フレーム。既定 0 */
  appearFrame?: number;
  /** バウンス出現するか。既定 true */
  popIn?: boolean;
};

export const SpeechBubble: React.FC<SpeechBubbleProps> = ({
  text,
  xPct = 50,
  yPct = 30,
  widthPct = 32,
  tail = "left",
  style = "speech",
  appearFrame = 0,
  popIn = true,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const fontFamily = useDoodleFont();

  const seed = seedFrom("bubble", text, xPct, yPct, style);
  const step = boilStep(frame, fps, 6);
  const pathSeed = seed ^ step; // 輪郭を ~6fps でコマ変わりさせて boiling

  const bodyAspect = style === "shout" ? 0.82 : style === "thought" ? 0.64 : 0.6;
  const tailZone = tail === "none" ? 4 : 15;
  const vbW = 100;
  const bodyH = 100 * bodyAspect;
  const vbH = bodyH + tailZone;

  const cx = 50;
  const cy = bodyH / 2 + 2;
  const rx = 45;
  const ry = bodyH / 2 - 3;

  // 輪郭パス
  let outline: string;
  if (style === "shout") {
    // ギザギザ爆発。内径を広めにとって中心のテキスト域を確保する。
    outline = roughBurstPath(cx, cy, rx * 0.98, ry * 0.78, pathSeed, 18);
  } else if (style === "thought") {
    outline = roughCloudPath(cx, cy, rx, ry, pathSeed, 9);
  } else {
    outline = roughEllipsePath(cx, cy, rx, ry, pathSeed, 0.06, 16);
  }

  // しっぽ(bodyの下端から下へ)。ellipse/cloudのfillが上端を覆う。
  let tailPath = "";
  if (tail !== "none" && style !== "thought") {
    const baseX = tail === "left" ? 40 : 60;
    const tipX = tail === "left" ? 30 : 70;
    const y0 = cy + ry - 4;
    tailPath = `M ${baseX - 6} ${y0} L ${tipX} ${vbH - 1} L ${baseX + 6} ${y0} Z`;
  }

  // 出現アニメ
  let scale = 1;
  let opacity = 1;
  if (popIn) {
    const r = popInHelper(frame, fps, { delayFrames: appearFrame });
    scale = r.scale;
    opacity = r.opacity;
  } else {
    opacity = frame >= appearFrame ? 1 : 0;
  }

  const boxWidthPx = (widthPct / 100) * width;
  const boxHeightPx = boxWidthPx * (vbH / 100);
  const bodyRegionPx = boxHeightPx * (bodyH / vbH);
  // 線幅は viewBox スケールに依存しない実px(non-scaling-stroke)
  const strokeWidthPx = style === "shout" ? 11 : 8;

  // テキストの安全域(輪郭の棘や縁に被らない内側の矩形)
  const safe =
    style === "shout"
      ? { w: 0.54, h: 0.52 }
      : style === "thought"
        ? { w: 0.66, h: 0.62 }
        : { w: 0.74, h: 0.7 };
  // 画面外はみ出し防止: バブル中心をフレーム内へクランプする(人の頭の中Factory発の修正)。
  // shout は棘が box 外へ描かれる(overflow:visible)ため余白を上乗せする。
  const spikeMarginPx =
    style === "shout"
      ? Math.max(strokeWidthPx * 2, boxHeightPx * 0.08)
      : strokeWidthPx;
  const halfWpct = ((boxWidthPx / 2 + spikeMarginPx) / width) * 100;
  const halfHpct = ((boxHeightPx / 2 + spikeMarginPx) / height) * 100;
  const clampVal = (v: number, lo: number, hi: number) =>
    hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
  const clampedXPct = clampVal(xPct, halfWpct, 100 - halfWpct);
  const clampedYPct = clampVal(yPct, halfHpct, 100 - halfHpct);

  const bodyCenterFrac = cy / vbH;
  const safeWpx = boxWidthPx * safe.w;
  const safeHpx = bodyRegionPx * safe.h;
  // 文字数による自動縮小: 行折り返しを実際にシミュレーションし、全行が
  // 安全領域に収まる最大フォントを探す(CJK=等幅前提、lineHeight 1.3)。
  // 面積ベースの近似は行の量子化(4文字/行×3行など)で破綻するため使わない。
  const charCount = Math.max(1, text.length);
  const baseFontSize =
    style === "shout"
      ? Math.min(safeHpx * 0.26, safeWpx * 0.24)
      : Math.min(safeHpx * 0.44, safeWpx * 0.34);
  const fitsAt = (fs: number) => {
    const perLine = Math.max(1, Math.floor(safeWpx / fs));
    const lines = Math.ceil(charCount / perLine);
    return lines * fs * 1.3 <= safeHpx && fs <= safeWpx;
  };
  let fitted = baseFontSize;
  while (fitted > 14 && !fitsAt(fitted)) fitted -= 2;
  const fontSize = Math.max(14, fitted);

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: `${clampedXPct}%`,
          top: `${clampedYPct}%`,
          width: boxWidthPx,
          height: boxHeightPx,
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: "50% 90%",
          opacity,
        }}
      >
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${vbW} ${vbH}`}
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: 0, overflow: "visible" }}
        >
          {tailPath ? (
            <path
              d={tailPath}
              fill={PALETTE.paper}
              stroke={PALETTE.ink}
              strokeWidth={strokeWidthPx}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          <path
            d={outline}
            fill={PALETTE.paper}
            stroke={PALETTE.ink}
            strokeWidth={strokeWidthPx}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {style === "thought" && tail !== "none" ? (
            <>
              <circle
                cx={tail === "left" ? 34 : 66}
                cy={bodyH + 4}
                r={4.2}
                fill={PALETTE.paper}
                stroke={PALETTE.ink}
                strokeWidth={strokeWidthPx}
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={tail === "left" ? 28 : 72}
                cy={bodyH + 11}
                r={2.6}
                fill={PALETTE.paper}
                stroke={PALETTE.ink}
                strokeWidth={strokeWidthPx}
                vectorEffect="non-scaling-stroke"
              />
            </>
          ) : null}
        </svg>
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: `${bodyCenterFrac * 100}%`,
            width: safeWpx,
            height: safeHpx,
            transform: "translate(-50%, -50%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxSizing: "border-box",
            textAlign: "center",
            color: PALETTE.ink,
            fontFamily: `${fontFamily}, ${DOODLE_FONT_STACK}`,
            fontSize,
            lineHeight: 1.18,
            letterSpacing: "0.02em",
            wordBreak: "break-word",
            overflow: "hidden",
          }}
        >
          {text}
        </div>
      </div>
    </AbsoluteFill>
  );
};
