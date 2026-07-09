import React from "react";
import {
  Composition,
  Freeze,
  registerRoot,
  useCurrentFrame,
  type CalculateMetadataFunction,
} from "remotion";
import {
  Episode,
  calculateEpisodeMetadata,
  type EpisodeProps,
} from "./Episode";

/**
 * qa-smoke.ts 専用のサンプラーRoot(§QAスモーク)。
 *
 * 目的: 全ショットの抜き取りフレーム(数百枚)を高速に描画する。
 * renderStill をフレームごとに呼ぶとページロード(巨大バンドルの評価+
 * フォント/素材ロード)が毎回走り1枚あたり数十秒かかる。そこで
 * 「出力フレーム k = Episode の sampleFrames[k] フレーム目を <Freeze> で
 * 固定表示する」だけの composition を用意し、renderFrames で**連続レンダー**
 * する。ページはワーカーごとに1回しかロードされないため、renderStill 連打の
 * 数十倍速い。
 *
 * このRootは qa-smoke.ts が @remotion/bundler で直接バンドルする専用
 * エントリポイントであり、本番レンダー用の Root.tsx には含めない
 * (本番のComposition一覧を汚さないため)。render-thumbs.ts の
 * ThumbRoot.tsx と同じ「用途別エントリポイント」パターン。
 */
export type QASmokeProps = EpisodeProps & {
  /** 出力フレーム k に表示する Episode のフレーム番号(昇順) */
  sampleFrames: number[];
};

const QASmoke: React.FC<QASmokeProps> = ({ sampleFrames, ...episode }) => {
  const frame = useCurrentFrame();
  const target =
    sampleFrames[Math.min(frame, Math.max(0, sampleFrames.length - 1))] ?? 0;
  return (
    <Freeze frame={target}>
      <Episode {...episode} />
    </Freeze>
  );
};

/**
 * Episode と同じデータ(shots/timing/library)を注入する。
 *
 * durationInFrames は**エピソード全尺のまま**にすること(サンプル数に縮めては
 * いけない)。Remotion の useCurrentFrame は内部で
 * `clampFrameToCompositionRange(frame, durationInFrames)` を通すため、尺を
 * サンプル数(例: 398)にすると <Freeze frame={27327}> が 397 にクランプされ、
 * 後半の全サンプルが同一フレームになる(qa-smoke開発時に実測したバグ)。
 * 実際に描くのはサンプル数分だけ — qa-smoke.ts が renderFrames の
 * frameRange=[0, サンプル数-1] で制御する。
 */
export const calculateQASmokeMetadata: CalculateMetadataFunction<
  QASmokeProps
> = async (params) => {
  const base = await calculateEpisodeMetadata(
    params as unknown as Parameters<typeof calculateEpisodeMetadata>[0]
  );
  return {
    ...base,
    props: {
      ...(base.props as EpisodeProps),
      sampleFrames: params.props.sampleFrames,
    },
  };
};

export const QASmokeRoot: React.FC = () => {
  return (
    <Composition
      id="QASmoke"
      component={QASmoke}
      durationInFrames={1}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{
        episodeDir: "episodes/ep000-test",
        sampleFrames: [0],
      }}
      calculateMetadata={calculateQASmokeMetadata}
    />
  );
};

registerRoot(QASmokeRoot);
