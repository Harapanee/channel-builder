import React from "react";
import { Composition, registerRoot } from "remotion";
import { Episode, calculateEpisodeMetadata } from "./Episode";
import { Thumbnail, calculateThumbnailMetadata } from "./Thumbnail";

/**
 * §7.5: Composition "Episode"。
 * 解像度/フレームレートは1920x1080/30fps固定。
 * durationInFrames / width / height はここでは仮値であり、
 * calculateMetadata が shots.json を読んで実際の値に上書きする。
 * episodeDir は他のエピソードで確認する場合、Studioの Input Props /
 * `remotion render ... --props='{"episodeDir":"episodes/epXXX"}'` で上書きできる。
 *
 * §13: Composition "Thumbnail"。1280x720 / 静止(1フレーム)。
 * calculateMetadata が `<episodeDir>/publish/thumbnails.json` を読み、
 * `variant`(1|2|3)の案を描画する。契約は .claude/agents/publisher.md。
 * 書き出し例:
 *   npx remotion still src/remotion/Root.tsx Thumbnail out.png \
 *     --props='{"episodeDir":"episodes/epXXX","variant":1}'
 */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Episode"
        component={Episode}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{ episodeDir: "episodes/ep000-test" }}
        calculateMetadata={calculateEpisodeMetadata}
      />
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
    </>
  );
};

registerRoot(RemotionRoot);
