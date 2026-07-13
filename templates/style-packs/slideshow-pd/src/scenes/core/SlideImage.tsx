import React from "react";
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig } from "remotion";
import { safeInterpolate } from "../../motion";
import { PALETTE } from "../style";
import { useAsset } from "../asset-context";

/**
 * SlideImage — このチャンネルの主力(bible §8 高密度スライドショー。全ショットの8割)。
 *
 * フルフレーム画像+緩やかな Ken Burns(ズーム/パン)。上下黒帯・字幕は
 * Episode.tsx のオーバーレイが重畳するため、ここでは帯を意識せず全面に描く。
 * 画像は library.json 登録済み(人間キュレーション)の assetId のみ参照できる。
 */
export type SlideImageProps = {
  /** library.json 登録済み画像の assetId(未登録参照は useAsset が明確に落とす) */
  assetId: string;
  /** 既定 cover(全面)。contain は余白が出る(余白色は background) */
  fit?: "cover" | "contain";
  /** contain 時の余白色。既定 paper */
  background?: "paper" | "band";
  /** Ken Burns の種類。既定 zoomIn。移動量はショット尺によらず総計4〜6%程度の緩やかさ */
  kenBurns?: "zoomIn" | "zoomOut" | "panLeft" | "panRight" | "none";
  /**
   * 追加ズーム倍率。既定 1.0(= 全既存カット無影響)。cover の既定画角では
   * 主対象が小さく残る画像(群像の中の一要素など)を focus 中心に実効的に
   * 寄せる用途。Ken Burns の動きはこの倍率に乗算される。1未満は画像端が
   * 露出するため 1 に丸める
   */
  baseScale?: number;
  /** ズーム/パンの注視点(画像に対する%)。既定 中央 { xPct: 50, yPct: 50 } */
  focus?: { xPct: number; yPct: number };
  /** 色調統一フィルタ。既定 none */
  grade?: "none" | "sepia" | "muted";
  /** 黒/背景からのディゾルブ(秒)。既定 0 = ハードカット。章転換・余韻用 */
  fadeInSec?: number;
  fadeOutSec?: number;
  /** 周辺減光(緊迫した場面用、控えめ)。既定 false */
  vignette?: boolean;
};

/**
 * grade 名 → CSS フィルタ(3系統の画像の色調をチャンネルの基調へ寄せる)。
 * Thumbnail.tsx の画像レイヤーも同じフィルタを共有する(サムネと本編の色調統一)。
 */
export const GRADE_FILTERS: Record<NonNullable<SlideImageProps["grade"]>, string> = {
  none: "none",
  // 古画・版画調へ寄せるセピア(彩度を落とし、羊皮紙トーンに寄せる)
  sepia: "sepia(0.45) saturate(0.8) brightness(0.98) contrast(1.04)",
  // 実写調のシネマ調(彩度を落として静けさを出す)
  muted: "saturate(0.62) brightness(0.97) contrast(1.02)",
};

export const SlideImage: React.FC<SlideImageProps> = ({
  assetId,
  fit = "cover",
  background = "paper",
  kenBurns = "zoomIn",
  baseScale = 1,
  focus,
  grade = "none",
  fadeInSec = 0,
  fadeOutSec = 0,
  vignette = false,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const src = useAsset(assetId);

  // ショット内の進行率 0→1(Sequence 内では durationInFrames = ショット尺)
  const progress = safeInterpolate(
    frame,
    [0, Math.max(1, durationInFrames - 1)],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // ---- Ken Burns(尺によらず総計4〜6%程度の緩やかな動き)-------------------
  const focusX = focus?.xPct ?? 50;
  const focusY = focus?.yPct ?? 50;
  // 追加ズーム(既定1 = 従来どおり)。1未満は画像端が露出するため丸める
  const zoomBase = Math.max(1, baseScale);
  let scale = zoomBase;
  let translateXPct = 0;
  switch (kenBurns) {
    case "zoomIn":
      scale = zoomBase * (1 + 0.05 * progress); // ×1.00 → ×1.05
      break;
    case "zoomOut":
      scale = zoomBase * (1.05 - 0.05 * progress); // ×1.05 → ×1.00
      break;
    case "panLeft":
      // 端が見えないよう常時オーバースキャンし、水平にゆっくり流す
      scale = zoomBase * 1.06;
      translateXPct = 2.5 - 5 * progress; // +2.5% → -2.5%(画は右→左へ)
      break;
    case "panRight":
      scale = zoomBase * 1.06;
      translateXPct = -2.5 + 5 * progress;
      break;
    case "none":
      break;
  }

  // ---- ディゾルブ(黒/背景から)--------------------------------------------
  const fadeInFrames = Math.round(fadeInSec * fps);
  const fadeOutFrames = Math.round(fadeOutSec * fps);
  const fadeIn =
    fadeInFrames > 0
      ? safeInterpolate(frame, [0, fadeInFrames], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 1;
  const fadeOut =
    fadeOutFrames > 0
      ? safeInterpolate(
          frame,
          [durationInFrames - 1 - fadeOutFrames, durationInFrames - 1],
          [1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        )
      : 1;
  const opacity = Math.min(fadeIn, fadeOut);

  const bgColor = background === "band" ? PALETTE.band : PALETTE.paper;

  return (
    <AbsoluteFill
      style={{
        // cover は画像が全面を覆うので背景は見えない。contain の余白色として効く。
        backgroundColor: fit === "contain" ? bgColor : PALETTE.band,
        overflow: "hidden",
        opacity,
      }}
    >
      <Img
        src={src}
        style={{
          width: "100%",
          height: "100%",
          objectFit: fit,
          objectPosition: `${focusX}% ${focusY}%`,
          transform: `translateX(${translateXPct}%) scale(${scale})`,
          transformOrigin: `${focusX}% ${focusY}%`,
          filter: GRADE_FILTERS[grade],
        }}
      />
      {vignette ? (
        <AbsoluteFill
          style={{
            // 周辺減光(控えめ)。緊迫した場面で空気を重くする用
            background:
              "radial-gradient(ellipse at center, rgba(6,5,4,0) 55%, rgba(6,5,4,0.38) 100%)",
            pointerEvents: "none",
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};
