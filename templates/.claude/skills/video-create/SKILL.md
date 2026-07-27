---
name: video-create
description: このチャンネルの新規エピソード動画を制作する。「/video-create 織田信長」のように題材を渡す。調査→台本→ファクトチェック→TTS→ストーリーボード→ショット→素材→シーン実装→検査→準拠レビュー→公開パッケージ→承認までを実行する(レンダーは承認後に夜間キューでサーバーが実行)。
---

# /video-create — エピソード制作パイプライン

**開始前に必ず `channel/bible.md` 全文と `.channel-system.json` を読むこと。**
各ステップ完了時に `episodes/<epId>/episode.json` の `status` を更新する(中断・再開の基盤)。

**工程5以降はHyperFrames経路**(HTML+CSS+GSAP)。Remotion時代の既存エピソードを工程5以降で再修正する場合のみ旧Remotion工程を用いる(手順は git 履歴の旧 SKILL.md を参照)。工程0〜4(調査・台本・審査・TTS)と工程11(公開パッケージ・サムネ)はRemotion/HF共通。ショート(9:16)は引き続きRemotionで作る。

**運用原則(モデル非依存)**: メインセッションの役割は監査・ゲート管理・ユーザー対話である。
台本(script-director)・絵コンテとショット(visual-director)・調査と検証(fact-checker)・
シーン実装(scene-implementer)・レビュー(compliance-reviewer / audience-sim)はすべて
専用エージェントへ委譲し、メインセッション自身が創作物を書かない。
これにより制作の品質はエージェント定義(=システム)が担保し、メインのモデルに依存しない。

**サブエージェントは必ず同期実行**: 委譲は必ず同一ターン内で結果を待って受け取り
(Agent/Taskツールは `run_in_background: false`)、監査してから次工程へ進む。
バックグラウンド起動して「完了通知を待つ」形でターンを終えることを禁止する —
ヘッドレス実行(Factory UI等の `claude -p`)ではターン終了=プロセス終了であり、
待っていたエージェントごと強制停止されてパイプライン全体が途中死する。

**コンテキスト規律(usage削減の中核)**: 履歴の肥大はusageとレート制限に直結する。

1. **委譲はパス渡し**: サブエージェントへの委譲プロンプトにファイル内容を貼らない。
   ファイルパス+読むべき節の指定で渡し、サブエージェント自身に読ませる。
   例外は本スキルが「逐語転記」を明示する箇所のみ(research.md「約束」節、backlog候補メモ)。
2. **報告は30行以内**: サブエージェントの最終報告は構造化サマリ(結論・合否・数値・成果物パス)
   30行以内とし、成果物の全文・長い引用を報告へ含めない。詳細は成果物ファイルに書く。
3. **メインは全文Readしない**: メインセッションの監査は、機械検査の出力(`lint:script` / HF `npm run check` / validate 等)と
   サブエージェントの構造化報告に基づいて判断する。報告に疑義がある場合も全文Readせず、
   該当箇所の抜粋Read(offset/limit指定)のみ。同一ファイルの再Readを繰り返さない。

## 0-a. 題材の決定(引数なしで呼ばれた場合)

題材が渡されなかったら、ネタ帳から選ぶ:

- `channel/backlog.md` が存在し状態「候補」が3件以上ある場合: 合計点上位5件を採点内訳・候補メモつきで提示し(AskUserQuestion)、選ばれた題材で以降の工程を進める
- 帳が無い、または「候補」が3件未満の場合: `/theme-scout` の実行を提案して停止する

**消し込み(開始)**: 題材が確定したら(引数あり起動で帳に同じ題材が載っている場合も含む)、backlog.md の該当行の状態を「制作中(<epId>)」へ更新する(更新は §0 で epId を確定した後に行う)。

## 0. 準備

- epId は `epNNN-<slug>`(例 ep001-<slug>)。`episodes/<epId>/episode.json` を作成(episodeId / subject / targetDurationSec / status: "researched"の前は無し→調査完了後に設定)
- VOICEVOX起動確認: `curl -s http://127.0.0.1:50021/version`

## 1. 調査 → `research.md`

fact-checkerエージェントに委譲。出典つき・確度(定説/有力/諸説)つきで、「フック候補(視聴者を掴む要素のランキング)」を含めること。
また「約束」節(仮タイトル1本+サムネ一言の方向+その約束を本編が回収できる根拠。docs/retention-principles.md 原則3)を必ず含めること。調査の結果、約束が成立しない(本編が回収できない)と判明した場合は台本へ進まず題材を差し戻す。
`channel/backlog.md` に該当題材の行がある場合、その候補メモ(フック・物語の当たり・多様性メモ)を委譲プロンプトへ丸ごと含める(theme-scoutの検討結果を初動に使い、切り口の再発明をさせない)。→ status: "researched"

## 2. 台本 → `script.md`

**script-directorエージェントへ委譲**(目標尺と題材に加え、research.md の「約束」節を委譲プロンプトへ逐語で転記する。執筆手順・セルフチェックはエージェント定義に内蔵)。
メインセッションはエージェントのセルフチェック報告を監査し、疑義があれば差し戻す。

**台本ドラフト受領後、audience-simを起動する**(合否権なし・助言のみ)。`script.md` のパスのみを渡す(bible.md・storyboard.md は渡さない)。
**この位置に置く理由**: 台本が可変な時点でしか初見の助言は反映できない。工程10で起動していた時期は助言が4本連続で「台本確定済みのため未対応=次話への申し送り」となり、出力が構造的に使われていなかった。
助言の採否はメインセッションが判断する(script-directorへの自動差し戻しはしない)。採用する指摘は script.md に反映してから工程3へ進む。
→ status: "scripted"

## 3. 台本の審査(機械lint → 二重審査は必ず並列)

(移行注記)新規主張リスト節を持たない既存エピソードを工程3から再開する場合は、先にメインセッションが script-director へ節の後付けのみを依頼してから lint に進む(1周の空BLOCKを防ぐ)。

1. **機械lint(先に実行 — 機械NGの台本でopusを呼ばない)**: `npm run lint:script episodes/<epId>` → 全項目緑になるまで script-director に修正を差し戻す(機械指摘の修正は審査周回に数えない)。lintが exit 2(入力不備)の場合は差し戻しではなくメインセッションが原因を直す。
2. lint緑後、**必ず並列で起動する**(直列起動は禁止。レート制限発生時のみ直列にフォールバック可):(並列とは**同一ターン内で複数のAgent tool_useを同時発行し、双方の結果を待って監査する**ことを指す — 冒頭原則どおりバックグラウンド起動は禁止)
   - **fact-checker**(新規起動): script.md の「新規主張リスト」の検証(research.md 突合+リスト分のみWeb確認)
   - **script-reviewer**(新規起動・**合否権あり**): 文脈・品質の審査。判定は PASS / ADVISE / BLOCK の三値。lint結果の緑の出力を入力として渡す。あわせて `channel/review-checklist.md` のパスを渡し、**`@script` タグの項目の判定**を求める(他タグの項目は判定させない)
3. **BLOCK** の指摘のみ script-director に差し戻して修正(**最大1周**。1周で解決しない論点はユーザーへエスカレーション)。**ADVISE** は差し戻さず、メインセッションが軽微修正を script.md に直接適用するか、見送る理由を判断して先へ進む(適用した場合は lint を再実行して緑を確認。**ADVISEの適用有無で再審査は起動しない** — 再審査の対象はBLOCKと契約違反のみ)。fact-checker が「契約違反(リスト漏れ)」を指摘した場合はBLOCK相当として script-director へ差し戻す(周回に数える)。**BLOCK修正後は手順1のlintから再実行し、緑を確認してから再審査を起動する(機械項目の再導入を防ぐ)。**
4. **再審査(2周目)は差分限定で起動する**: script-director の修正報告(修正した行IDと変更概要)を委譲プロンプトに含め、fact-checker へは「修正で追加・変更された主張のみ」、script-reviewer へは「修正行とその前後の文脈のみ+前回BLOCKの解消確認」を審査範囲として明示する(全文の再審査をさせない)。行IDは改訂で振り直さない(行ID安定規則: 挿入は枝番 `L84a` 形式、削除は欠番のまま残す — script-director 側の規則)ため、行の追加・削除だけでは全文再審査へ戻さない。全文再審査へ戻すのは、章の順序入替・章の統合分割など**骨格が変わった場合のみ**。

両方が通ってから工程4へ進む。**台本段階の修正コストは映像化後の1/10以下** — BLOCKでは妥協しない。

## 4. TTS → `narration/` + `timing.json`

- **誤読プリチェック(合成前・高速)**: まず `npm run tts episodes/<epId> -- --readings-only` で読み仮名レポート(narration/readings.md)だけを生成し(VOICEVOX audio_queryのみ・数十秒)、reading-checkerエージェント(合否権あり)で検査する。REVISEなら台本表記を修正して再プリチェック(**最大3周**。3周で解決しない読みはユーザーへエスカレーション)。**PASSしてから** `npm run tts episodes/<epId>` で本合成を1回だけ実行する(本合成はプリチェックと同じaudio_queryの読みで合成するため、表記が変わらない限り合成後の再検査は不要)
- 自己検証エラーが出たら台本表記を調整(読みの揺れ・難読語)
- PASSまで**工程7(素材)以降**へ進まない
- → status: "voiced"

## 5-6. ストーリーボード(HF版・clip表) → `storyboard.md`

**visual-directorエージェントへ委譲**(設計手順・多様性の定量規則はエージェント定義に内蔵)。成果物は `storyboard.md`(HF版・必須4セクション+**clip表**: clipId / 開始秒 / 尺 / lineIds / role / 演出記述 / 使用素材 / SE)**のみ**(shots.jsonは廃止)。
**二相で起動できる**: Phase A(clip表の概算時刻版)は script.md だけで設計できる(開始秒・尺は概算と明記させる。visual-director定義に内蔵)→ **台本審査PASS直後、必ず工程4のTTSと並行で開始する**(直列にしない。レート制限発生時のみ直列フォールバック可)。並行の実行形も同じ(同一ターン内で複数tool_useを同時発行して両方を待つ)。Phase B(clip表の実時刻化)は timing.json(実タイミング)確定後に行い、概算時刻を timing.json の実測行時刻へ置き換える。
**流れは「演出が先、素材が後」**: visual-directorは手持ち素材に縛られず演出を設計し(演出記述はWeb技術語彙で自由に。creative原則はエージェント定義に内蔵)、不足素材リストを storyboard.md に出す → 工程7で充足 → clip表の使用素材を確定。
**10分超は章並列**: 全体設計(Phase 1)→章グループ並列(Phase 2)→統合(Phase 3)。Phase 1の分担は**グループ間のclip数が±20%以内**になるよう均す(壁時計は最遅グループに律速される)。共有様式・スパイン演出は1グループが実装オーナー、他は同じ見え方を再現。
メインセッションは 多様性の自己計測表・role分布・不足素材リストの妥当性・**clip表とtiming.jsonの行被覆(欠落行ゼロ)の自己申告**を監査する。
→ status: "storyboarded"

## 7. 素材取得

各ショットの素材を bible §10 の優先順位で調達:

1. library.json の既存素材(assetIdで参照)
2. SVG/コード生成(地図・図形・小物)→ assets/maps/ 等に保存
3. AI画像(キャラ新バリアント・場所): **asset-generatorエージェントへ委譲**(プロンプトの型・身体語彙・失敗→修正表を内蔵。gen-image.tsを生のプロンプトで直接叩かない)。エージェントの成果物(コンタクトシート)を**ユーザーに提示して承認を得る** → library.json 登録(approvedBy: "human")
4. 新人物の正典が必要な場合も asset-generator の型1で候補生成 → ユーザー承認 → canonical.png として保存

**委任モード(auto)での承認**: コンタクトシートと asset-generator の自己評価を `episodes/<epId>/assets/` に保存した上で自動承認として進む(library.json の approvedBy は "auto" と記録し、工程12相当の最終確認で人間がまとめてレビューする)。semi / manual では従来どおり承認を待つ。

全新規素材を library.json に登録(kind/subject/variant/file/source/license/approvedBy)。

## 8. シーン実装 → `composition.html`

**scene-implementerエージェントへ委譲**(HF規約5点・三層規則・技術規則・音声/字幕配線はエージェント定義に内蔵。実装前に `hyperframes-core` / `hyperframes-animation` スキルを読ませる。メインセッションが演出コードを書かない — シーン実装は演出の質を最終決定する工程であり、エージェント定義のモデル固定が品質のモデル非依存を担保する)。成果物は `episodes/<epId>/composition.html`(storyboard.md のclip表を実装し、`assets/hf/<slug>-style.css` を link)。

- **10分超は章グループ並列で起動してよい**(visual-directorと同じ分担。共有様式・スパイン演出は実装オーナー1グループ、他は同じ見え方を再現)
- メインセッションの監査観点:
  - **`npm run check` 緑の報告(出力つき)**(HF: lint+runtime+layout+motion+contrast)
  - **ゼロ持ち越し**: 過去ep composition.html からの場面演出の流用が0件であること(過去エピソード由来の場面演出が1件でも混入していたら差し戻し)
  - composition.html の実装が storyboard.md の clip表と数・内容で整合すること
  - **テンプレ量産でないこと**: 単一factory/ヘルパーの文言差替え変種群は1演出と数える。実効演出数が定量規則を満たさなければ差し戻し
- → status: "implemented"

## 8.5 プレビュー早期確認(レンダリング前・推奨)

実装完了後、**レンダリングを焼く前に** HyperFrames プレビューでユーザーが確認できる:

```
cp episodes/<epId>/composition.html index.html   # HFのエントリはルートのindex.html。作業中epを指すよう必ず更新する
npm run dev   # 必ずbackgroundで起動。起動ログに出る http://localhost:<port> を開く
```

ブラウザ(hyperframes preview が表示するポート)でスクラブ・再生し、レイアウト・演出の問題をレンダー1周(30〜50分)を消費せずに発見する。音声ミックスの最終確認・QAはレンダー後のmp4で行う(プレビューは視覚の早期ゲート)。ユーザーがすぐ確認できない場合はスキップして次工程(検査)へ進んでよい。

## 9. レンダー前検査(日中・機械ゲートの前倒し)

夜間レンダーを一発で通すため、機械ゲートを日中に前倒しで実行する:

```
cp episodes/<epId>/composition.html index.html   # HFのエントリはルートのindex.html。作業中epを指すよう必ず更新する
npm run check   # check:visual(視覚多様性)→ HF lint+runtime+layout+motion+contrast
```

`check:visual` は評価済みDOMを読み、ユニーク画像密度・同一素材上限・連続する素材なしclip・AI比率・尺をBLOCK判定し、実効演出数(テンプレ量産)・ゼロ持ち越し・様式clip比率・縦長素材のフレーミングをADVISEで報告する。設定は `channel/visual-rules.json`(無いチャンネルはSKIP)。

composition.html の実行時エラー・レイアウト事故・モーション/コントラスト不足を、レンダー1周を消費せずに検出する。

- **check の NG は修正して再実行(修正ループは最大3周。3周で残るNGはユーザーへエスカレーション)**

全て緑になったら → status: "prechecked"

## 10. 準拠レビュー(フレーム検査。新規コンテキストのエージェント1体)

mp4 非依存(レンダー前で成立する):

- **compliance-reviewer**: bible.md + review-checklist.md + script/storyboard/composition に加えて、**工程9で実行した `npm run check` の出力を渡す**(エージェントに再実行させない)。判定するのは review-checklist.md の **`@frame` タグの項目のみ** — `@script`(工程3)・`@check`(工程9)・`@fact`(工程3)・`@assets`(工程7)・`@publish`(工程11)は担当ゲートが判定済みであり、ここでの再検査は禁止する。PASS/FAIL。FAILは修正して再レビュー(修正したら工程9の検査から再確認。**FAIL→再レビューは最大2周** — 2周で解決しなければユーザーへエスカレーション)。視覚検証のフレームは `hyperframes-cli` スキルの snapshot 系(指定時刻のフレーム抽出・エージェント定義に内蔵)で取得する — **レビューのためにフルレンダーを起動しない**(80秒動画で12分、通常尺で30分超の浪費を実測。フレーム十数枚で足りる)
- **audience-sim はこの工程では起動しない**(工程2へ移設済み)
- → status: "reviewed"

## 11. 公開パッケージ(タイトル・サムネ・概要欄 — finalレンダー前に作る)

**publisherエージェントへ委譲**: `publish/PUBLISH.md`(タイトル・概要欄)+ `publish/thumbnails.json`(サムネ3案スペック+image宣言、bible §13)+ `publish/metadata.json`(factory-uiのYouTubeアップロードが読む機械可読契約。`npm run validate:metadata episodes/<epId>` で検証)+ `channel/episode-ledger.json` への追記(全話台帳。マンネリ検出の入力)。
タイトル・サムネは research.md「約束」節の最終化として作る(整合規則はpublisher定義に内蔵)。
サムネイル3枚をレンダリング(静止画で軽負荷。軽量バンドル+再試行内蔵。CLIのremotion stillを直接使わない — メモリ逼迫時に不安定):

```
npx tsx src/pipeline/render-thumbs.ts episodes/<epId>
```

タイトルはbible(公開パッケージ節)の規定に従う — 固定型ならそのまま確定、3案方式ならユーザーが1案選定。**サムネは選定不要 — 3枚とも朝のアップロード時にYouTube Studio「テストと比較」へ投入**しABテストする(bibleの公開パッケージ節)。
publisherの後、**asset-generatorへ委譲**: PUBLISH.mdの「サムネ画像ブリーフ」から `publish/thumb-oneshot-{1..3}.png` を生成する(型5・正典`--ref`・16:9)。生成完了後に上のrender-thumbsを実行する。
→ status: "packaged"

## 12. 人間レビュー(一括)→ 承認 → 夜間レンダーキューへ

動画・サムネ・タイトル・概要欄を**まとめて**確認してもらう。**レンダーはここでは実行しない**(夜にサーバーが焼く):

1. `npm run dev`(HyperFramesプレビュー・必ずbackground起動)を立ち上げ、表示された http://localhost:<port> で動画本編を確認してもらう
2. サムネ3枚・タイトル・概要欄(publish/)をあわせて提示する
3. フィードバックは「単発修正」と「システム還元(/channel-refine)」に分類して対応。修正したら工程9(検査)から再確認して再提示
4. 承認を求める — ヘッドレス実行(Factory UI)では規約どおり `kind:"render-check"` のゲートを発行して停止する。対話セッションでは AskUserQuestion で承認を得る

**承認後の完了処理(このジョブの終点。レンダーはしない):**

- `npm run finalize episodes/<epId> -- --hours <実測時間> --images <画像生成数>` を実行する
  (status更新・metrics追記・backlog消し込み・git commit を一括実行。手作業で個別に行わない)
- キュー登録の確認: Factory UI 経由(ヘッドレス)ならゲート承認時にサーバーが自動登録済み。**対話セッションの場合のみ** `curl -s -X POST http://127.0.0.1:4700/api/render-queue/enqueue -H 'Content-Type: application/json' -d '{"dir":"<チャンネルフォルダ名>","epId":"<epId>"}'` で登録する(サーバー未起動で失敗したら、Factory UI のエピソード詳細から「夜間レンダーキューへ」を押すようユーザーへ案内)
- ここで `<done>` を出して終了する。**status "final" は夜のレンダー成功時にサーバーが書く**(このジョブでは書かない)

**委任モード(auto)**: 目視確認は承認済みとして進めてよい(ゲートは発行しない)。上記の完了処理を行って終了すれば、サーバーがジョブ成功を検知して自動でキュー登録する。**即時レンダーはしない**(promote-preview による昇格も不要 — preview 自体を焼かないため)。

## 夜間レンダー(サーバー実行 — このスキルの工程外)

寝る前に Factory UI の「夜間レンダー開始」を押すと、サーバーが承認済み(render_ready)エピソードを全チャンネル横断・1本ずつ `scripts/render-episode.sh episodes/<epId> final` で直列レンダーする(Infinityゲート・Mechanical QA・caffeinate・自動再挑戦は同スクリプトに内蔵)。成功時はサーバーが機械的に episode.json `status: "final"`・metrics の renderMinutes・git commit を行う。

QA落ち・レンダー失敗は朝の Factory UI に赤表示される → 日中に通常ジョブ(途中再開)で修正 → 工程9(検査)から再確認 → 再承認 or UIの「再キュー」で再投入。

## 13. 朝: 確認・アップロード(手動)

Factory UI でQA結果と final.mp4 を確認し、YouTube Studio へ手動アップロードする。サムネ3枚は「テストと比較」へ投入しABテストする。
「テストと比較」の結果が出たら、factory-ui のエピソード詳細から `publish/thumb-test.json` に勝者と所感を記録する(channel-refineの入力になる)。
