import type { ComponentType } from "react";
import { DoodleCharacter } from "./core/DoodleCharacter";
import { DoodleMap } from "./core/DoodleMap";
import { SpeechBubble } from "./core/SpeechBubble";
import { DangerCircle } from "./core/DangerCircle";
import { ComparisonSplit } from "./core/ComparisonSplit";
import { TitleCard } from "./core/TitleCard";

/**
 * コンポーネント名 → React コンポーネント のマップ(契約、§7.6)。
 * shots.json の `scene.component` はこのレジストリのキーで解決される。
 * MVPのコアコンポーネントは6個に固定し、事前実装をこれ以上増やさない。
 *
 * ---- "custom:<Name>" 解決規約(§7.6) ----------------------------------
 * 一回限りの特殊シーン(フック、クライマックスの重要変換、コアの合成)は、
 * `src/scenes/episodes/<epId>/<Name>.tsx` に通常のRemotionコンポーネント
 * (React/SVG/Canvas自由)として実装し、shots.json の `scene.component` には
 * `"custom:<Name>"` という文字列で参照する。
 *
 * 動的ロード機構は導入せず、ここ(`customRegistry`)へ静的登録することで
 * レジストリへエピソード単位にマージする。エピソード3本を通じて再利用された
 * カスタムシーンは、コアコンポーネントへ昇格させる(§12の還元対象)。
 */
export const sceneRegistry: Record<string, ComponentType<any>> = {
  DoodleCharacter,
  DoodleMap,
  SpeechBubble,
  DangerCircle,
  ComparisonSplit,
  TitleCard,
};

export const CUSTOM_COMPONENT_PREFIX = "custom:";

/**
 * エピソード固有のカスタムシーン(静的登録)。
 * キーは `custom:` プレフィクスを除いた `<Name>` 部分。
 *
 * テンプレート初期状態では空。`/video-create` が
 * `src/scenes/episodes/<epId>/<Name>.tsx` を実装するたびに、その import と
 * 登録をここへ追記する(§7.6)。
 */
import { JapanMap } from "./shared/JapanMap";
import { WorldMap } from "./shared/WorldMap";
import { ThreeFaces } from "./shared/ThreeFaces";
import { TruckIsekai } from "./shared/TruckIsekai";
import { Outro } from "./shared/Outro";

export const customRegistry: Record<string, ComponentType<any>> = {
  // 全チャンネル共通の地理表示(bible不変規則「地名初出は地図で」を支える)
  JapanMap,
  // shared: 地理形状は実データ(Natural Earth 110m由来の世界地図)
  WorldMap,
  ThreeFaces,
  // 全動画共通のチャンネル署名(bible §4): トラック転生OPと固定アウトロ
  TruckIsekai,
  Outro,
};

/**
 * scene.component 文字列がレジストリで解決可能かどうかを判定する。
 * validate-shots.ts はこの関数を経由してのみ判定し、レジストリのキー集合を
 * 直接ハードコードしない(単一の真実源をここに置く)。
 */
export function isResolvableComponent(componentName: string): boolean {
  if (componentName.startsWith(CUSTOM_COMPONENT_PREFIX)) {
    const name = componentName.slice(CUSTOM_COMPONENT_PREFIX.length);
    return Object.prototype.hasOwnProperty.call(customRegistry, name);
  }
  return Object.prototype.hasOwnProperty.call(sceneRegistry, componentName);
}

/** レジストリからコンポーネントを取得する。無ければ undefined。 */
export function resolveComponent(
  componentName: string
): ComponentType<any> | undefined {
  if (componentName.startsWith(CUSTOM_COMPONENT_PREFIX)) {
    const name = componentName.slice(CUSTOM_COMPONENT_PREFIX.length);
    return customRegistry[name];
  }
  return sceneRegistry[componentName];
}
