import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { boilStep, popIn as popInHelper, seedFrom } from "../../motion";
import { roughArrow, roughCirclePath } from "../doodle-svg";
import { PALETTE, type PaletteColor } from "../style";
import { DOODLE_FONT_STACK, useDoodleFont } from "../use-doodle-font";
import { useOptionalAsset } from "../asset-context";

/**
 * §7.6 DoodleMap — SVG地図の上でのカメラ移動(ズーム/パン)と
 * オーバーレイ(危険円・ラベル・進軍矢印)。
 * svgAssetId が無い場合は無地の紙背景として機能する
 * (地図SVGはエピソード制作時に素材として追加される)。
 */
type CameraPose = { xPct: number; yPct: number; zoom: number };
type MapCamera = {
  from: CameraPose;
  to: CameraPose;
  startFrame: number;
  durationFrames: number;
};

type DangerOverlay = {
  type: "dangerCircle";
  xPct: number;
  yPct: number;
  appearFrame?: number;
  radiusPct?: number;
  color?: PaletteColor;
};
type LabelOverlay = {
  type: "label";
  xPct: number;
  yPct: number;
  appearFrame?: number;
  text: string;
  color?: PaletteColor;
};
type ArrowOverlay = {
  type: "arrowMove";
  xPct: number;
  yPct: number;
  appearFrame?: number;
  toXPct: number;
  toYPct: number;
  color?: PaletteColor;
};
type MapOverlay = DangerOverlay | LabelOverlay | ArrowOverlay;

export type DoodleMapProps = {
  svgAssetId?: string;
  backgroundColor?: string;
  camera?: MapCamera;
  overlays?: MapOverlay[];
};

const drawOn = (frame: number, appearFrame: number, len = 14) =>
  interpolate(frame, [appearFrame, appearFrame + len], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

export const DoodleMap: React.FC<DoodleMapProps> = ({
  svgAssetId,
  backgroundColor,
  camera,
  overlays = [],
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const fontFamily = useDoodleFont();
  const mapUrl = useOptionalAsset(svgAssetId);
  const font = `${fontFamily}, ${DOODLE_FONT_STACK}`;

  // ---- カメラ(transform) ----------------------------------------------
  let cam: CameraPose = { xPct: 50, yPct: 50, zoom: 1 };
  if (camera) {
    const t = interpolate(
      frame,
      [camera.startFrame, camera.startFrame + camera.durationFrames],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
    cam = {
      xPct: interpolate(t, [0, 1], [camera.from.xPct, camera.to.xPct]),
      yPct: interpolate(t, [0, 1], [camera.from.yPct, camera.to.yPct]),
      zoom: interpolate(t, [0, 1], [camera.from.zoom, camera.to.zoom]),
    };
  }
  const camTransform = `scale(${cam.zoom}) translate(${50 - cam.xPct}%, ${50 - cam.yPct}%)`;

  return (
    <AbsoluteFill style={{ backgroundColor: backgroundColor ?? PALETTE.paper }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: camTransform,
          transformOrigin: "50% 50%",
        }}
      >
        {mapUrl ? (
          <img
            src={mapUrl}
            alt=""
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "contain",
            }}
          />
        ) : null}

        {/* ベクターオーバーレイ(円・矢印)を1枚のSVGに */}
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ position: "absolute", inset: 0, overflow: "visible" }}
        >
          {overlays.map((ov, i) => {
            const appear = ov.appearFrame ?? 0;
            if (ov.type === "dangerCircle") {
              const cx = (ov.xPct / 100) * width;
              const cy = (ov.yPct / 100) * height;
              const r = ((ov.radiusPct ?? 12) / 100) * height;
              const seed = seedFrom("map-danger", i, ov.xPct, ov.yPct);
              const step = boilStep(frame, fps, 8);
              const p = drawOn(frame, appear, 16);
              return (
                <path
                  key={`c${i}`}
                  d={roughCirclePath(cx, cy, r, seed ^ step, 0.05)}
                  pathLength={100}
                  fill="none"
                  stroke={PALETTE[ov.color ?? "red"]}
                  strokeWidth={Math.max(6, r * 0.1)}
                  strokeLinecap="round"
                  strokeDasharray={100}
                  strokeDashoffset={100 * (1 - p)}
                />
              );
            }
            if (ov.type === "arrowMove") {
              const x1 = (ov.xPct / 100) * width;
              const y1 = (ov.yPct / 100) * height;
              const x2 = (ov.toXPct / 100) * width;
              const y2 = (ov.toYPct / 100) * height;
              const seed = seedFrom("map-arrow", i, ov.xPct, ov.toXPct);
              const { shaft, head } = roughArrow(x1, y1, x2, y2, seed, 40);
              const p = drawOn(frame, appear, 16);
              const col = PALETTE[ov.color ?? "indigo"];
              return (
                <g key={`a${i}`}>
                  <path
                    d={shaft}
                    pathLength={100}
                    fill="none"
                    stroke={col}
                    strokeWidth={12}
                    strokeLinecap="round"
                    strokeDasharray={100}
                    strokeDashoffset={100 * (1 - p)}
                  />
                  <path
                    d={head}
                    fill="none"
                    stroke={col}
                    strokeWidth={12}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={p > 0.85 ? 1 : 0}
                  />
                </g>
              );
            }
            return null;
          })}
        </svg>

        {/* ラベル(テキスト) */}
        {overlays.map((ov, i) => {
          if (ov.type !== "label") return null;
          const appear = ov.appearFrame ?? 0;
          const { scale, opacity } = popInHelper(frame, fps, {
            delayFrames: appear,
          });
          return (
            <div
              key={`l${i}`}
              style={{
                position: "absolute",
                left: `${ov.xPct}%`,
                top: `${ov.yPct}%`,
                transform: `translate(-50%, -50%) scale(${scale})`,
                opacity,
                display: "flex",
                alignItems: "center",
                gap: "0.4em",
                background: PALETTE.paper,
                border: `3px solid ${PALETTE.ink}`,
                borderRadius: 8,
                padding: "0.2em 0.6em",
                fontFamily: font,
                fontSize: height * 0.04,
                color: PALETTE[ov.color ?? "ink"],
                whiteSpace: "nowrap",
              }}
            >
              <span
                style={{
                  width: "0.5em",
                  height: "0.5em",
                  borderRadius: "50%",
                  background: PALETTE.red,
                  display: "inline-block",
                }}
              />
              {ov.text}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
