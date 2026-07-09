import React from "react";
import { Composition, registerRoot } from "remotion";
import { Thumbnail, calculateThumbnailMetadata } from "./Thumbnail";

/**
 * サムネイル専用の軽量エントリポイント。
 *
 * Root.tsx(Episode + Thumbnail)はエピソード用シーン群を含む大きな
 * バンドルになり、メモリ逼迫時にヘッドレスブラウザでの評価が部分的に
 * 失敗して「Could not find composition」を起こすことがある。
 * サムネ生成(render-thumbs.ts)はこの小さなRootだけを使う。
 */
export const ThumbnailRoot: React.FC = () => {
  return (
    <Composition
      id="Thumbnail"
      component={Thumbnail}
      durationInFrames={1}
      fps={30}
      width={1280}
      height={720}
      defaultProps={{ episodeDir: "episodes/ep000-test", variant: 1 }}
      calculateMetadata={calculateThumbnailMetadata}
    />
  );
};

registerRoot(ThumbnailRoot);
