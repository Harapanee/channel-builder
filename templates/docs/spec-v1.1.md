# チャンネル専用 Video Factory 構築仕様書 完全版 v1.1

- 文書バージョン: **1.1**
- 文書種別: 自己完結型・最新版(過去版の参照: 不要)
- 対象: Claude Code 上で動作する動画制作システム、およびその構築プロセス
- 動画基盤: Remotion + FFmpeg
- 音声基盤: VOICEVOX(プロバイダ差し替え可能)
- 実装言語: TypeScript / Node.js

---

# 1. このシステムは何か

本システムは、あらゆる動画を生成する汎用動画生成器ではない。

**1つのYouTubeチャンネルの人格・画風・台本文法・素材戦略・評価基準をClaude Codeプロジェクトとして物質化し、題材を差し替えるだけで同じチャンネルの動画を量産できる「Channel Video Factory」を構築する仕組み**である。

最終像は、任意のチャンネル構想からFactoryを自動構築するメタスキル(channel-builder)だが、**メタスキルは最初に作るものではなく、最後に抽出されるものである**。本仕様書は次の3ステージで構成される。

```text
Stage 1: 1チャンネル分のFactoryを手動構築し、試作動画を1本完成させる
↓
Stage 2: 2本目を制作し、フィードバックをシステムへ還元する運用を確立する
↓
Stage 3: 安定した構造をテンプレート化し、ヒアリングで任意チャンネルの
         Factoryを構築するメタスキル channel-builder を抽出する
```

各ステージは検証仮説に対応する。前段の仮説が棄却された場合、後段には進まない。

- **H0(Stage 1)**: Claude Codeは、TTS同期・キャラクター一貫性のある60〜90秒のナレーション動画を、許容可能なコストと時間でエンドツーエンドにレンダリングできる。
- **H1(Stage 2)**: 題材を差し替えた2本目が、1本目と「同じチャンネル」に見え、かつ構造の再放送に見えない。フィードバックはシステム更新として蓄積できる。
- **H2(Stage 3)**: Stage 1〜2で安定した構造は、ヒアリングを通じて別チャンネルへ再現できる。

対象チャンネル(Stage 1〜2で固定):

```text
チャンネル: 「〇〇に転生したら最悪だった件」
内容:      歴史人物へ転生し、その人生の理不尽を追体験する
台本:      歴史初心者向け / コメディ多め / 二人称 / ブラックユーモア / 史実は崩さない
映像:      白背景Doodle / AI生成キャラクター / SVG地図 / Remotion 2Dアニメーション
```

完成後の使用例:

```text
/video-create 織田信長
/video-create ナポレオン
```

---

# 2. 設計原則

## 2.1 汎用化する対象

完成動画を汎用化しない。汎用化するのは、チャンネル専用の制作システムを作る手順である。

```text
悪い抽象化: あらゆる動画を1つのVisual Grammarで作る
良い抽象化: 共通の構築手順 → チャンネルごとの専用ルール → チャンネルごとの専用Factory
```

ただしその構築手順自体も、実物のFactoryを2本分運用した経験からしか正しく抽出できない。ゆえにStage 1が最初に来る。

## 2.2 契約(Contract)と教義(Doctrine)を分離する

本システムのファイルは2種類に厳密に区別される。この区別が本仕様書全体を貫く最重要原則である。

| 種別 | 消費者 | 形式 | 例 |
|---|---|---|---|
| **契約** | コード | JSON(スキーマ検証必須) | `shots.json` `timing.json` `library.json` `voice.json` |
| **教義** | LLM / 人間 | Markdown(散文) | `channel/bible.md` `review-checklist.md` `storyboard.md` |

- 契約には、コードが決定的に解釈・検証できるフィールドのみを置く。機械が執行できない値(「コメディ比率0.45」「ジョーク間隔20秒」等)を契約に置くことを禁止する。
- 教義には、LLMの生成を方向づける指針を散文で書く。偽りの数値精度を持たせない。「約20秒に1回笑いを入れる」は教義として書き、コードで検証しない。

## 2.3 良い動画の定義

良い動画とは、常に画面が動く動画ではない。視聴者の次の状態のうち、最低1つが時間とともに進み続ける動画である。

- 知識 / 感情 / 予測 / 好奇心 / 緊張 / 理解

画面変化、カット数、ズーム、派手さは衛生指標であり、面白さそのものではない。この定義は教義として `bible.md` に置かれ、レビュアーの判定観点になる。

## 2.4 問題はシステムへ還元する

動画内で見つかった問題のうち再発し得るものは、今回の動画だけを直さず、次のいずれかへ反映する。

- `channel/bible.md`(該当セクション)
- `channel/review-checklist.md`
- Component / Motionヘルパー
- 素材ワークフロー

例:

```text
問題:        人物のリアクションが単調
単発修正:    今回の画像だけ差し替える
システム修正: bible.md §キャラクター に必須表情を追記
             素材ワークフローに表情バリアント生成を追加
             review-checklist.md に表情反復の検出観点を追加
```

還元は `/channel-refine`(§12)を通じて行い、必ず人間の承認とCHANGELOG記録を伴う。

## 2.5 音声先行

正式な映像タイムラインは、実際のナレーション音声の尺を基準にする。台本→TTS→タイミング取得→ショット割りの順であり、映像を先に作って音声を合わせることはしない。

## 2.6 人間が最終教師

Mechanical QAとLLMレビューは欠陥検出と一貫性検証を担うが、「面白さ」の最終判定は人間が行う。AIレビュアーの合否は出荷判定ではなく、人間レビューに上げてよいかの前段ゲートである。

---

# 3. 技術スタックと確定事項

実装開始前に確定すべき技術選定を、本仕様書で以下の通り決定する。差し替え点はプロバイダインターフェース(§8.5)として分離する。

| 項目 | 決定 | 根拠 / 備考 |
|---|---|---|
| レンダリング | Remotion 4.x + FFmpeg | 全シーンをRemotionコンポジションとして統一 |
| TTS | VOICEVOX(ローカル、HTTP API) | 無料・決定的・話速/ピッチ/間を完全制御可・商用利用可(クレジット表記条件は音声ライブラリごとに確認) |
| ナレーションタイミング | VOICEVOXの合成クエリ出力から直接取得 | 合成エンジン自身がモーラ単位の長さを返すため、強制アラインメントツールが不要になる |
| タイミングのフォールバック | whisperX | TTSプロバイダを外部サービスへ差し替えた場合のみ使用 |
| AI画像生成 | 参照画像入力に対応した画像生成モデル(gpt-image系 / Gemini画像系のいずれか、実装時に1つ選定) | キャラクター一貫性は「参照画像+固定スタイルプロンプト」方式で担保する(§8.3)。参照画像入力非対応のモデルは採用不可 |
| 背景除去 | rembg(ローカル) | 透過PNG化 |
| AI動画生成 | **不使用**(MVP全期間) | 主情報を担わせない方針以前に、コストと不確実性がMVPに見合わない |
| 特殊シーン | **カスタムRemotionコンポーネント**(§7.6) | Remotion内でReact/SVG/Canvasが自由に書けるため、独立した特殊シーン基盤は設けない |
| 音声素材 | 無料ライセンスのSE/BGMライブラリを事前キュレーション | ライセンスは `assets/audio/LICENSES.md` に記録 |
| 解像度 / fps | 1920x1080 / 30fps | 固定 |

ナレーションの「声」はチャンネルの人格そのものであり、Stage 1の最初に人間が試聴して選定し、`channel/voice.json` に固定する。以後の変更はチャンネル全体の同一性を壊すため、承認済みシステムでは変更禁止とする。

---

# 4. ディレクトリ構成(Stage 1で構築する全体像)

```text
reincarnation-hell/                  ← チャンネル = 1リポジトリ
├── .channel-system.json             ← プロジェクト判定・状態(契約)
├── CLAUDE.md                        ← プロジェクト憲法
├── CHANGELOG.md                     ← システム変更履歴(/channel-refineが記録)
├── README.md
├── package.json
├── channel/
│   ├── bible.md                     ← チャンネル教義の唯一のファイル(§6)
│   ├── review-checklist.md          ← レビュアー用チェック観点(教義)
│   └── voice.json                   ← TTS設定(契約)
├── .claude/
│   ├── skills/
│   │   ├── video-create/SKILL.md
│   │   └── channel-refine/SKILL.md
│   └── agents/
│       ├── fact-checker.md
│       ├── compliance-reviewer.md
│       └── audience-sim.md
├── src/
│   ├── remotion/                    ← Root.tsx / Episode.tsx(§7.5)
│   ├── scenes/
│   │   ├── registry.ts              ← コンポーネントレジストリ(契約)
│   │   ├── core/                    ← コアコンポーネント(§7.6)
│   │   └── episodes/<epId>/         ← エピソード固有のカスタムシーン
│   ├── motion/                      ← squash / shake / popIn 等のヘルパー
│   ├── pipeline/                    ← tts.ts / parse-script.ts / validate-shots.ts / qa.ts / gen-image.ts
│   └── schemas/                     ← shots / timing / library 等のJSON Schema
├── assets/
│   ├── library.json                 ← 素材台帳(契約、§5.7)
│   ├── characters/<subject>/
│   ├── props/  maps/  backgrounds/
│   └── audio/
│       ├── se/  bgm/
│       └── LICENSES.md
├── episodes/
│   └── ep001-nobunaga/              ← エピソードデータ(§5.3)
└── outputs/                         ← 完成動画
```

---

# 5. データ契約(本仕様書の中核)

コードが読み書きする全ファイルの形式をここで定義する。全契約は `src/schemas/` のJSON Schemaで検証され、検証はhook(§14)で強制される。

## 5.1 `.channel-system.json`

```json
{
  "projectType": "channel-video-factory",
  "schemaVersion": "1.1",
  "channelId": "reincarnation-hell",
  "channelName": "〇〇に転生したら最悪だった件",
  "stage": 1,
  "status": "building",
  "systemVersion": "0.1.0",
  "approvedEpisodes": [],
  "metrics": []
}
```

```ts
type ChannelSystemStatus =
  | "building"          // Factory構築中
  | "pilot_iterating"   // 試作と修正の反復中
  | "approved";         // 人間承認済み。教義・声・コアコンポーネントの破壊的変更は/channel-refine経由のみ

type EpisodeMetric = {
  episodeId: string;
  wallClockHours: number;   // 着手から完成までの実時間
  imageGenCount: number;    // リトライ込みの画像生成回数
  renderMinutes: number;
};
```

`metrics` には各エピソード完成時に実測値を追記する。量産可否・長尺化の判断材料はこの実測値であり、推測で判断しない。

## 5.2 `channel/voice.json`

```json
{
  "provider": "voicevox",
  "speakerId": 13,
  "speedScale": 1.05,
  "pitchScale": 0.0,
  "intonationScale": 1.1,
  "defaultPauseAfterLineSec": 0.4,
  "creditNotice": "VOICEVOX:○○"
}
```

## 5.3 エピソードデータモデル

1エピソード = `episodes/<epId>/` 配下の以下のファイル群。パイプライン(§7)の各ステップは、このうちの特定ファイルを入力し特定ファイルを出力する。中断・再開は `episode.json` の `status` で判定する。

```text
episodes/ep001-nobunaga/
├── episode.json          ← エピソード状態(契約)
├── research.md           ← 調査結果と出典(教義)
├── script.md             ← 台本。人間可読かつ機械可読(§5.4)
├── narration/
│   ├── L01.wav …         ← 行ごとの合成音声
│   └── narration.wav     ← 結合済みナレーション
├── timing.json           ← 行・フレーズ単位のタイムスタンプ(契約、§5.5)
├── storyboard.md         ← 視聴者体験設計とショット意図(教義、§7.4)
├── shots.json            ← ショットリスト = 映像実装の唯一の入力(契約、§5.6)
├── review/
│   ├── qa-report.json    ← Mechanical QA結果(契約)
│   ├── compliance.md     ← 準拠レビュー(合否)
│   └── viewer-sim.md     ← 疑似初見レビュー(助言)
└── out/
    ├── preview.mp4
    └── final.mp4
```

`episode.json`:

```json
{
  "episodeId": "ep001-nobunaga",
  "subject": "織田信長",
  "targetDurationSec": 75,
  "status": "scripted"
}
```

```ts
type EpisodeStatus =
  | "researched" | "scripted" | "voiced" | "storyboarded"
  | "implemented" | "qa_passed" | "reviewed" | "final";
```

## 5.4 `script.md`(台本の行形式)

人間がレビューでき、かつパーサ(`src/pipeline/parse-script.ts`)が決定的に読める形式。

```markdown
# ep001 織田信長

## [L01] hook
> おめでとうございます。あなたは死にました。

- delivery: deadpan
- pause_after_sec: 0.8

## [L02] setup
> 次の人生は戦国時代。生まれは尾張の大名家。悪くない、と思いましたね？
```

パース規則:

- `## [Lxx] <beat>` — 行ID(一意)とビートタグ。ビートタグは教義上のラベルであり、コードは検証しない
- 引用ブロック(`>`) — **TTSへ渡す文字列はこれのみ**。1行につき1引用ブロック
- 箇条書き — 演出注釈。`pause_after_sec` `speed_scale` はTTSパラメータとしてコードが解釈し、それ以外(`delivery` 等)はLLM向けヒントとして無視する

## 5.5 `timing.json`

TTS実行(`src/pipeline/tts.ts`)が出力する。VOICEVOXの合成クエリからフレーズ単位の長さを算出する。

```json
{
  "episodeId": "ep001-nobunaga",
  "totalDurationSec": 74.2,
  "lines": [
    {
      "lineId": "L01",
      "text": "おめでとうございます。あなたは死にました。",
      "startSec": 0.0,
      "endSec": 3.4,
      "phrases": [
        { "text": "おめでとうございます", "startSec": 0.0, "endSec": 1.6 },
        { "text": "あなたは死にました", "startSec": 2.4, "endSec": 3.4 }
      ]
    }
  ]
}
```

## 5.6 `shots.json`(システム全体の中核契約)

ストーリーボードを機械可読化したもの。**Remotionコンポジションはこのファイルだけを読んで映像を構築する。**

```ts
type ShotRole =
  | "hook" | "show" | "explain" | "contrast" | "foreshadow"
  | "withhold" | "reveal" | "payoff" | "gag" | "reframe";

type Shot = {
  shotId: string;              // "s01"
  lineIds: string[];           // このショットが担当するナレーション行
  startSec: number;            // timing.json由来。演出上の手動調整可
  endSec: number;
  role: ShotRole;
  scene: {
    component: string;         // レジストリ名(例 "DoodleCharacter")または "custom:<Name>"
    props: Record<string, unknown>;
  };
  assets: string[];            // assets/library.json の assetId 参照
  sfx?: { cue: string; atSec: number; gainDb?: number }[];
  intent?: string;             // 演出意図。人間とレビュアーが読む
};

type ShotsFile = {
  episodeId: string;
  fps: 30;
  resolution: { w: 1920; h: 1080 };
  narration: { file: string; durationSec: number };
  bgm?: { file: string; gainDb: number };
  shots: Shot[];
};
```

検証規則(`src/pipeline/validate-shots.ts`。違反はレンダリング前にエラー):

1. ショットは時間順で、隙間0.2秒超・重複を禁止。全体で `[0, narration.durationSec]` を被覆する
2. `scene.component` はレジストリ(§7.6)で解決可能であること
3. `assets` の全IDが `library.json` に存在し、ファイルが実在すること
4. `sfx[].cue` が `assets/audio/se/` に存在すること
5. 全 `lineIds` が `timing.json` に存在し、重複割り当てがないこと

## 5.7 `assets/library.json`(素材台帳)

```json
{
  "assets": [
    {
      "assetId": "char_nobunaga_panic",
      "kind": "character",
      "subject": "oda-nobunaga",
      "variant": "panic",
      "file": "characters/oda-nobunaga/panic.png",
      "source": "ai_image",
      "license": "generated",
      "approvedBy": "human"
    },
    {
      "assetId": "map_owari_1550",
      "kind": "map",
      "subject": "owari",
      "variant": "base",
      "file": "maps/owari-1550.svg",
      "source": "code_generated",
      "license": "original",
      "approvedBy": "human"
    }
  ]
}
```

- `kind`: `character | prop | map | background | se | bgm`
- `source`: `ai_image | code_generated | public_domain | licensed | user_provided`
- 全素材は登録時に人間のキュレーション(採用/却下)を経る。`approvedBy: "human"` のない素材は `shots.json` から参照できない

---

# 6. `channel/bible.md`(チャンネル教義)

チャンネルの人格を定義する**唯一の教義ファイル**。台本生成・ストーリーボード・素材生成・レビューの全工程でLLMが参照する。分冊しない理由: フィードバックの還元先ルーティング(§12)を単純にし、ルール間の矛盾を1ファイル内で目視検出可能にするため。

サイズ上限800行。超過する追記を行う場合は、既存記述の整理・削除を同時に行う(肥大の単調増加を禁止する)。

## 6.1 必須セクション構成

| § | セクション | 必須内容 |
|---|---|---|
| 1 | チャンネルの約束 | コンセプト、視聴者への約束、品質優先順位 |
| 2 | 視聴者 | 年齢層、知識レベル、視聴動機、離脱要因 |
| 3 | ナレーター人格と文体 | 人称、性格、文長、専門語の扱い、固有名詞密度の上限感 |
| 4 | 台本構造 | フック、展開、回収の指針。時間はすべて目安として書く |
| 5 | 笑いの規則 | 許可する笑い / 禁止する笑い / 笑いの機能分類 |
| 6 | 物語アークのメニュー | 複数のアーク型と、題材ごとの変奏の義務(§6.3) |
| 7 | 視聴者体験設計の手引き | §6.4に定める設計語彙 |
| 8 | 映像スタイル | 基調スタイルと意味→映像のマッピング |
| 9 | ジャンル文法(歴史) | 時間・地理・勢力・因果・史料の扱い。避けるべき定型 |
| 10 | 素材戦略 | 取得優先順位と各素材種の方式(§8.1) |
| 11 | 音の設計 | SE/BGMの役割、笑いと音の関係、音量の考え方 |
| 12 | 禁止事項 | 史実捏造、差別表現、被害者侮辱、その他チャンネル固有の禁止 |

## 6.2 記述例(§5 笑いの規則 の抜粋)

```markdown
### 許可する笑い
- 現代常識とのギャップ / 主人公の過剰な不運 / ナレーターの皮肉
- 視覚的な誇張 / 反復を確立した後のパターン破壊

### 禁止する笑い
- 被害者への侮辱 / 史実を完全に捏造するギャグ
- 同じ死亡ネタの反復 / 差別表現

### 笑いの機能
すべてのジョークは release(緊張の解放)、contrast(対比)、
characterization(人格提示)、transition(場面転換)のいずれかの機能を持つこと。
機能のないジョークは削る。目安として20〜30秒に1回、連続は2回まで。
```

## 6.3 物語アークはメニューであり、テンプレートではない

固定アークの全動画適用は「構造の再放送」を生む。`bible.md` §6には複数のアーク型(例: 転落型 / 誤解破壊型 / 皮肉な成功型)を列挙し、**台本ごとに題材の史実に合わせてアークを選択・変奏することを義務**として書く。2本連続で同一アーク・同一ビート順を使うことを避ける指針も明記する。

## 6.4 視聴者体験設計の語彙(§7の手引きに含める内容)

以下はすべて教義(散文)であり、ストーリーボード作成時の思考ツールとして使う。JSONにしない。

- **中心の問い**: 動画全体を牽引する1つの疑問。冒頭で開き、終盤で回収する
- **開く / 部分回答 / 回収**: 問いをいつ開き、どこで部分的に答え、どこで回収するか
- **視聴者状態の入口と出口**: 各シーンの前後で、視聴者が知っていること・思い込んでいること・感じていること・次に期待することがどう変わるか
- **Reveal / Withhold**: 情報を即時に全部見せない。何を隠し、いつ、どの方法で明かすか
- **ショットの役割**: 全ショットを show と explain だけにしない(役割分類は§5.6の `role`)
- **パターンと破壊**: 意図的に反復パターンを確立し、重要な瞬間に崩す
- **モチーフの再登場**: 同じ形・色・音を、意味を変えて再登場させる
- **ピーク予算**: 最大の色・音・速度・新規性を序盤で使い切らず、クライマックスに予約する
- **音との同期**: 映像を先に見せて予感させる(lead)/ 同時に確定する(confirm)/ 音を先に聞かせ映像で回答する(lag)。どれにするかはストーリーボードで人間とLLMが判断する。音声解析による自動判定は行わない

---

# 7. 動画生成パイプライン(`/video-create`)

## 7.1 全体フロー

各ステップの入出力は§5の契約に対応する。ステップ完了ごとに `episode.json` の `status` を更新し、中断・再開を可能にする。

| # | ステップ | 実行者 | 入力 | 出力 |
|---|---|---|---|---|
| 1 | 調査 | fact-checkerエージェント | 題材名 | `research.md`(出典つき) |
| 2 | 台本 | メインコンテキスト | `research.md` + `bible.md` | `script.md` |
| 3 | ファクトチェック | fact-checkerエージェント(新規コンテキスト) | `script.md` + `research.md` | 指摘一覧 → 台本修正 |
| 4 | TTS | `src/pipeline/tts.ts` | `script.md` + `voice.json` | `narration/*.wav` + `timing.json` |
| 5 | ストーリーボード | メインコンテキスト | `script.md` + `timing.json` + `bible.md` §6-7 | `storyboard.md` |
| 6 | ショットプラン | メインコンテキスト | `storyboard.md` | `shots.json`(検証済み) |
| 7 | 素材取得 | メイン + `gen-image.ts` | `shots.json` の `assets` | 素材ファイル + `library.json` 登録 |
| 8 | シーン実装 | メインコンテキスト | `shots.json` | コアコンポーネントのprops設定 + カスタムシーン実装 |
| 9 | プレビュー + Mechanical QA | `qa.ts` | `out/preview.mp4` | `qa-report.json` |
| 10 | LLMレビュー | compliance-reviewer + audience-sim(各新規コンテキスト) | 成果物一式 | `compliance.md` + `viewer-sim.md` |
| 11 | 人間レビュー → 最終レンダリング | 人間 | `preview.mp4` + レビュー結果 | `final.mp4` |

## 7.2 台本(ステップ2)

`bible.md` の§1〜6に準拠して書く。行単位(§5.4)で書き、各行は1つの発話単位。ステップ4以降のタイミングはすべてこの行を単位に扱われる。

## 7.3 TTSとタイミング(ステップ4)

- `script.md` の各行をVOICEVOXで個別に合成し、`pause_after_sec`(未指定なら `voice.json` のデフォルト)の無音を挟んで結合する
- タイミングは合成クエリの返すモーラ長から算出する。**外部の強制アラインメントツールは使わない**(合成エンジン自身が正確な時刻を知っているため)
- 音声の演技的な間(ま)は、`pause_after_sec` と行分割で台本側が制御する。合成後の音声を解析して演出判断を行う工程は存在しない

## 7.4 ストーリーボード(ステップ5)

`storyboard.md` は教義文書であり、次のセクションを必須とする。

1. **中心の問い**と、開く/部分回答/回収の時刻(`timing.json` の実時刻で書く)
2. **視聴者状態の入口と出口**(散文。§6.4の語彙で)
3. **シーン一覧**: 各シーンに setup / turn / landing を1行ずつ
4. **ショット表**: shotId、担当行、role、演出意図、必要素材、SEキュー

ショット表がそのまま `shots.json` の下書きになる。role が show / explain に偏っていないかはここで自己点検し、最終的にはレビュアー(§10.3)が検証する。

## 7.5 Remotionによる実装(ステップ8)

- `src/remotion/Episode.tsx` は `shots.json` と `timing.json` をinput propsとして受け取り、各ショットを `<Sequence>` に変換する
- `scene.component` はレジストリ(§7.6)で解決する。propsはそのままコンポーネントへ渡す
- 音声トラック: `narration.wav` + BGM + `sfx` キューの `<Audio>` 要素。ミキシングはRemotion内で完結する
- 字幕: `timing.json` のフレーズ単位で自動生成し、全ショットに重畳する

## 7.6 コンポーネントレジストリとカスタムシーン

`src/scenes/registry.ts` が名前→Reactコンポーネントの対応を持つ。**コアコンポーネントはMVPで6個**とし、事前実装はこれ以上増やさない。

| コンポーネント | 役割 |
|---|---|
| `DoodleCharacter` | キャラクター表示。素材PNG + 位置/拡縮/回転/揺れ/潰れ(motionヘルパー) |
| `DoodleMap` | SVG地図。領域の色変化、ズーム、進軍矢印 |
| `SpeechBubble` | 吹き出し・ツッコミテキスト |
| `DangerCircle` | 手描き風の赤円・包囲・強調 |
| `ComparisonSplit` | 二分割比較(兵力差、before/after) |
| `TitleCard` | タイトル・章見出し・エンドカード |

- 動きの語彙は独立ライブラリにせず、`src/motion/` のヘルパー関数(popIn / squash / shake / slideIn / crowdMultiply / fallImpact 程度)としてコンポーネントから使う
- 使用頻度の制限(「1分に3回まで」等)はコードで執行せず、教義(`bible.md` §8)とレビュアー観点に置く
- **一回限りの特殊シーン**(フック、クライマックスの重要変換)は、`src/scenes/episodes/<epId>/` に通常のRemotionコンポーネント(React/SVG/Canvas自由)として実装し、`custom:<Name>` でレジストリ登録する。特殊シーンのための独立基盤は設けない
- エピソード3本を通じて再利用されたカスタムシーンは、コアコンポーネントへ昇格させる(§12の還元対象)

---

# 8. 素材戦略と取得パイプライン

## 8.1 取得優先順位

ショットごとに、上から順に検討する(教義として `bible.md` §10にも記載)。

```text
1. Channel Asset Library(既存素材の再利用)
2. コード生成(SVG / Canvas)         ← 数字・比較・地図・図形・小物
3. パブリックドメイン / 許諾済み素材   ← 史料・肖像画
4. AI画像                            ← キャラクター・背景・複雑な小物
(AI動画は使用しない)
```

| 素材の種類 | 方式 |
|---|---|
| 数字、比較、因果、タイムライン | SVG / Canvas(コード生成) |
| 地図、勢力図、移動 | SVG(歴史的事実は `research.md` の出典と整合させる) |
| キャラクター、表情 | AI画像(§8.3のワークフロー) |
| Doodle小物 | SVGを第一候補、複雑ならAI画像 |
| 史料・実在資料 | パブリックドメインまたは許諾済みのみ |
| 字幕、UI | Remotion |

## 8.2 素材登録の原則

- 生成・取得した素材は人間キュレーション(採用/却下)を経て `library.json` へ登録する(§5.7)
- 却下率も含めた生成回数を `metrics.imageGenCount` に記録する

## 8.3 キャラクター素材ワークフロー(最重要リスク項目)

AI画像によるキャラクター一貫性は本システム最大の技術リスクである。以下のワークフローで管理し、自動正規化(生成後の画像を加工して画風統一する処理)には**依存しない**。

```text
1. リファレンス生成:
   固定スタイルプロンプト(bible.md §8から生成)で正面・neutral立ち絵を複数生成
   → 人間が正典(canonical)を1枚選定
2. バリアント生成:
   正典画像を参照画像として入力し、表情・ポーズ差分を生成
   → スタイルプロンプトは全バリアントで同一文字列を使う
3. 背景除去: rembg で透過PNG化
4. キュレーション: 人間が採用/却下。不合格は再生成(最大3回。それでも不合格なら
   そのバリアントを諦め、ショット側の演出を変更する)
5. 登録: library.json へ
```

MVPのバリアント上限: **1人物あたり 表情4種(neutral / panic / deadpan / shock)× 代表ポーズ2種、最大8枚**。それ以上の表現差はmotionヘルパー(揺れ・潰れ・跳ね)と演出で作る。動きの少なさを画像枚数で解決しない。

人物固有の識別特徴(髪型、衣装、家紋など)は、バリアント生成プロンプトに固定文字列として含め、`research.md` の時代考証と整合させる。

## 8.4 フォールバック

```text
AI画像が規定回数内で合格しない
↓
SVG / コード生成で代替(記号的表現に切り替え)
↓
タイポグラフィ演出で代替
```

## 8.5 プロバイダインターフェース

TTSと画像生成は `src/pipeline/` 内で単一のインターフェースに隔離し、モデル・サービスの差し替えがパイプラインの他工程へ波及しないようにする。

```ts
interface TtsProvider {
  synthesize(line: ScriptLine, voice: VoiceConfig): Promise<{ wav: Buffer; phrases: PhraseTiming[] }>;
}
interface ImageProvider {
  generate(prompt: string, referenceImage?: Buffer): Promise<Buffer>;
}
```

---

# 9. 音の設計

コメディの笑いの半分は音で作られる。音響は独立した工程としてパイプラインに組み込む。

- **SE**: 無料ライセンスライブラリからチャンネル用SEセット(15〜30個: ズコー、ドン、ヒュー、ポン等)をStage 1で事前キュレーションし、`assets/audio/se/` + `library.json` に登録する。ショットへの割り当ては `shots.json` の `sfx` キュー(§5.6)
- **BGM**: MVPは1〜2曲をループ使用。`shots.json` の `bgm` で指定
- **ライセンス**: 全音声素材の出典と利用条件を `assets/audio/LICENSES.md` に記録する。記録のない素材は使用禁止
- **ラウドネス**: 最終出力は -14 LUFS目標。Mechanical QA(§10.1)で計測する
- SEの使い方の指針(笑いの直前に置く、無音を作ってから鳴らす等)は教義として `bible.md` §11に書く

---

# 10. レビューシステム

## 10.1 Mechanical QA(コード、`src/pipeline/qa.ts`)

`preview.mp4` に対して機械検査を行い、`review/qa-report.json` を出力する。

| チェックID | 内容 | 実装 |
|---|---|---|
| `black_frames` | 黒フレーム検出 | ffmpeg blackdetect |
| `silence` | 意図しない長無音(2.0秒超) | ffmpeg silencedetect |
| `duration_match` | 動画尺とナレーション尺の差が0.5秒以内 | ffprobe |
| `loudness` | -14 LUFS ±1 | ffmpeg loudnorm(計測モード) |
| `resolution_fps` | 1920x1080 / 30fps | ffprobe |
| `assets_resolved` | shots.json参照素材の実在(レンダリング前) | validate-shots.ts |
| `frozen_video` | 長時間の完全静止(3.0秒超) | ffmpeg freezedetect |

```json
{
  "episodeId": "ep001-nobunaga",
  "pass": false,
  "checks": [
    { "id": "black_frames", "pass": true },
    { "id": "silence", "pass": false, "detail": "12.4s-15.1s に2.7秒の無音" }
  ]
}
```

## 10.2 Compliance Reviewer(LLM、合否権あり)

- 専用サブエージェント(`compliance-reviewer.md`)を**新規コンテキスト**で起動する。制作時の文脈・言い訳を持ち込ませない
- 入力: `bible.md` + `review-checklist.md` + `script.md` + `storyboard.md` + `shots.json`(+ 必要に応じてサンプリングしたフレーム画像)
- 検査対象: 台本と映像の整合 / 史実(`research.md` の出典との整合)/ 禁止事項 / チャンネル教義への準拠
- 出力: `review/compliance.md`。判定は PASS / FAIL、違反ごとに `bible.md` の該当セクションを引用する

## 10.3 Audience Sim(LLM、助言のみ)

**疑似初見レビュー**。実際の動画視聴の代替ではないことを明示した上で、初見視聴者の知識状態を近似する。

- 専用サブエージェント(`audience-sim.md`)を新規コンテキストで起動する。`bible.md` と制作意図は**渡さない**
- 台本の行とショットの `intent` を**時系列順に逐次開示**し、ビートの区切りごとに次を回答させる:

```json
{
  "atSec": 15.2,
  "whatDoYouKnow": "主人公は包囲されている",
  "whatAreYouWaitingFor": "どう脱出するか",
  "whatDoYouPredictNext": "奇襲",
  "wouldContinue": true
}
```

- 併せて創作批評観点(最も普通な箇所 / 説明しすぎ / 意図のない派手さ / AI臭さ / パターン破壊の余地 / クライマックスの弱さ)を出力する
- 出力: `review/viewer-sim.md`。合否権は持たない

## 10.4 人間レビュー(最終教師)

- LLMレビューは人間レビューの前段ゲートにすぎない。**出荷判定は常に人間**
- 人間のフィードバックは、単発修正(このエピソードのみ)とシステム還元(`/channel-refine`)に分類してから対応する

---

# 11. スキルとエージェント(最小構成)

## 11.1 プロジェクトスキル(2個)

| スキル | 役割 |
|---|---|
| `/video-create <題材>` | §7のパイプラインを実行する。`episode.json` の `status` から再開可能 |
| `/channel-refine <フィードバック>` | §12の還元プロセスを実行する |

チャンネル状態の確認は `.channel-system.json` と `episodes/*/episode.json` を読めば足りるため専用スキルを設けない。バージョン固定はgit tagで行う。

## 11.2 サブエージェント(3個)

| エージェント | 役割 | 合否権 |
|---|---|---|
| `fact-checker` | 調査(出典つき)と台本の史実検証 | 指摘のみ |
| `compliance-reviewer` | §10.2 | **あり** |
| `audience-sim` | §10.3 | なし |

台本執筆・ストーリーボード・シーン実装はメインコンテキストで行う。これらは工程間で大量の共有状態(教義+エピソード全ファイル)を必要とし、分離のコストが利益を上回るため。

---

# 12. `/channel-refine`(システム還元の契約)

フィードバックをシステムへ還元する唯一の経路。**勝手に書き換えない**ことを契約とする。

```text
入力: フィードバック(例:「説明が長い」「リアクションが単調」)
↓
1. 分類: 単発修正(エピソード限り) or システム還元(再発し得る)
↓
2. 還元先の特定: bible.mdの該当セクション / review-checklist.md /
   コンポーネント・motionヘルパー / 素材ワークフロー
↓
3. 変更提案の提示(適用前に必ず人間へ):
   - 変更diff
   - 根拠(元のフィードバック)
   - 期待される観測可能な効果(次の動画のどこがどう変わるはずか)
   - 既存ルールとの矛盾チェック結果
↓
4. 人間承認 → 適用 + CHANGELOG.md へ記録
↓
5. (推奨)影響範囲のショットのみ再生成して効果を確認
```

CHANGELOG.md の記録形式:

```markdown
## 2026-07-06
- 契機: Pilot ep001 フィードバック「人物のリアクションが単調」
- 変更: bible.md §3 に感情の起伏指針を追記 / 素材ワークフローの表情バリアントに shock を追加
- 期待効果: 次エピソードで1シーンあたりの表情変化が増える
```

運用規則:

- `status: "approved"` のシステムでは、`bible.md`・`voice.json`・コアコンポーネントの変更は本プロセス経由のみ(hookで警告、§14)
- `bible.md` の800行上限(§6)を超える追記は、既存記述の整理を同時に提案する
- 「面白さ」に回帰テストは書けない。効果検証は次エピソードの人間レビューで行い、効かなかった変更はCHANGELOGを根拠に巻き戻す

---

# 13. `CLAUDE.md`(生成プロジェクトの憲法)

```markdown
# Project identity
このリポジトリは「〇〇に転生したら最悪だった件」専用のYouTube動画制作システムである。

# Source of truth
- channel/bible.md        … チャンネル教義(人格・文法・スタイル)の唯一の定義
- channel/voice.json      … ナレーション音声の定義(変更禁止)
- src/schemas/            … 全データ契約のスキーマ

# Mandatory rules
- 台本・映像・素材の判断はすべて bible.md に従う
- コードが読むファイル(shots.json 等)にはスキーマ検証を通らない値を書かない
- 素材は library.json 登録済み(人間承認済み)のみ使用する
- 再発し得る問題は /channel-refine で還元し、直接 bible.md を書き換えない
- 承認済みシステム(status: approved)の教義・声・コアコンポーネントを
  破壊的変更しない
```

---

# 14. Hooks

演出判断ではなく、必ず実行すべき機械処理のみに使う。

| トリガー | 処理 |
|---|---|
| `channel/` `episodes/**/*.json` の変更後 | JSON Schema検証(`src/schemas/`) |
| `src/**/*.ts(x)` の変更後 | typecheck / lint |
| レンダリング完了後 | Mechanical QA(§10.1)の自動実行 |
| `status: "approved"` 状態での `bible.md` / `voice.json` / `src/scenes/core/` 変更 | 警告(/channel-refine経由でない変更のブロック) |

---

# 15. コスト・時間モデル

「量産」の成立可否は実測で判断する。着手前の概算(60〜90秒Pilot 1本あたり)は以下の桁を想定する。

| 項目 | 概算 |
|---|---|
| TTS | ¥0(VOICEVOXローカル) |
| AI画像 | 8〜20回生成(リトライ込み)= 数十〜数百円 |
| SE / BGM | ¥0(無料ライセンス事前キュレーション) |
| Claude Codeセッション | 数時間規模(初回はセットアップ込みで最大数日) |
| レンダリング | 数分〜十数分(ローカル) |

各エピソード完了時に実測値を `.channel-system.json` の `metrics` へ記録し(§5.1)、以下の判断に使う。

- **量産判断**: 2本目の `wallClockHours` が1本目から十分に減っているか
- **長尺化判断**: 60〜90秒→8分はショット数・素材数が概ね5〜10倍になる。Pilot実測値×倍率で許容可能かを判断してから移行する。Pilotの承認は8分動画の実現可能性を保証しない

---

# 16. Stage 1 の実装順序

各ステップは動作確認可能な成果物で終わる。**最大リスク(レンダリングの垂直スライス)から着手し、教義の整備はパイプラインが通ってから行う。**

| # | タスク | 完了確認 |
|---|---|---|
| 1 | Remotion骨格 + ハードコードしたテストコンポジション | mp4が1本レンダリングされる |
| 2 | VOICEVOX統合(`tts.ts`)+ 固定サンプル台本からの `timing.json` 生成 | 音声と `timing.json` が一致する |
| 3 | `shots.json` スキーマ + `Episode.tsx`(シーンはプレースホルダ矩形) | shots.jsonを書き換えると動画が変わる |
| 4 | `script.md` パーサ + 検証スクリプト + hooks | 不正な台本・ショットがエラーになる |
| 5 | 声の選定(人間試聴)→ `voice.json` 固定 | 人間が承認 |
| 6 | キャラクター素材ワークフロー(§8.3)で信長素材8枚 | 8枚が同一キャラクターに見える(人間判定)。**ここが最初の主要関門** |
| 7 | コアコンポーネント6個 + motionヘルパー | 各コンポーネントの単体プレビュー |
| 8 | SE/BGMキュレーション + 音声ミキシング | sfxキューが鳴る |
| 9 | Mechanical QA(`qa.ts`) | 既知の欠陥入り動画で全チェックが発火する |
| 10 | `bible.md` 初版 + スキル2個 + エージェント3個 | `/video-create 織田信長` が通しで動く |
| 11 | **Pilot ep001(織田信長、60〜90秒)完成** | §17のStage 1ゲート判定 |

タスク6が不合格の場合(AI画像でキャラクター一貫性が得られない場合)、キャラクターをSVGパペット(コード生成、完全一貫)に切り替える判断をここで行う。この判断を後工程まで持ち越さない。

---

# 17. 受け入れ基準(ステージゲート)

各基準に判定者を明記する。判定者が「人間」の基準は主観判定であり、それを測定可能であるかのように扱わない。

## Stage 1 ゲート(H0の検証)

| 基準 | 判定者 |
|---|---|
| `/video-create 織田信長` がエンドツーエンドで完走し、`final.mp4` が出力される | 機械 |
| Mechanical QA全チェック合格 | 機械 |
| Compliance Reviewer合格(史実・禁止事項・教義準拠) | LLM |
| キャラクターが全ショットで同一人物に見える | 人間 |
| ナレーションの声と間がチャンネルの人格として成立している | 人間 |
| 「この方向で公開レベルまで持っていける」と判断できる | 人間 |
| 実測コスト・時間が許容範囲(metrics記録済み) | 人間 |

**不合格時**: 原因が(a)素材一貫性ならSVGパペット転換、(b)TTS演技力なら音声プロバイダ再選定または「音に依存しない笑い」への教義転換、(c)コストなら尺・ショット密度の削減。3つとも不成立ならH0棄却であり、構想自体を再検討する。

## Stage 2 ゲート(H1の検証)

| 基準 | 判定者 |
|---|---|
| `/video-create ナポレオン` が完走する(新規コード実装はカスタムシーンのみ) | 機械 |
| 2本が同じチャンネルに見える(画風・人格・テンポ) | 人間 |
| 2本目が1本目の構造の再放送に見えない(アーク・ビートの変奏が効いている) | 人間 |
| フィードバック→ `/channel-refine` → 承認 → 再生成の還元ループが最低1周し、変化が確認できる | 人間 |
| 2本目の制作時間が1本目より短い | 機械(metrics) |
| 素材再利用が発生している(library.jsonの参照実績) | 機械 |

## Stage 3 ゲート(H2の検証)

| 基準 | 判定者 |
|---|---|
| `channel-builder` が空ディレクトリをヒアリングからStage 1相当のFactoryへ変換する | 機械+人間 |
| 既存ファイルのあるディレクトリを破壊しない(§18.4) | 機械 |
| 生成されたFactoryでPilotが完走する | 機械+人間 |

---

# 18. Stage 3: channel-builder(メタスキル)の抽出仕様

本章はStage 2完了時の実測知見で確定する。**着手条件はStage 2ゲート通過**。以下は現時点で確定している骨子である。

## 18.1 配置と起動

```text
~/.claude/skills/channel-builder/
├── SKILL.md
├── references/     … ヒアリングフレームワーク / スキーマ定義 / 構築ガイド
├── templates/      … Stage 1〜2で安定したファイル群のテンプレート
└── scripts/        … プロジェクト判定 / 検証
```

起動: `/channel-builder`

## 18.2 モード判定

起動時に `.channel-system.json` を読み、モードを決定する。

| 状態 | モード | 動作 |
|---|---|---|
| ファイルなし | Build | ヒアリング → Factory構築 → Pilot |
| `status: building / pilot_iterating` | Refine | 未確定項目の補完、Pilot反復 |
| `status: approved` | Operate | `/video-create` 相当へ案内 |

## 18.3 Adaptive Interview

固定質問の一括表示ではなく、回答によって次の質問を変える。確認カテゴリ:

- **チャンネルの目的**: エンタメ / 教育 / コメディ / ファン化 / 商品販売 等
- **視聴者**: 年齢、知識レベル、視聴動機、テンポ、デバイス、長尺/Shorts
- **台本**: 人称、ナレーター人格、コメディ/教育/ドラマの重心、事実厳密性、表現水位
- **映像**: スタイル(Doodle / 漫画 / モーショングラフィックス / 史料中心 等)、色、キャラクター表現
- **素材**: 使える素材源、予算、商用利用条件
- **運用**: 尺、頻度、1本あたり予算、許容制作時間、人間レビュー量

終了条件: `bible.md` の全必須セクション(§6.1)を埋められる情報 + 技術選定(声・画像モデル)+ Pilot題材が確定すること。不明点が残ってもPilotで確認可能なら、仮説であることを明記して先へ進む。

**ヒアリングの出力は `bible.md` と `voice.json` と `.channel-system.json` であり、独自の中間フォーマットを作らない。**

## 18.4 ディレクトリ保護

起動時に確認: Gitリポジトリか / 未コミット変更 / 既存 `package.json` / 既存 `CLAUDE.md` / 既存 `.claude/` / 書き込み権限。

原則:

- 既存ファイルを上書きしない。同名ファイルはmerge案を提示する
- `.channel-system.json` が存在する場合は再初期化しない
- 必要ならサブディレクトリに構築する

## 18.5 テンプレート化の対象

Stage 1〜2の成果物のうち、チャンネル非依存だった部分がテンプレートになる(スキーマ群、パイプラインコード、Episode.tsx、QA、hooks、スキル/エージェント定義)。チャンネル依存部分(bible.md、コンポーネントの見た目、素材)はヒアリング+生成で埋める。**この境界線の実データがStage 2で得られるため、本章の確定はそれを待つ。**

---

# 19. リスク登記簿

| # | リスク | 影響 | 検出時点 | 対応 |
|---|---|---|---|---|
| 1 | AI画像のキャラクター一貫性が得られない | H0棄却級 | Stage 1 タスク6 | SVGパペットへ転換(§16) |
| 2 | TTSが「冷静だが意地悪」な人格・コメディの間を演じられない | 笑いの半減 | Stage 1 タスク5 | 話者再選定 / 行分割とpause制御の強化 / 音に依存しない視覚的笑いへ教義転換 |
| 3 | `/channel-refine` によるルールの肥大・矛盾蓄積 | 長期的な品質劣化 | Stage 2以降 | 800行上限 + 追記時の整理義務 + CHANGELOG根拠の巻き戻し(§12) |
| 4 | 60〜90秒→8分のスケール跳躍でコスト・使い回し感が非線形悪化 | 量産計画の破綻 | Stage 2完了後 | metrics実測×倍率で事前判断。中間尺(3分)を挟む(§15) |
| 5 | 固定アークによる「構造の再放送」 | 2本目で発覚 | Stage 2ゲート | アークのメニュー化と変奏義務(§6.3) |
| 6 | 疑似初見レビューが実視聴者の反応と乖離 | 品質評価の過信 | 公開後 | 助言に格下げ済み(§10.3)。最終教師は人間+公開後実測 |

---

# 20. 最終原則

本システムの価値は、どんな動画でも直接作ることではない。

```text
1本を本当に作り切る(Stage 1)
↓
2本目でチャンネルとしての同一性と変奏を証明する(Stage 2)
↓
その過程で安定した構造だけをテンプレートとして抽出する(Stage 3)
↓
ヒアリングから任意チャンネルのVideo Factoryを構築する
```

最終的に目指すものは、動画生成AIではない。**YouTubeチャンネルごとの動画制作OSを生成するClaude Code Skill**である。ただしOSを名乗る資格は、その上で実際に動画が2本完成した後にのみ生じる。
