import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import {
  boiling,
  bounceIdle,
  fallImpact,
  popIn,
  seedFrom,
  shake,
  slideIn,
} from "../../motion";
import { PALETTE, type PaletteColor } from "../style";
import { useOptionalAsset } from "../asset-context";

/**
 * §7.6 DoodleCharacter — 透過PNGのキャラクターを配置し、
 * 出現(entrance)/待機・振動(motion)/手描き揺らぎ(boiling 常時)を与える。
 *
 * props はすべて shots.json の scene.props として JSON 直列化可能。
 */
export type DoodleCharacterProps = {
  /** library.json の assetId(透過PNG)。未指定なら空プレースホルダ表示 */
  assetId?: string;
  /** 画像ボックス中心の水平位置(キャンバス幅に対する %)。既定 50 */
  xPct?: number;
  /** 画像ボックス中心の垂直位置(キャンバス高さに対する %)。既定 62 */
  yPct?: number;
  /** キャラ画像の高さ(キャンバス高さに対する %)。既定 40 */
  heightPct?: number;
  /** 左右反転 */
  flip?: boolean;
  /** 出現演出 */
  entrance?: "popIn" | "slideInLeft" | "slideInRight" | "fallIn" | "none";
  /** 出現の遅延フレーム */
  entranceDelayFrames?: number;
  /** 常時モーション */
  motion?: "idle" | "shake" | "none";
  /** モーション強度 0-1(既定 1) */
  motionIntensity?: number;
  /**
   * 背後に手描きの放射光(サンバースト)を敷く。パレット色名を渡すと有効。
   * 未指定(既定)なら描かない=既存挙動と同一(非破壊の追加プロップ)。
   * bible §8「希望: 黄色の光」のモチーフ表現に使う(s11 偽の希望 / s17 本物)。
   */
  haloColor?: PaletteColor;
  /** 放射光の広がり(キャンバス高さに対する半径 %)。既定 34 */
  haloRadiusPct?: number;
  /** 放射光の出現遅延フレーム。既定 0 */
  haloDelayFrames?: number;
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export const DoodleCharacter: React.FC<DoodleCharacterProps> = ({
  assetId,
  xPct = 50,
  yPct = 62,
  heightPct = 40,
  flip = false,
  entrance = "none",
  entranceDelayFrames = 0,
  motion = "none",
  motionIntensity = 1,
  haloColor,
  haloRadiusPct = 34,
  haloDelayFrames = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  // assetId 未指定なら undefined(空プレースホルダにフォールバック)。
  // 指定されているのに library.json に無い場合は useOptionalAsset が明確なエラーを投げる。
  const url = useOptionalAsset(assetId);

  const seed = seedFrom("char", assetId, xPct, yPct, heightPct);
  const intensity = clamp01(motionIntensity);

  // 手描き揺らぎ(常時薄く)
  const boil = boiling(frame, fps, { seed });

  // ---- 出現 -------------------------------------------------------------
  let entranceTransform = "";
  let entranceOpacity = 1;
  const delay = entranceDelayFrames;
  if (entrance === "popIn") {
    const { scale, opacity } = popIn(frame, fps, { delayFrames: delay });
    entranceTransform = `scale(${scale})`;
    entranceOpacity = opacity;
  } else if (entrance === "slideInLeft") {
    const { x, y, opacity } = slideIn(frame, fps, {
      direction: "left",
      delayFrames: delay,
    });
    entranceTransform = `translate(${x}px, ${y}px)`;
    entranceOpacity = opacity;
  } else if (entrance === "slideInRight") {
    const { x, y, opacity } = slideIn(frame, fps, {
      direction: "right",
      delayFrames: delay,
    });
    entranceTransform = `translate(${x}px, ${y}px)`;
    entranceOpacity = opacity;
  } else if (entrance === "fallIn") {
    const { y, scaleX, scaleY, opacity } = fallImpact(frame, fps, {
      startFrame: delay,
    });
    entranceTransform = `translateY(${y}px) scale(${scaleX}, ${scaleY})`;
    entranceOpacity = opacity;
  }

  // ---- 常時モーション ---------------------------------------------------
  let motionTransform = "";
  if (motion === "idle") {
    const { y, scaleX, scaleY } = bounceIdle(frame, fps, {
      seed,
      amplitudePx: 7 * intensity,
      breathPct: 1.6 * intensity,
    });
    motionTransform = `translateY(${y}px) scale(${scaleX}, ${scaleY})`;
  } else if (motion === "shake") {
    const { x, y, rotate } = shake(frame, fps, {
      seed,
      intensityPx: 16 * intensity,
      rotDeg: 4 * intensity,
      hz: 20,
    });
    motionTransform = `translate(${x}px, ${y}px) rotate(${rotate}deg)`;
  }

  const boxPx = (heightPct / 100) * height;
  const origin = "50% 88%"; // 足元を基点に拡縮・揺れ

  // ---- 放射光(サンバースト)----------------------------------------------
  // 手描きの太い三角形の光条を中心から放射する。グラデーション不使用の平面色。
  let halo: React.ReactNode = null;
  if (haloColor) {
    const cx = (xPct / 100) * width;
    const cy = (yPct / 100) * height;
    const rMax = (haloRadiusPct / 100) * height;
    const haloIn = popIn(frame, fps, { delayFrames: haloDelayFrames });
    // ゆっくり回転 + 呼吸で「輝いている」感じを出す
    const spinDeg = (frame / fps) * 12;
    const breathe = 1 + 0.05 * Math.sin((frame / fps) * Math.PI * 2 * 0.9);
    const rays = 16;
    const rayNodes: React.ReactNode[] = [];
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2;
      const long = i % 2 === 0;
      const len = (long ? rMax : rMax * 0.66) * breathe;
      const halfW = ((long ? 0.11 : 0.07) * Math.PI) / 1; // 角幅
      const inner = rMax * 0.12;
      const p0x = cx + Math.cos(a) * len;
      const p0y = cy + Math.sin(a) * len;
      const p1x = cx + Math.cos(a - halfW) * inner;
      const p1y = cy + Math.sin(a - halfW) * inner;
      const p2x = cx + Math.cos(a + halfW) * inner;
      const p2y = cy + Math.sin(a + halfW) * inner;
      rayNodes.push(
        <path
          key={i}
          d={`M ${p0x.toFixed(1)} ${p0y.toFixed(1)} L ${p1x.toFixed(1)} ${p1y.toFixed(1)} L ${p2x.toFixed(1)} ${p2y.toFixed(1)} Z`}
          fill={PALETTE[haloColor]}
          opacity={long ? 0.9 : 0.6}
        />
      );
    }
    halo = (
      <AbsoluteFill style={{ opacity: haloIn.opacity }}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{
            position: "absolute",
            inset: 0,
            transform: `rotate(${spinDeg}deg) scale(${haloIn.scale})`,
            transformOrigin: `${cx}px ${cy}px`,
          }}
        >
          <circle cx={cx} cy={cy} r={rMax * 0.14} fill={PALETTE[haloColor]} opacity={0.85} />
          {rayNodes}
        </svg>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill>
      {halo}
      <div
        style={{
          position: "absolute",
          left: `${xPct}%`,
          top: `${yPct}%`,
          width: boxPx,
          height: boxPx,
          transform: "translate(-50%, -50%)",
          opacity: entranceOpacity,
        }}
      >
        <div style={{ width: "100%", height: "100%", transform: entranceTransform, transformOrigin: origin }}>
          <div style={{ width: "100%", height: "100%", transform: motionTransform, transformOrigin: origin }}>
            <div
              style={{
                width: "100%",
                height: "100%",
                transform: `rotate(${boil.rotate}deg) scale(${boil.scale})`,
                transformOrigin: origin,
              }}
            >
              {url ? (
                <img
                  src={url}
                  alt=""
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    transform: flip ? "scaleX(-1)" : undefined,
                    imageRendering: "auto",
                    display: "block",
                  }}
                />
              ) : (
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    border: `4px dashed ${PALETTE.ink}`,
                    borderRadius: 16,
                    boxSizing: "border-box",
                    opacity: 0.35,
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
