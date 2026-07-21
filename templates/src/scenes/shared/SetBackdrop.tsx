import React from "react";
import { AbsoluteFill, Img } from "remotion";
import * as channelStyle from "../style";
import { useAssetIfRegistered } from "../asset-context";

/**
 * 常設セット背景(横型の全ショット最背面。zunda系チャンネルの bible §8 由来)。
 *
 * チャンネル可変設定は style.ts の SET_BACKDROP(assetId)。SpeakerStands と同じ
 * 「Episode.tsx は無条件にマウントし、描画するかは style.ts が設定を持つかで決まる」型:
 * - SET_BACKDROP 未定義のチャンネル → 何も描画しない(テンプレ互換)
 * - assetId が library 未登録のとき(旧エピソードの再レンダー等)→ 静かに描画しない
 * 不透明な固有背景を持つシーンは単にこの上を覆う(切替はシーン側の自由)。
 */
type SetBackdropConfig = {
  /** library.json 登録済みの常設セット素材(例: 教室の黒板・司令室) */
  assetId: string;
};

const CONFIG = (channelStyle as Record<string, unknown>).SET_BACKDROP as
  | SetBackdropConfig
  | undefined;

export const SetBackdrop: React.FC<{ scrim?: number }> = ({ scrim = 0 }) => {
  const src = useAssetIfRegistered(CONFIG?.assetId ?? "");
  if (!CONFIG || !src) return null;
  return (
    <AbsoluteFill>
      <Img
        src={src}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
      {scrim > 0 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `rgba(255,255,255,${scrim})`,
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};
