/**
 * AssetContext。
 *
 * Episode.tsx が assets/library.json を読み(calculateMetadata で
 * fetch(staticFile()) 方式、Episode.tsx 参照)、その中身をこの Provider へ渡す。
 * 各コンポーネントは useAsset(assetId) で配信 URL を得る。
 * library.json に無い assetId は明確なエラーを投げる。
 */
import React, { createContext, useContext, useMemo } from "react";
import { staticFile } from "remotion";
import type { LibraryFile } from "../schemas/types";

type AssetMap = ReadonlyMap<string, string>;

const AssetContext = createContext<AssetMap | null>(null);

/** library.json の各エントリ file を staticFile("assets/<file>") へ解決したマップを配る。 */
export const AssetProvider: React.FC<{
  library: LibraryFile;
  children: React.ReactNode;
}> = ({ library, children }) => {
  const map = useMemo<AssetMap>(() => {
    const m = new Map<string, string>();
    for (const a of library.assets) {
      m.set(a.assetId, staticFile(`assets/${a.file}`));
    }
    return m;
  }, [library]);
  return <AssetContext.Provider value={map}>{children}</AssetContext.Provider>;
};

function requireMap(caller: string): AssetMap {
  const map = useContext(AssetContext);
  if (!map) {
    throw new Error(
      `${caller} は AssetProvider の外側で呼ばれました。Episode.tsx が library を Provider へ渡しているか確認してください。`
    );
  }
  return map;
}

function lookup(map: AssetMap, assetId: string): string {
  const url = map.get(assetId);
  if (!url) {
    const known = Array.from(map.keys()).sort().join(", ");
    throw new Error(
      `assetId "${assetId}" は assets/library.json に登録されていません。登録済みID: [${known}]`
    );
  }
  return url;
}

/** assetId から配信 URL を得る。未登録なら明確なエラーを投げる。 */
export function useAsset(assetId: string): string {
  const map = requireMap(`useAsset("${assetId}")`);
  return lookup(map, assetId);
}

/**
 * assetId が省略可能なケース(例: DoodleMap の svgAssetId)向け。
 * undefined ならそのまま undefined を返すが、指定されていて未登録なら
 * useAsset と同様に明確なエラーを投げる(タイポの握り潰しを防ぐ)。
 */
export function useOptionalAsset(
  assetId: string | undefined
): string | undefined {
  const map = requireMap("useOptionalAsset(...)");
  if (assetId === undefined || assetId === null || assetId === "") {
    return undefined;
  }
  return lookup(map, assetId);
}
