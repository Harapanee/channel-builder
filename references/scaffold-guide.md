# Scaffold Guide — templates/ の展開手順

`templates/` はチャンネル非依存の Channel Video Factory 一式である。SKILL.md ステップ4はこのガイドに従って展開する。**展開の完了条件は末尾「検証コマンド4種」が全部通ること。** 通るまで次(映像スタイル適用・素材初期化・Pilot)へ進まない。

Stage 1〜2(織田信長・ナポレオンの2本)で安定した部分だけをテンプレート化してある。実測でスモークテスト(ep000-test を 1920×1080/30fps/10秒でレンダリング)が通ることを確認済み。

---

## 1. ファイルマニフェスト

「調整」列: **なし**=そのまま使う / **プレースホルダ**=§2の置換で埋まる / **要ヒアリング**=bible/voice の内容で人間が書く / **展開時**=展開手順で生成・改名する。

### ルート(新チャンネルフォルダ直下)

| パス | 役割 | 調整 |
|---|---|---|
| `package.json` | 依存とnpmスクリプト定義 | なし(※ `name` は任意で channelId に変えてよい。既定値は無害) |
| `package-lock.json` | 依存ロック | なし |
| `tsconfig.json` | TypeScript設定 | なし |
| `remotion.config.ts` | publicDir を `public/` に固定(.env等を配信対象から外す) | なし |
| `.gitignore` | secrets/生成物/`.channel-refine-approved` を除外 | なし |
| `CLAUDE.md` | プロジェクト憲法(source of truth と必須規則) | プレースホルダ(`{{CHANNEL_NAME}}`) |
| `.channel-system.json` | システム状態(status/version/metrics)。channel-builder のモード判定の起点 | プレースホルダ(`{{CHANNEL_ID}}`/`{{CHANNEL_NAME}}`)。初期 status:"building"/stage:1/version:0.1.0 |
| `CHANGELOG.md` | /channel-refine の変更履歴(初期は空テンプレート) | なし |

### channel/(教義・契約・レビュー観点)

| パス | 役割 | 調整 |
|---|---|---|
| `channel/bible-template.md` | **チャンネル教義の骨格**。→ 展開時に `channel/bible.md` へ改名して埋める | 展開時+要ヒアリング(§3参照) |
| `channel/voice-template.json` | 音声定義のひな型。→ 展開時に `channel/voice.json` へ改名 | 展開時+声の選定(SKILL.md ステップ3) |
| `channel/review-checklist.md` | compliance-reviewer の検査観点 | なし(bibleの禁止・構造に合わせ SKILL.md ステップ7で微調整) |

### .claude/(ハーネス設定・スキル・エージェント)

| パス | 役割 | 調整 |
|---|---|---|
| `.claude/settings.json` | Edit/Write の PreToolUse(保護)+ PostToolUse(契約検証)hook 登録 | なし |
| `.claude/skills/video-create/SKILL.md` | エピソード制作パイプライン | なし(creditは voice.json 参照に汎用化済み) |
| `.claude/skills/channel-refine/SKILL.md` | システム還元(マーカー機構つき) | なし |
| `.claude/agents/fact-checker.md` | 調査+事実検証(genre は bible §1・§9 参照) | なし |
| `.claude/agents/script-director.md` | 台本執筆(署名は bible 参照、話速は voice.json 参照) | なし |
| `.claude/agents/visual-director.md` | 体験設計+ショット(映像マッピングは bible §8 参照) | なし |
| `.claude/agents/scene-implementer.md` | シーン実装(演出コード。三層規則・技術規則内蔵、model固定) | なし(creditは voice.json 参照に汎用化済み) |
| `.claude/agents/compliance-reviewer.md` | 準拠レビュー(合否権あり。三層規則・定量規則の機械検算つき) | なし |
| `.claude/agents/audience-sim.md` | 疑似初見レビュー(助言のみ) | プレースホルダ(`{{AUDIENCE_PERSONA}}`) |
| `.claude/agents/publisher.md` | 公開パッケージ生成(タイトル3案・サムネ3案スペック・概要欄)。bible §13 準拠、`thumbnails.json` の契約を持つ | なし |

### src/(パイプライン・スキーマ・シーン)

| パス | 役割 | 調整 |
|---|---|---|
| `src/schemas/` | shots/timing/library/episode の JSON Schema + `types.ts` | なし(※`$id` は `reincarnation-hell.local`。内部参照のみで無害) |
| `src/pipeline/` | parse-script / tts / retime-shots / validate-shots / qa / gen-image / remove-bg | なし |
| `src/remotion/` | `Root.tsx`(Composition定義)/ `Episode.tsx`(shots→Sequence組立)/ `Thumbnail.tsx`(サムネ静止画コンポジション 1280x720、§13) | なし |
| `src/motion/` | 揺れ・潰れ等の motion ヘルパー(noise) | なし |
| `src/scenes/core/` | **コアコンポーネント6個の参照実装**(DoodleCharacter/DoodleMap/SpeechBubble/DangerCircle/ComparisonSplit/TitleCard)+ PlaceholderBase | 映像スタイル(bible §8)で再スキン/再実装(SKILL.md ステップ5) |
| `src/scenes/style.ts` | パレット定義 | bible §8 の基調色に調整 |
| `src/scenes/doodle-svg.ts` | 手描き風SVGパス生成 | 画風が非Doodleなら差し替え |
| `src/scenes/asset-context.tsx` `use-doodle-font.ts` | 素材コンテキスト / フォント読込 | なし |
| `src/scenes/registry.ts` | component名→React の解決レジストリ。**`customRegistry` は空**で出荷。video-create がエピソード実装のたび追記 | なし |

### assets/(初期在庫)

| パス | 役割 | 調整 |
|---|---|---|
| `assets/audio/se/` (24) `assets/audio/bgm/` (2) | 実証済み効果音・BGMパック | 合わない場合のみ差し替え(bible §11) |
| `assets/audio/LICENSES.md` | 音源ライセンス(商用可・クレジット不要・**再配布禁止**) | なし(差し替え時のみ更新) |
| `assets/fonts/YuseiMagic-Regular.ttf` + `LICENSE.md` | 手描き風日本語フォント | 画風変更時のみ差し替え |
| `assets/library.json` | 素材台帳。**se/bgm の26件のみ登録済み**(キャラクター素材は含まない) | キャラ/場面素材を人間キュレーション後に追記 |

### episodes/ · docs/

| パス | 役割 | 調整 |
|---|---|---|
| `episodes/ep000-test/` | **レンダリングのスモークテスト用フィクスチャ**(§4参照)。`publish/thumbnails.json` は Thumbnail コンポジションの見本スペック(キャラ無しの文字主体3案) | なし |
| `docs/spec-v1.1.md` | 設計判断の根拠(全設計文書) | なし |

### 映像スタイルの選択肢(style-packs/)

`src/scenes/core/` のDoodle系6個はテンプレ既定の参照実装であり、唯一の選択肢ではない。bible §8(映像スタイル)が
別系統の場合、SKILL.md ステップ5で再実装する前に `<SKILL>/templates/style-packs/` の既製パックが使えないか確認する。

- **スライドショー型(PD/CC画像調達によるドキュメンタリー調)**: `style-packs/slideshow-pd/` を適用する。
  適用手順・依存関係(`src/scenes/style.ts` への追加要件等)は同パックの README.md 参照

---

## 2. プレースホルダ一覧と埋め方

置換は「テンプレートを展開先へコピーした後」に行う。対象は4ファイル(`.channel-system.json` / `CLAUDE.md` / `channel/bible-template.md`(→bible.md) / `.claude/agents/audience-sim.md`)。

| プレースホルダ | 何を入れるか | 出所 |
|---|---|---|
| `{{CHANNEL_NAME}}` | チャンネルの表示名(日本語可) | ヒアリング(コンセプト) |
| `{{CHANNEL_ID}}` | 英小文字・ハイフンのスラッグ(例 `roman-history-comedy`) | チャンネル名から命名 |
| `{{AUDIENCE_PERSONA}}` | audience-sim が演じる視聴者像を一句で(例「18〜34歳の歴史初心者」) | bible §2(視聴者) |

置換例(展開先ディレクトリで):

```bash
find . -type f \( -name '*.md' -o -name '*.json' \) -not -path './node_modules/*' -print0 \
  | while IFS= read -r -d '' f; do
      perl -pi -e 's/\{\{CHANNEL_NAME\}\}/<チャンネル名>/g; \
                   s/\{\{CHANNEL_ID\}\}/<channel-id>/g; \
                   s/\{\{AUDIENCE_PERSONA\}\}/<視聴者ペルソナ>/g' "$f"
    done
```

注意:

- `{{AUDIENCE_PERSONA}}` は audience-sim.md がbibleを読まない設計のため、**ペルソナを定義本文に直接埋める**(bibleへのリンクではだめ)。
- `voice.json` の値(speakerId/speedScale/creditNotice 等)はプレースホルダではなく、声の選定(SKILL.md ステップ3)で確定した実値を入れる。

---

## 3. 展開手順

```bash
# 0) 展開先の束縛: PROJ は必ず「ファクトリールートの絶対パス + 確認済みチャンネルフォルダ名」で
#    絶対パスとして組み立てる。`PROJ="$(pwd)"` などカレントディレクトリからの束縛は禁止
#    (スキルはファクトリールートで起動するため、pwd束縛はルート自体へ展開=ファクトリーを丸ごと変換する事故になる)
PROJ="<ファクトリールートの絶対パス>/<確認済みチャンネルフォルダ名>"   # 例: /Users/you/youtube/roman-history-comedy

#    新フォルダを作成し、「空」を確認してから展開する(SKILL.md「ディレクトリ保護」: 非空なら構築拒否)
mkdir -p "$PROJ"
ls -A "$PROJ"   # 何も出力されない(=空)ことを確認。出力があれば中止し、ユーザーに報告する

# 1) テンプレート一式をコピー(ドットファイル含む)
cp -R <SKILL>/templates/. "$PROJ/"

# 2) 教義・音声のひな型を live 名へ改名
mv "$PROJ/channel/bible-template.md"  "$PROJ/channel/bible.md"
mv "$PROJ/channel/voice-template.json" "$PROJ/channel/voice.json"

# 3) public/ に episodes/・assets/ のシンボリックリンクを張る
#    (remotion が staticFile() で参照する。publicDir をルートにしてはいけない)
mkdir -p "$PROJ/public"
cd "$PROJ/public" && ln -s ../episodes episodes && ln -s ../assets assets && ln -s ../shorts shorts && cd "$PROJ"

# 4) プレースホルダ充填(§2)/ bible・voice を人間承認まで埋める

# 5) 依存導入
npm install
```

`bible.md` は §2の骨格を、interview-framework の各カテゴリの回答で埋める。**不変規則(【不変規則】/【不変の禁止】と書かれた本文)は消さない。** `> 例(...)` の行は差し替える。埋め終えたら全文をユーザーに提示して承認を得る(人間ゲート1)。

### 検証コマンド4種(全部通るまで先へ進まない)

```bash
npm install                              # 1) 依存が入る(約200パッケージ)
npm run typecheck                        # 2) tsc --noEmit が exit 0
npm run validate episodes/ep000-test     # 3) 契約検証 "OK: ... 合格しました"
npm run render:test                      # 4) episodes/ep000-test/out/preview.mp4 生成
```

レンダリング結果は ffprobe で確認する(期待値: **1920×1080 / 30fps / 約10秒 / 300フレーム**):

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,nb_frames \
  -show_entries format=duration -of default=noprint_wrappers=1 \
  episodes/ep000-test/out/preview.mp4
```

初回 `render:test` は Remotion の Headless Shell をダウンロードするため時間がかかる/接続タイムアウトが出ることがある。その場合はもう一度実行する(2回目はキャッシュ済み)。

---

## 4. ep000-test について

チャンネルに一切依存しない**レンダリングのスモークテスト用フィクスチャ**。中身:

- `episode.json` / `shots.json` / `timing.json` / `narration/narration.wav`(10秒のテスト音声)
- 4ショット(hook→explain→gag→payoff)がコアコンポーネント4種(DoodleCharacter / DoodleMap / SpeechBubble / TitleCard)だけを使い、SEは同梱の `pop.wav` のみ、`assets` 参照は空。
- そのため**キャラクター素材が無くても render:test が通る**。scaffold が壊れていないことの最短の証明になる。
- 生成物(`out/preview.mp4`・`review/`)はテンプレートに含めない(.gitignore対象・再生成可能)。render:test が毎回生成する。

> 補足: TitleCard は `title`(必須)を使うため、ep000-test の payoff ショットは `props` に `title`/`variant`/`creditNotice` を明示的に渡している。コンポーネントに必須propsがある場合、空 `props: {}` では render 時に落ちる点に注意(validate-shots は props の中身までは検査しない)。

---

## 5. テンプレートに**含めない**もの(と理由)

| 除外物 | 理由 |
|---|---|
| `.env`(APIキー) | secret。チャンネルごとに人間が用意する(SKILL.md「.envには触れない」)。誤って配布すると鍵漏洩 |
| `episodes/ep001-*` / `ep002-*` 等の本番エピソード | チャンネル固有の成果物。Factoryの構造ではない |
| `assets/characters/` とキャラ素材の library エントリ | 題材ごとにAI生成+人間キュレーションで作る。汎用在庫にならない |
| `src/scenes/episodes/`(カスタムシーン実装) | エピソード固有。`registry.ts` の `customRegistry` も空で出荷し、video-create が追記する |
| `voice-samples/` / `node_modules/` / 各エピソードの `out/`・`narration/` | 生成物・依存。再生成可能で肥大要因 |

`bible.md` にはチャンネル横断の不変規則が本文として残っている(読点1文2個上限 / 間の予算 / 因果を飛ばさない / 諸説の断定禁止 / クレジット表記 / 素材の人間キュレーション)。これらは画風・題材が変わっても不変なので、新チャンネルでも必ず継承する。

---

## 追補(2026-07-07): 本番1本目までに追加された構成物

初版マニフェスト以降に追加され、templates/ に同梱済みのもの:

- **スキル**: `.claude/skills/system-refine/`(工場OS変更のテンプレ同期手順)
- **エージェント**: `script-reviewer`(台本合否)/ `asset-generator`(画像生成技能)/ `publisher`(公開パッケージ)/ `reading-checker`(TTS誤読検査、工程4の必須ゲート — tts.tsが出力する narration/readings.md を検査)
- **パイプライン**: `render-thumbs.ts`(サムネ、軽量ThumbRoot+再試行)/ `retime-shots.ts`(台本改訂の追従)
- **Remotion**: `Thumbnail.tsx` / `ThumbRoot.tsx`(サムネ合成、自動レイアウト+矢印アンカー)
- **共有シーン**: `src/scenes/shared/`(JapanMap+japan-geometry / TruckIsekai / ThreeFaces / Outro=固定アウトロ)+ `assets/maps/japan-doodle.svg`
- **契約拡張**: shots.json `bgmTracks[]`(章別BGM)/ validate-shotsのshotId一意性・bgmTracks検査
- **チャンネル署名の既定**: トラック転生OP(bible-template §4)/ 地図での位置提示 / サムネ構造(bible §13で方式を選択: AI生成1枚絵+事実型一言 / 既存素材の部品構成)
- 同期の健全性は SRC側の `scripts/check-template-sync.mjs` で機械検証する(/system-refine 参照)

## 追補(2026-07-08): レンダー運用の高速化で追加された構成物

- **スキル**: `.claude/skills/render-queue/`(夜間レンダーキューの消化。積むのは `scripts/render-queue.sh add`)
- **スキル(既存追補)**: `.claude/skills/theme-scout/`(ネタ帳の補充・再採点)/ `.claude/skills/factory-update/`(テンプレ最新OSの取り込み)+ エージェント `theme-scout`(題材採点)
- **パイプライン**: `qa-smoke.ts`(レンダー前スモークQA — 全ショット2フレームサンプリングでランタイムエラー・静止・黒を検出。video-create 工程9a)/ `repair-render.ts`(特定ショットのみ部分再レンダー+既存mp4へ継ぎ接ぎ)
- **Remotion**: `QASmokeRoot.tsx`(qa-smoke 用の軽量コンポジション)
- **スクリプト**: `render-episode.sh`(レンダー本体 — Infinityゲート・QA・状態書き出し内蔵)/ `wait-render.sh`(完了検知ウォッチャー)/ `promote-preview.sh`(preview→final無劣化昇格)/ `render-queue.sh`(夜間キュー add/run/list/clear)
- **video-create 工程9の二段化**: 9a スモークQA(NGゼロまでフルレンダー禁止)→ 9b フルレンダー(即時 or 夜間キューをユーザーに確認。即時はnohup+wait-renderの2段運用)
