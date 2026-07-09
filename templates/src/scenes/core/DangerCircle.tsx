import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { boilStep, seedFrom, steppedNoise } from "../../motion";
import { roughCirclePath } from "../doodle-svg";
import { PALETTE, type PaletteColor } from "../style";

/**
 * §7.6 DangerCircle — 手描きの一筆書き赤円で危険・包囲・強調を示す(bible.md §8「危険」)。
 * strokeDasharray/offset で描き起こしアニメ、tremble で線の震え。
 */
export type DangerCircleProps = {
  /** 円の中心(キャンバス幅に対する %)。既定 50 */
  xPct?: number;
  /** 円の中心(キャンバス高さに対する %)。既定 50 */
  yPct?: number;
  /** 半径(キャンバス高さに対する %)。既定 22 */
  radiusPct?: number;
  /** 一筆書きの描画フレーム数。既定 18 */
  drawDurationFrames?: number;
  /** 震え 0-1。既定 0.4 */
  tremble?: number;
  /** 色。パレット名(既定 "red") */
  color?: PaletteColor;
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export const DangerCircle: React.FC<DangerCircleProps> = ({
  xPct = 50,
  yPct = 50,
  radiusPct = 22,
  drawDurationFrames = 18,
  tremble = 0.4,
  color = "red",
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const cx = (xPct / 100) * width;
  const cy = (yPct / 100) * height;
  const r = (radiusPct / 100) * height;
  const stroke = PALETTE[color] ?? PALETTE.red;
  const strokeWidth = Math.max(8, r * 0.09);

  const t = clamp01(tremble);
  const baseSeed = seedFrom("danger", xPct, yPct, radiusPct);

  // 線自体を ~8fps でコマ変わりさせて手描きの震えを出す
  const step = boilStep(frame, fps, 8);
  const wobble = 0.03 + 0.05 * t;
  const path = roughCirclePath(cx, cy, r, baseSeed ^ step, wobble);

  // 描き起こし: strokeDashoffset を 100 → 0(pathLength="100" 正規化)
  const progress = interpolate(frame, [0, drawDurationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const dashOffset = 100 * (1 - progress);

  // 全体のわずかな揺れ
  const tx = steppedNoise(baseSeed ^ 0x77, frame, fps, 8) * 4 * t;
  const ty = steppedNoise(baseSeed ^ 0x88, frame, fps, 8) * 4 * t;

  return (
    <AbsoluteFill>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ transform: `translate(${tx}px, ${ty}px)` }}
      >
        <path
          d={path}
          pathLength={100}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={100}
          strokeDashoffset={dashOffset}
        />
      </svg>
    </AbsoluteFill>
  );
};
