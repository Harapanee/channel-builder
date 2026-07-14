# Channel Video Factory 使い方説明書

ディレクトリ構造は2階層です。

- **ファクトリールート**(複数チャンネルをまとめる親フォルダ。例: `~/youtube/`。`.factory.json` を持つ): ここで `channel-builder`(全チャンネル共通のスキル、`~/.claude/skills/channel-builder/`)を実行すると、直下に新しいチャンネルフォルダ(Factory)が構築される。ルート自体がgitリポジトリの場合、チャンネルフォルダは追跡しない(`.gitignore`で除外)
- **チャンネルフォルダ**(=Factory。チャンネルごとに1フォルダ=1リポジトリ): `/video-create` で動画を量産し、`/channel-refine`(このチャンネルの教義)と `/system-refine`(全チャンネル共通の工場OS)で改善を蓄積する

あなたの役割は「作ること」ではなく「**判定すること**」です。台本・映像・素材・審査はすべてエージェントが行い、要所であなたの承認を求めてきます。メインセッションのモデルはFableである必要はありません(制作技能はエージェント定義に外部化済み)。

---

## 0. 毎回の起動前チェック

| 確認 | 方法 | ダメなとき |
|---|---|---|
| VOICEVOX起動 | `curl -s http://127.0.0.1:50021/version` | VOICEVOXアプリを起動 |
| 画像生成 | 主経路はcodex CLI(自動検出)。フォールバック用にFactoryの `.env` に `EVOLINK_API_KEY=...` | キーを取得して書く(gitには載らない)。codex不在でもevolinkだけで動く |
| Node / ffmpeg | `node -v` / `ffmpeg -version` | インストール |

---

## 1. 新しいチャンネルを作る(/channel-builder)

```
cd <ファクトリールート>   # 複数チャンネルをまとめる親フォルダ(例: ~/youtube/)
claude
> /channel-builder
```

`.channel-system.json` のないディレクトリ(=ファクトリールート)で起動すると、ヒアリング後に直下へ新しいチャンネルフォルダ(Factory)が作られる。**カレントディレクトリ自体は変換しない。**

| # | 工程 | **あなたがやること** |
|---|---|---|
| 1 | ヒアリング(構想・視聴者・笑い・画風・尺) | 答える(曖昧OK、仮説はPilotで検証) |
| 2 | bible草案(チャンネル憲法) | **読んで承認**(ゲート1) |
| 3 | 声の選定 | サンプルWAVを**試聴して1つ選ぶ**(ゲート2)。以後原則変更不可 |
| 4 | Scaffold(工場一式の展開+検証) | 待つ |
| 5 | キャラクター正典 | 候補から**1枚選ぶ**(ゲート3)。基準は「チャンネルの顔文法」 |
| 6 | Pilot制作(30〜90秒) | 待つ |
| 7 | Pilot判定 | **視聴して判定**(ゲート4)。フィードバックは自由文で |
| 8 | Freeze(v1.0.0固定→量産モード) | 「承認」と言う |

本番動画が長尺でも、Pilotは30〜90秒(安く検証するため)。

---

## 2. 動画を作る(/video-create)

```
> /video-create ナポレオン
```

### パイプライン(全自動、あなたの判定は通常2〜3回)

```
調査(出典つき・fact-checker) → 台本(script-director)
→ 二重審査【fact-checker=事実 + script-reviewer=構造・笑い・テンポ(合否権)】
→ 誤読プリチェック(reading-checker・合否権) → 音声合成+タイミング(自己検証つき)
→ 絵コンテ+ショット設計(visual-director)
→ 不足素材リスト → 素材生成(asset-generator)【あなた: キュレーション】
→ シーン実装(scene-implementer) → Studio早期確認(推奨・レンダー前)
→ レンダー前検査(型検査・契約検証・スモークQAでレンダー失敗を前倒しで潰す)
→ AIレビュー2系統(準拠=合否 / 疑似初見=助言)
→ 公開パッケージ(タイトル・サムネ3案・概要欄・metadata)【あなた: タイトル選ぶ(方式による)】
→ 人間レビュー(動画・サムネ・タイトル一括)【あなた: 承認】
→ 夜間レンダーキュー(サーバーが焼いて機械検査→final確定。即時レンダーはしない)
→ 朝: 確認・アップロード(YouTube Studioへ手動。サムネはA/Bテストへ投入)
```

- **全動画はトラック転生オープニングで始まる**(チャンネル署名: 現代のあなた→トラック→転生、5〜10秒、血なしの記号表現)
- **10分超の動画は章並列制作**: 全体設計1体→章別エージェント並列→統合検証(実測でスループット約2.6倍)
- 台本審査(script-reviewer)はREVISE最大2周、決着しない論点だけあなたにエスカレーション

### 実測の目安

| 規模 | 実働 | 備考 |
|---|---|---|
| 60〜90秒 | 初回4h → 2本目以降1.5h | 基盤・素材再利用時 |
| 5分 | 約2.5h+レンダリング20分×n | 章構成 |
| 13分(本番級) | 約4〜5h+レンダリング60分×n | 章並列・素材新規十数枚 |

---

## 3. フィードバックの出し方(いちばん大事)

見たまま自由文で言えばOK。**「今回だけの修正」か「恒久ルール」かはClaudeが分類して提案**し、恒久化はあなたの承認後にCHANGELOG.mdへ記録されます。

還元には3つの層があります(分類は自動):

| 層 | スキル | 例 |
|---|---|---|
| このチャンネルの教義 | `/channel-refine` | 「間が多い」→bibleの間の規則 |
| 全チャンネル共通の工場OS | `/system-refine` | 「台本チェック役が要る」→script-reviewerエージェント新設+テンプレ同期 |
| 別チャンネルの改善をこちらへ | `/factory-update` | 他Factoryでsystem-refineされた改善を、既存のこのFactoryに取り込む |
| 今回の動画だけ | (スキル不要) | 「この行だけ直して」 |

> 実績: 「間が多い」「絵が欲しい」「話が飛ぶ」「同じ演出の繰り返し」「地図で場所を」「グリーンバックで」「台本チェック役」「テンプレ書き換えスキル」— すべて恒久ルール/仕組みになり、以後の動画・次のチャンネルに自動適用されています。

---

## 4. 状態の確認

| 知りたいこと | 場所 |
|---|---|
| チャンネル状態・実測メトリクス | `.channel-system.json` |
| 各動画の進捗 | `episodes/<ep>/episode.json`(researched→scripted→voiced→storyboarded→implemented→prechecked→reviewed→packaged→render_ready→final。final は夜間レンダー成功時にサーバーが書く) |
| 恒久ルールの変更履歴 | `CHANGELOG.md` |
| 機械検査・AIレビュー | `episodes/<ep>/review/` |
| **テンプレート同期の健全性** | `node scripts/check-template-sync.mjs`(全緑=次のチャンネルに最新が入る) |

---

## 5. ファイルの地図

| ファイル | 何か | 直接編集 |
|---|---|---|
| `channel/bible.md` | チャンネル憲法 | ❌ /channel-refine 経由(承認後は保護hookがブロック) |
| `channel/voice.json` | ナレーターの声 | ❌ 原則変更禁止 |
| `.claude/agents/*.md` | エージェント12体の技能定義 | ❌ /system-refine 経由(テンプレ同期必須) |
| `.claude/skills/*` | video-create / channel-refine / system-refine | ❌ /system-refine 経由 |
| `src/pipeline/` | ツール群(tts / validate / qa / gen-image / remove-bg / retime / render-thumbs) | ❌ /system-refine 経由 |
| `assets/library.json` | 素材台帳(あなたの承認済みのみ使用可) | ❌ Claudeが管理 |
| `.env` | APIキー | あなただけが書く(コミット禁止) |

### エージェント一覧(制作の実働部隊)

fact-checker(調査・事実)/ script-director(台本執筆)/ **script-reviewer(台本審査・合否)**/ reading-checker(誤読検査・合否)/ visual-director(絵コンテ・ショット)/ scene-implementer(シーン実装)/ asset-generator(画像素材のプロンプト技能)/ compliance-reviewer(準拠・合否)/ audience-sim(疑似初見)/ theme-scout(題材採点)/ publisher(タイトル・サムネ・概要欄・metadata)/ short-director(ショート台本+ショット)

---

## 6. トラブルシューティング

| 症状 | 対処 |
|---|---|
| 音声合成が失敗 | VOICEVOXを起動して再実行 |
| 「ブロックされました」表示 | 正常(保護hook)。恒久変更は /channel-refine か /system-refine で |
| 尺が超過 | 「尺に収めて」と指示(読点・間の削減→ショットは自動追従) |
| キャラ画像が別人化 | 自動リトライ3回→演出変更提案。asset-generatorの失敗→修正表参照 |
| 素材の背景が消えない | 自動判別(緑=クロマキー/白=flood-fill)。旧素材はしきい値190 |
| サムネ生成が「composition not found」 | `render-thumbs.ts` を使う(CLI直叩き禁止 — メモリ逼迫時に不安定) |
| 大レンダリングが遅い/不安定 | 他プロジェクトのRemotionと同時実行を避ける(メモリ競合) |
| テンプレが古い気がする | `node scripts/check-template-sync.mjs` → NGが出たら /system-refine の手順3-4 |

---

## 7. 公開時の注意

- エンディングのクレジット(voice.jsonのcreditNotice、例「VOICEVOX:青山龍星」)は自動挿入。消さない
- 概要欄の推奨クレジット文例は `assets/audio/LICENSES.md` 末尾
- **リポジトリを公開する場合、`assets/audio/` は再配布禁止条項に抵触するおそれ**(LICENSES.md参照)。`.env` も要確認

---

## 8. コマンド早見表

```
/channel-builder                 # 新チャンネル構築(ファクトリールートで実行、直下に新フォルダを作成)
/video-create 織田信長           # 動画制作
/render-queue                    # 溜まったレンダリングを夜間にまとめて消化(寝る前に)
/channel-refine <フィードバック>  # このチャンネルの恒久改善
/system-refine                   # 工場OS改善+テンプレ同期
/factory-update                  # テンプレ最新OSを既存Factoryへ取り込み
node scripts/check-template-sync.mjs   # テンプレ健全性チェック
npx tsx src/pipeline/render-thumbs.ts episodes/<ep>   # サムネ3枚
open episodes/<ep>/out/final.mp4 # 視聴
cat .channel-system.json         # 状態
```
