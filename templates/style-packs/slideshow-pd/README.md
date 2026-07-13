# style-packs/slideshow-pd — スライドショー型(PD/CC画像調達)スタイルパック

## 目的

`templates/` 本体のコアコンポーネント(DoodleCharacter 等)は「白背景手描きDoodle」を前提にしている。
このパックは、それとは別系統の映像スタイル ——
**パブリックドメイン(PD)/クリエイティブ・コモンズ(CC)の実在資料画像**をナレーション同期のスライドショーとして見せる、
ドキュメンタリー調のチャンネル向けの参照実装一式である。

キャラクターイラストの生成ではなく、**史料写真・版画・写本挿絵などの実在画像の調達とキュレーション**を映像の主軸に置く
チャンネル(歴史解説・実録ドキュメンタリー系など)を新規構築する際に、SKILL.md ステップ5「映像スタイルの適用」の
選択肢の一つとして使う。独自実装より先に、まずこのパックが bible §8(映像スタイル)の方向性に合うかを検討する。

## 含まれるもの

```
style-packs/slideshow-pd/
├── README.md                              — このファイル
├── src/scenes/core/
│   ├── SlideImage.tsx                     — 主力コンポーネント。フルフレーム画像+緩やかなKen Burns(ズーム/パン)
│   ├── ChapterCard.tsx                    — 章の区切りカード(帯色背景+明朝体+細罫)
│   └── TimelineBar.tsx                    — 年表バー(水平線+目盛り+年号テロップ)
└── .claude/agents/
    └── image-researcher.md                — PD/CC画像のリサーチ調達エージェント(Wikimedia Commons等が調達先)
```

3コンポーネントはいずれも `bible §8`(映像スタイル)・`§9`(誇張しない演出規範)・`§10`(画像調達の事実性規則)を
コード中のコメントで参照している。これらの節番号は抽出元チャンネルの bible.md の構成に基づくものなので、
適用先チャンネルの bible.md で同等の内容を記述している節番号に読み替えること(節番号自体を機械的にコピーしない)。

## 前提(依存)

3コンポーネントは以下の**既存の共通テンプレファイル**に依存する。これらはこのパックには含まれない
(`templates/` 本体に既にあるか、通常のVARIANTカスタマイズで用意する)。

- `src/motion`(`safeInterpolate`) — テンプレ本体のIDENTICALファイル。追加作業不要
- `src/scenes/asset-context.tsx`(`useAsset`) — テンプレ本体のIDENTICALファイル。追加作業不要
- `src/scenes/style.ts` — **VARIANT。このパックが要求する値を追加で定義する必要がある**:
  - `PALETTE` に `paper` / `band` / `ink` / `red` / `sepia` の各色キー(黒帯・字幕背景に `band`、古画調の装飾罫に `sepia` を使う)
  - `MINCHO_FONT_STACK`(明朝体フォントスタック。字幕・章カード・年表で使用)
  - 上下黒帯(シネマスコープ風レターボックス)+帯内字幕を使う場合は `FRAME_STYLE`(`letterboxPct` / `letterboxColor` / `subtitleVariant: "band"` / `subtitleFontFamily` 等)も合わせて調整する。`FRAME_STYLE` は Episode.tsx が読む契約なので、キー名・型は既存の定義に合わせること

## 適用手順

1. **コンポーネントのコピー**: `src/scenes/core/SlideImage.tsx` / `ChapterCard.tsx` / `TimelineBar.tsx` を
   適用先チャンネルの `src/scenes/core/` へコピーする
2. **`.channel-system.json` の `coreOverrides` 宣言**: これら3ファイルは現行の `CORE_IDENTICAL`
   (チェッカーの完全一致対象リスト)には含まれない新規追加コンポーネントなので、コピーしただけでは
   `check-template-sync.mjs` の対象にならない。ただし、このスタイルへ合わせて**既存のCORE_IDENTICALコンポーネント
   (例: `TitleCard.tsx` 等)を再スキンする場合は**、その対象ファイルを `.channel-system.json` の
   `coreOverrides: string[]` に列挙する(props契約互換が条件。詳細は `scripts/check-template-sync.mjs` のコメント参照)
3. **image-researcher の配置**: `.claude/agents/image-researcher.md` を適用先チャンネルの
   `.claude/agents/` へコピーする。asset-generator(AI生成)と役割が分かれる点に注意 —
   このパックの方針では**PD/CC実写料の調達を第一手段、AI生成は補完**とする(bible側にもその旨を明記する)
4. **registry 登録**: `src/scenes/registry.ts` に import と `sceneRegistry` への追記を行う

   ```ts
   import { SlideImage } from "./core/SlideImage";
   import { ChapterCard } from "./core/ChapterCard";
   import { TimelineBar } from "./core/TimelineBar";

   export const sceneRegistry: Record<string, ComponentType<any>> = {
     // ...既存のコンポーネント...
     SlideImage,
     ChapterCard,
     TimelineBar,
   };
   ```

   `shots.json` の `scene.component` からはキー名(`"SlideImage"` 等)で参照する。既存のDoodle系コンポーネントは
   削除しない(契約互換とテンプレ同期のため残置してよい。使わないだけでよい)

5. **画風変更に伴う周辺調整**: `src/scenes/doodle-svg.ts` や `assets/fonts/`(手描き風フォント)はDoodle系専用の
   資産なので、このスタイルでは通常使わない。`src/remotion/Thumbnail.tsx`(サムネ構造)もこのスタイルの基調色・
   明朝体に合わせて再実装するのが一般的(VARIANTとして通常のチャンネル可変範囲)

## research-images.md 台帳の書式

image-researcher が採用画像ごとに記録する台帳は `episodes/<epId>/research-images.md` に置く。書式は以下の一般形
(具体的な題材名・固有名詞は各チャンネルのエピソード内容に応じて埋める):

```markdown
# 画像台帳 — <epId>

| # | file | 主題 | 作者/所蔵 | 年代 | ライセンス | 出典URL | 使用カット | 備考 |
|---|---|---|---|---|---|---|---|---|
| 1 | images/<epId>/<cutId>-<slug>.jpg | <場面・被写体の説明> | <作者名 or 不詳>/<所蔵機関> | <年代 or c.西暦> | <Public domain \| CC0 \| CC BY x.x> | <Commons等のFileページURL> | <使用ショットID> | <類例・要クレジット等の注記> |
```

- 列の意味: 出典URL(一次情報への直リンク)/ 作者・所蔵(判明分のみ、不詳可)/ 年代 / ライセンス(機械判定結果を転記。
  `extmetadata.LicenseShortName` 等の生値ではなく正規化した表記)/ 使用カット(shots.json のショットIDと対応させ、
  台帳とショットの対応関係を追跡可能にする)
- **台帳にない画像はショットから参照できない**(image-researcher.md の不変前提)。採用は必ず先に台帳へ記録する
- 不採用にした候補も別表(不採用の内訳: 候補 / 理由)として残すと、以後の同種検索で同じ候補を再検討する無駄を防げる
- CC BY 素材は備考欄に「要クレジット: `<Artist>` (CC BY 4.0)」のように明記する(publisher エージェントが概要欄へ転記する入力になる)

## 概要欄への出典表記義務

**ライセンス条件を満たすため、CC BY(表示)素材を1件でも使用したエピソードは、概要欄に出典クレジットを必ず記載する。**
PD(パブリックドメイン)素材はクレジット表記の法的義務はないが、事実性・信頼性のためドキュメンタリー系チャンネルでは
所蔵機関名(例: 「画像出典: ○○美術館所蔵資料等(パブリックドメイン)」)を記載する運用を推奨する。

- publisher エージェントが概要欄を生成する際、research-images.md の「要クレジット」注記を機械的に拾えるよう、
  備考欄のクレジット表記は上記の定型文言(`要クレジット: <Artist> (CC BY x.x)`)に統一する
- CC BY素材が0件のエピソードでも、台帳に「CC BY素材: なし(クレジット義務なし)」の1行を残し、
  「クレジット漏れ」と「そもそも対象なし」を publisher・人間レビューの双方が区別できるようにする
