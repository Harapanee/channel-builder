---
name: channel-builder
description: ファクトリールート(現在のディレクトリ)の直下に、特定YouTubeチャンネル専用の動画制作システム(Channel Video Factory)のチャンネルフォルダを新規構築する。1つのファクトリーに複数チャンネルを並べられる。新チャンネルの立ち上げ、既存チャンネルの状態確認・改修時に使う。「/channel-builder」で起動。
---

# /channel-builder — Channel Video Factory 構築スキル

このスキルは動画を直接作らない。**ヒアリングを通じてチャンネル専用の制作システム(教義・契約・パイプライン・エージェント)のチャンネルフォルダをファクトリールート直下に構築する**。構築後の動画制作は、生成されたプロジェクト内の `/video-create` が担う。

## 大原則

1. **契約と教義の分離**: コードが読むJSON(スキーマ検証必須)と、LLMが読む散文(channel/bible.md)を混同しない。機械が執行できない値を契約に書かない
2. **メインセッションは監査役**: 台本・絵コンテ・実装・レビューは生成されたエージェント定義(script-director / visual-director / scene-implementer / fact-checker / compliance-reviewer / audience-sim)へ委譲される。品質はシステムが担保し、メインのモデルに依存しない
3. **人間ゲート**: bible承認 / 声の選定 / キャラクター正典のキュレーション / Pilot承認 は必ずユーザーが判定する。勝手に進めない
4. **問題はシステムへ還元**: 再発し得る問題は生成後のプロジェクトの `/channel-refine` で bible・checklist・コンポーネントへ反映する

## 起動時: モード判定

カレントディレクトリの `.channel-system.json` を読む。

| カレントの状態 | モード | 動作 |
|---|---|---|
| `.channel-system.json` あり(=チャンネルフォルダ内) | status: building / pilot_iterating → **Refine**、status: approved → **Operate** | 従来どおり |
| なし(=ファクトリールート) | **Factory** | 直下の `*/.channel-system.json` をスキャンしチャンネル一覧(channelName / status / systemVersion)を提示。ユーザーの意図に応じて: 新規構築→Build / 既存の確認・改修→該当フォルダで再起動するよう案内 |

Buildは**カレントを変換しない**。直下に新しいチャンネルフォルダを作り、その中へ構築する。

## ディレクトリ保護(Buildの前に必ず)

- インタビューでchannelId確定後、フォルダ名(既定: channelId)をユーザーに確認する
- 新フォルダは「存在しない」か「空」であること。既存の非空フォルダへの構築は拒否する
- scaffold・git init・npm install はすべて新フォルダ内で行う(チャンネルごとに独立リポジトリ)
- scaffold完了時にファクトリールートを整備する: `.factory.json` がなければ `{"projectType":"channel-video-factory-root","schemaVersion":"1.0","name":"<ルートのフォルダ名>"}` で作成し、ルートが gitリポジトリなら `.gitignore` に新チャンネルフォルダ名の行を追記する
- ルートおよび他チャンネルの `.env` には触れない(APIキーの新規作成が必要な場合はユーザーに依頼する)

## Build プロセス

### 1. Adaptive Interview → bible.md 草案

`references/interview-framework.md` に従う。**出力は channel/bible.md(12セクション)+ voice.json + .channel-system.json であり、独自の中間フォーマットを作らない。**
草案完成後、bible.md 全文をユーザーに提示して承認を得る(人間ゲート1)。

### 2. 技術前提の確認

- VOICEVOX: `curl -s http://127.0.0.1:50021/version`(なければ起動/インストールを依頼)
- 画像生成: `.env` の EVOLINK_API_KEY 等の存在(なければ依頼)。ffmpeg / Node 18+ を確認

### 3. 声の選定(人間ゲート2)

`references/voice-and-assets-guide.md` の手順で、チャンネルのナレーター人格に合う話者候補3〜6種のサンプルWAVを合成しユーザーに試聴させ、`channel/voice.json` を確定する。**承認後の声の変更はチャンネルの同一性を壊すため原則禁止。**

### 4. Scaffold(テンプレート展開)

`references/scaffold-guide.md` に従い `templates/` からプロジェクトを展開し、プレースホルダを埋める。
検証: `npm install` → `npm run typecheck` → `npm run validate episodes/ep000-test` → `npm run render:test`(1080p/30fpsのmp4が出ること)。**全部通るまで次へ進まない。**

### 5. 映像スタイルの適用

- templates のコアコンポーネント6個は「白背景手描きDoodle」のリファレンス実装である。bibleの映像スタイル(§8)がこの系統なら `src/scenes/style.ts` のパレット調整で足りる
- 系統が異なる場合、まず `references/scaffold-guide.md`「映像スタイルの選択肢」の `templates/style-packs/` に既製パックが無いか確認する(例: PD/CC画像調達のスライドショー型 → `style-packs/slideshow-pd/`)。無ければ bible §8 を仕様としてコアコンポーネントの再実装をエージェントへ委譲し、スチル書き出しでユーザー確認を取る

### 6. キャラクター/素材の初期化(人間ゲート3)

`references/voice-and-assets-guide.md` の正典参照方式ワークフローで、Pilot題材の正典→バリアントを生成し、ユーザーのキュレーションを経て library.json へ登録する。

### 7. エージェントのチャンネル適合

- audience-sim.md の視聴者ペルソナ部分を bible §2 の内容で書き換える(このエージェントはbibleを読まない設計のため、ペルソナは定義に直接埋める)
- review-checklist.md を bible の禁止事項・構造規則に合わせて調整する

### 8. Pilot(人間ゲート4)

生成されたプロジェクトの `/video-create <Pilot題材>` を実行する。**Pilotは本番の目標尺に関わらず30〜90秒**(検証コストを抑えるため。本番尺はbibleに記録し、長尺の章構成は本番1本目で設計する)。
フィードバックは「単発修正」と「/channel-refine(システム還元)」に分類して処理。ユーザー承認後:
- `.channel-system.json` を status: approved / systemVersion: 1.0.0 に更新し、metrics(実働時間・画像生成回数・レンダリング分)を記録
- `git tag v1.0.0`。以後 bible / voice.json / コアは保護hookの管理下に入る

## 生成後の運用(ユーザーへ案内)

- 新作: `/video-create <題材>` / 改善: `/channel-refine <フィードバック>` / ショート: `/short-builder`(フォーマット登録)→ `/short-create <epId>`
- 承認済みシステムの変更は refine の人間承認+`.channel-refine-approved` マーカー経由のみ
- リポジトリを公開する場合は assets/audio/ の再配布禁止条項に注意(assets/audio/LICENSES.md 参照)
