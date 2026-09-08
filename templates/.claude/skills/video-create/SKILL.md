---
name: video-create
description: このチャンネルの新規エピソード動画を制作する。「/video-create 織田信長」のように題材を渡す。調査→台本→ファクトチェック→TTS→ストーリーボード→ショット→素材→シーン実装→検査→準拠レビュー→公開パッケージ→承認までを実行する(レンダーは承認後に夜間キューでサーバーが実行)。
---

# /video-create — エピソード制作パイプライン

**開始前に必ず `channel/bible.md` 全文と `.channel-system.json` を読むこと。**
各ステップ完了時に `episodes/<epId>/episode.json` の `status` を更新する(中断・再開の基盤)。

**工程5以降はHyperFrames経路**(HTML+CSS+GSAP)。Remotion時代の既存エピソードを工程5以降で再修正する場合のみ旧Remotion工程を用いる(手順は git 履歴の旧 SKILL.md を参照)。工程0〜4(調査・台本・審査・TTS)と工程11(公開パッケージ・サムネ)はRemotion/HF共通。ショート(9:16)は引き続きRemotionで作る。

**経路の分岐(HF / H3)**: 既定は上のHF経路。`.channel-system.json` の `h3Pipeline.episodes` に載っているエピソードだけ、**工程5-6以降を MiniMax H3(生成動画)経路**で作る(設計 `docs/superpowers/specs/2026-08-19-h3-prompt-pipeline-design.md` / 道具 `src/pipeline/h3/` / 規則 `h3/vocab/<epId>.ts`)。工程番号と `<stage>` ラベルは factory-ui のフェーズと1対1のまま保つので、該当する工程の中に **`### 【H3経路】`** の節を置いてある。**H3経路のエピソードではその節だけを実行し、同じ工程のHF側の手順は実行しない。** 工程0〜4・8.4・10〜11・13は両経路で共通。

**H3経路の砦(逐語で守る。破ると無人でGPU課金が走るか、完成品が黙って消える)**:

1. **factory-ui の manual モードでのみ走らせる。** semi モードは「途中の確認ポイントは自分で採用して先へ進んでよい(`<gate>` を出さない)」、auto モードは「`<gate>` は一切出力しない」と指示され、サーバー側も auto では全ゲートを・semi では `render-check` 以外を自動承認する。semi が実運用の既定になりやすく、工程7のプロンプト承認ゲートと工程8のPod起動確認は semi/auto では自動突破される。**H3経路のジョブが semi/auto で来たら、工程7のゲートより先へ進まずに停止し、manual での再実行をユーザーに求める**
2. **GPUを使うコマンドは `H3_ALLOW_GPU=1` が無ければ exit 3**(`src/pipeline/h3/config.ts` の二重ロック)。恒久設定にしない — 人間が manual で明示操作する1コマンドにだけ付ける
3. **H3経路のエピソードを夜間レンダーキューへ投入しない。** `scripts/render-episode.sh` は `composition.html` があればHF経路で焼くため、投入するとエラーにならずにHF実装を再レンダーして `out/final.mp4` を上書きし、H3の成果物を黙って捨てる(`out/` は .gitignore でgitから復元できない)。**`<stage>レンダー</stage>` も出さない**(サーバーのバックストップが `kind:"render-check"` ゲートを強制発行し、それを承認するとキューへ自動登録される)

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

**「並列起動」の実行形(壁時計とusageの両方に効く)**: 本スキルが「並列」「並行」と書く箇所は、
**1つのメッセージ内に複数の Agent tool_use を並べて同時発行し、全部の結果を待って監査する**ことを指す。
1メッセージ1呼び出しを繰り返すのは直列実行であり、並列ではない。
依存関係(正典→バリアント、Phase 1→Phase 2 など)がある組だけ順序を守り、
**依存の無いものは必ず同一メッセージにまとめる**。
実測例: 素材7本・シーン実装3本の計10本すべてが1メッセージ1呼び出しで直列実行され、
シーン実装だけで281分かかった(真に並列なら最長グループの137分)。
メインセッションが「並列で実装します」と宣言してから1本ずつ呼ぶ事故が実際に起きているため、
**発注前に「このメッセージに Agent tool_use をいくつ入れるか」を数えてから発行する**。
**遵守は機械で測れる**: `npm run usage -- --session <sessionId>` が「1メッセージ1本」の件数・同時に走った最大本数・
所要の総和/経過を出す。工程12でこれを確認し、全部が1本ずつなら次回の是正対象として記録する。

**コンテキスト規律(usage削減の中核)**: 履歴の肥大はusageとレート制限に直結する。

1. **委譲はパス渡し**: サブエージェントへの委譲プロンプトにファイル内容を貼らない。
   ファイルパス+読むべき節の指定で渡し、サブエージェント自身に読ませる。
   例外は本スキルが「逐語転記」を明示する箇所のみ(research.md「約束」節、backlog候補メモ)。
2. **報告は30行以内**: サブエージェントの最終報告は構造化サマリ(結論・合否・数値・成果物パス)
   30行以内とし、成果物の全文・長い引用を報告へ含めない。詳細は成果物ファイルに書く。
3. **メインは全文Readしない**: メインセッションの監査は、機械検査の出力(`lint:script` / HF `npm run check` / validate 等)と
   サブエージェントの構造化報告に基づいて判断する。報告に疑義がある場合も全文Readせず、
   該当箇所の抜粋Read(offset/limit指定)のみ。同一ファイルの再Readを繰り返さない。
4. (2026-09-02 撤去: 「メインは台本の内容検査をしない」の禁止。台本を書き手以外が読む場が完成尺まで無くなっていたため、台本を読むかどうかはメインの裁量に戻す。読んだ結果は差し戻しで伝え、自分で書き直さない)
5. **status 更新は `npm run status episodes/<epId> <status>`**(2026-08-02 新設)。
   JSON を自分で読み書きしない。契約(episode.schema.json の enum)で検証され、
   後戻りと綴り違いを止める。ep002 実測ではメインの Bash 12回が status 更新の
   python heredoc だった。

## 0-a. 題材の決定(引数なしで呼ばれた場合)

題材が渡されなかったら、ネタ帳から選ぶ:

- `channel/backlog.md` が存在し状態「候補」が3件以上ある場合: 合計点上位5件を採点内訳・候補メモつきで提示し(AskUserQuestion)、選ばれた題材で以降の工程を進める
- 帳が無い、または「候補」が3件未満の場合: `/theme-scout` の実行を提案して停止する

**消し込み(開始)**: 題材が確定したら(引数あり起動で帳に同じ題材が載っている場合も含む)、backlog.md の該当行の状態を「制作中(<epId>)」へ更新する(更新は §0 で epId を確定した後に行う)。

## 0. 準備

- epId は `epNNN-<slug>`(例 ep001-<slug>)。`episodes/<epId>/episode.json` を作成(episodeId / subject / targetDurationSec / **startedAt(現在時刻のISO文字列)** / status: "researched"の前は無し→調査完了後に設定)
  - `startedAt` は工程12の `npm run finalize` が**実測の所要時間とコストを機械計測する起点**になる(無いと metrics が空欄になる)
- VOICEVOX起動確認: `curl -s http://127.0.0.1:50021/version`

## 1. 調査 → `research.md`

fact-checkerエージェントに委譲。出典つき・確度(定説/有力/諸説)つきで、「フック候補(視聴者を掴む要素のランキング)」を含めること。
また「約束」節(仮タイトル1本+サムネ一言の方向+その約束を本編が回収できる根拠。docs/retention-principles.md 原則3)を必ず含めること。調査の結果、約束が成立しない(本編が回収できない)と判明した場合は台本へ進まず題材を差し戻す。
`channel/backlog.md` に該当題材の行がある場合、その候補メモ(フック・物語の当たり・多様性メモ)を委譲プロンプトへ丸ごと含める(theme-scoutの検討結果を初動に使い、切り口の再発明をさせない)。→ `npm run status episodes/<epId> researched`

## 2. 台本 → `script.md`

**script-directorエージェントへ委譲**(目標尺と題材に加え、research.md の「約束」節を委譲プロンプトへ逐語で転記する。執筆手順・セルフチェックはエージェント定義に内蔵)。
メインセッションはエージェントのセルフチェック報告を監査し、疑義があれば差し戻す。

**台本ドラフト受領後、audience-simを起動する**(合否権なし・助言のみ)。`script.md` のパスのみを渡す(bible.md・storyboard.md は渡さない)。
**この位置に置く理由**: 台本が可変な時点でしか初見の助言は反映できない。工程10で起動していた時期は助言が4本連続で「台本確定済みのため未対応=次話への申し送り」となり、出力が構造的に使われていなかった。
助言の採否はメインセッションが判断する(script-directorへの自動差し戻しはしない)。採用する指摘は script.md に反映してから工程3へ進む。
→ `npm run status episodes/<epId> scripted`

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

- **誤読プリチェック(合成前・高速)**: まず `npm run tts episodes/<epId> -- --readings-only` で読み仮名レポート(narration/readings.md)だけを生成する(VOICEVOX audio_queryのみ・数十秒。起動時に `channel/user-dict.json`(あれば)をVOICEVOXのユーザー辞書へ同期するので、登録済みの名詞はこの時点で正しく読まれる)。**次に `npm run check:readings episodes/<epId>` を実行**して既知の誤読型の候補リストを機械で出し(exit 1=候補あり)、**その出力を逐語で reading-checker の委譲プロンプトへ貼って**検査する。reading-checker(合否権あり)は **(1) readings.md を見る前に台本から期待読み `narration/expected-readings.md` を書き、(2) `npm run diff:readings episodes/<epId>` で実読みと機械突合し、(3) 差分行だけを判定する**(手順は定義に内蔵)。報告の1行目に `読み突合: N行 / 一致 / 差分 / 期待未記入` の引用が**無い報告は棄却して再検査させる**。候補リストは全件 PASS/REVISE の報告義務。REVISEなら修正して再プリチェック(**最大3周**。3周で解決しない読みはユーザーへエスカレーション): **名詞は `channel/user-dict.json` へ登録**(表記は変えない・以後の全話に効く)、**活用形・助詞の結合・数量表現は台本表記で直す**(ひらがなに開く/言い換え/読点+`- display:`)。**PASSしてから** `npm run tts episodes/<epId>` で本合成を1回だけ実行する(本合成はプリチェックと同じaudio_queryの読みで合成するため、表記と辞書が変わらない限り合成後の再検査は不要)
- 自己検証エラーが出たら台本表記を調整(読みの揺れ・難読語)
- PASSまで**工程7(素材)以降**へ進まない
- → `npm run status episodes/<epId> voiced`

## 5-6. ストーリーボード(HF版・clip表) → `storyboard.md`

**visual-directorエージェントへ委譲**(設計手順・多様性の定量規則はエージェント定義に内蔵)。成果物は `storyboard.md`(HF版・必須4セクション+**clip表**: clipId / 開始秒 / 尺 / lineIds / role / 演出記述 / 使用素材 / SE)**のみ**(shots.jsonは廃止)。
**二相で起動できる**: Phase A(clip表の概算時刻版)は script.md だけで設計できる(開始秒・尺は概算と明記させる。visual-director定義に内蔵)→ **台本審査PASS直後、必ず工程4のTTSと並行で開始する**(直列にしない。レート制限発生時のみ直列フォールバック可)。並行の実行形も同じ(同一ターン内で複数tool_useを同時発行して両方を待つ)。Phase B(clip表の実時刻化)は timing.json(実タイミング)確定後に行い、概算時刻を timing.json の実測行時刻へ置き換える。
**流れは「演出が先、素材が後」**: visual-directorは手持ち素材に縛られず演出を設計し(演出記述はWeb技術語彙で自由に。creative原則はエージェント定義に内蔵)、不足素材リストを storyboard.md に出す → 工程7で充足 → clip表の使用素材を確定。
**10分超は章並列**: 全体設計(Phase 1)→章グループ並列(Phase 2)→統合(Phase 3)。Phase 1の分担は**グループ間のclip数が±20%以内**になるよう均す(壁時計は最遅グループに律速される)。共有様式・スパイン演出は1グループが実装オーナー、他は同じ見え方を再現。
メインセッションは 多様性の自己計測表・role分布・不足素材リストの妥当性・**clip表とtiming.jsonの行被覆(欠落行ゼロ)の自己申告**を監査する。
→ `npm run status episodes/<epId> storyboarded`

### 【H3経路】

storyboard.md は上のとおり作る(章割・体験設計はH3でも使う)。ただし **clip表の「演出記述」列をH3に渡さない**。H3が storyboard から読んでよいのは `## 1. 体験設計` 節だけである。
v1 は絵コンテの演出記述(HyperFrames用のDOM/GSAP指示)をそのまま英訳してH3へ渡し、画面内日本語80本・抽象装置79本・**ナレーションに無い文字を出したカット76件**を生んだ(ユーザーは7分20秒で視聴を放棄)。この入力経路は設計上の禁則として固定する。

## 6.4 語彙帳の用意 → `h3/vocab/<epId>.ts`(H3経路のみ)

**新規エピソードはここから始まる。** 工程6.5以降(`cuts.json` / `shots/<章ID>.ts` / `check:h3` / `h3:run` / `h3:assemble`)は**すべて `h3/vocab/<epId>.ts` の実在を前提**にしており、無ければモジュール未検出で落ちる。語彙は題材固有(雛形のサケなら `SEA` / `RIVER` / `HATCHERY` / `EGG` / `FRY`)なので**他の題材へ流用できない**。

**雛形は `h3/vocab/example-salmon.ts`(scaffold 時に持ち込まれるサケの例)。これを写して `<epId>.ts` を作る。**

- **`STYLE` / `CLOSE` / `CLOSE_H` / `CLOSE_TEXT` / `CLOSEUP_GUARD` は画風の定義なので据え置く**(雛形から**そのまま写す。一字一句変えない**。画風の実値は bible §8 に合わせて channel-builder 時に一度だけ直す)。題材ごとに書き換えるとチャンネルの画風が話ごとにぶれる。ここは題材の語彙ではない
- **`places` / `subjects` / `props` を題材に合わせて起こす**。場所は「どのカットもそこから書き始められる」粒度で、被写体は成長段階・状態の別に定数を分ける(雛形の `EGG` / `FRY` / `ADULT` がその例)
- **定数は必要最小限にする。** 語彙が増えるほど章をまたいだ画の同一性が崩れる。迷ったら足さずに既存の定数で書けないか先に試す
- **`places` の定数には、被写体と無関係に動き続ける小さな要素を必ず1つ以上入れる**(雛形の `SEA` の "a few small pale specks drifting slowly" / `RIVER` の "small pale bubbles rising slowly" がその例)。**画面の広い面を「plain cream paper」だけで終わらせない** —— 空・氷原・雪原など無地になりやすい面には、遠景の要素(遠い稜線・低い雲の帯・遠くの群れ・舞う粒)を定数の側で持たせる。ここが空だと、全カットが「無地の紙の上に被写体1つ」になる(実測の反省)
- 英文だけを書く(日本語は JSDoc コメントへ)。起こしたら `npm run typecheck:h3` を通す(定数名の綴り違いはここで捕まる)

**人間の承認を得てから工程6.5へ進む。** 語彙帳はこの先の全カットが参照する土台で、あとから足すほど同一性が崩れる。定数名・英文・用途の一覧を提示して承認を取る(ヘッドレスでは `<gate>` を発行して停止する。**`kind` を `"render-check"` にしない** — この種別の承認は夜間レンダーキューへの自動登録を起こす)。

工程6.5以降で語彙が足りないと分かったら(planner の `needsVocab` / writer の報告)、**この工程へ戻って承認を取り直す。** planner も writer も自分で語彙を増やさない。

## 6.5 カット割り台帳 → `h3/episodes/<epId>/cuts.json`(H3経路のみ)

既存エピソードの移設なら、まず機械で台帳を起こす(章ファイルと timing.json から逆生成):

```
npx tsx src/pipeline/h3/build-cuts.ts <epId>
```

**h3-cut-plannerエージェントへ委譲**(1体)。渡すのは `episodes/<epId>/timing.json` / `episodes/<epId>/script.md` / `episodes/<epId>/storyboard.md` の `## 1. 体験設計` 節 / `h3/vocab/<epId>.ts` の**パスだけ**。成果物は `cuts.json` だけで、文面(body / sound)は書かせない(工程7の担当)。

- 尺の基準は**タイムライン区間**(その行の startSec から次の行の startSec まで)。発話区間で計算すると実測で130秒不足する
- 語彙帳に無い場所・被写体が要るときは `needsVocab` に書いて止まる。**語彙の追加は人間の承認事項** — 承認したら `h3/vocab/<epId>.ts` に入れてから工程7へ進む(語彙が増えるほど章をまたいだ画の同一性が崩れる)
- メインセッションは章割・行の被覆(欠落ゼロ)・鎖の設計の自己申告を監査する
- **`firstWorstLineId`(45秒以内の最初の最悪)を台帳に書かせる**。`check:h3` の B14 が「無い・45秒より後・章カード」を BLOCK する。planner が「台本側の問題」と報告したら工程2へ戻す(台帳では直せない)

## 7. 素材取得

### 【H3経路】H3プロンプト生成(素材取得は行わない)

**この工程がフェーズ3の中身になる**(`<stage>素材</stage>` はそのまま流用する)。**ここを越えるまで Pod を起動しない。**

1. **章ごとに h3-prompt-writer を並列起動する**(**1つのメッセージに章の数だけ Agent tool_use を並べて同時発行する** — 冒頭原則の「並列起動の実行形」)。渡すのは `h3/episodes/<epId>/cuts.json` の担当章と `h3/vocab/<epId>.ts` のパスだけ。成果物は `h3/episodes/<epId>/shots/<章ID>.ts`。1体25カット前後でターン予算(80)の内側に収まる
1.5. **同じターンで figure-planner を1体、並列起動する**(図解オーバーレイの宣言 `h3/episodes/<epId>/figures.json`。渡すのは `episodes/<epId>/script.md` / `episodes/<epId>/timing.json` / `h3/episodes/<epId>/cuts.json` のパスだけ)。成果物は宣言だけで、焼くのは工程9。**H3経路の本編は図解を必須にしている**(bible §8・2026-09-04。`h3:assemble` は figures.json が無いと止まる。置かない判断は人間が `--no-figures` で明示する)。報告の「見送った数字の行」を工程7のゲートで人間に見せ、追加があれば宣言へ足して `npm run h3:figures -- <epId> --check` を通す
2. **課金前の砦を通す**: `npm run check:h3 -- <epId>`(exit 0=緑 / 1=ADVISEのみ / 2=BLOCKあり)。**BLOCK がゼロになるまで生成へ進まない。** BLOCK は h3-fix-writer に直させる(台帳側の問題なら `cuts.json` を直す)。出力は既定で同じ指摘を1行に畳む — 全件を1カット1行で見たいときだけ `--verbose`
3. **全文を章ごとに書き出す**: **章の数だけ、章IDと章別の出力先を指定して回す**(実際にモデルへ渡る全文を1カット1ファイルで書く)

    ```
    npm run check:h3 -- <epId> <章ID> --dump <出力先>/<章ID>
    ```

    **1ディレクトリへまとめて出さない。** レビュアーは Bash も `cuts.json` も持たないので、フラットに並んだカットのどれが自分の章かを判別できない
4. **章ごとに h3-prompt-reviewer を並列起動する**【ADVISE】。渡すのは**担当章の dump 先(`<出力先>/<章ID>`)**と `episodes/<epId>/timing.json` の**パスだけ**(このエージェントは Bash を持たないため全文はファイル経由で渡す)
5. **REVISE があれば h3-fix-writer で直す。再レビューはしない(1周で確定)** — 直したら `npm run check:h3 -- <epId> <章ID>` を通して次へ進む
6. **人間ゲート(プロンプト承認)**: `--dump` の出力先と `check:h3` の要約を提示して承認を得る。ヘッドレス(Factory UI)では `<gate>` を発行して停止する。**`kind` を `"render-check"` にしない**(この種別の承認は夜間レンダーキューへの自動登録を起こす) — `kind:"h3-prompt-check"` を明示し、`gateId` に `render-check` を含めない。対話セッションでは AskUserQuestion で承認を得る

承認を得たら `npm run status episodes/<epId> assets_ready` を実行し、工程8へは進まずに `<done>` を出して終了する(フェーズの区切りはHF経路と同じ)。

### 【HF経路・既定】素材取得

**起動タイミング(壁時計の短縮)**: 10分超で工程5-6を多相で回す場合、**Phase 1(全体設計)が終わった時点で確実に要る素材(スパイン・モチーフの実体・章の既定舞台)は発注できる**。clip表の完成を待たず、**Phase 2(章並列のclip表執筆)と同一ターンで asset-generator を並行起動する**。clip表の確定後に判明した追加ぶんだけを2周目で発注する。

**素材グループの並列起動(必須)**: 依存があるのは「キャラクター正典 → そのバリアント」だけである。
正典の生成が終わったら、**小物・舞台・他キャラ正典・各バリアント群を1つのメッセージにまとめて同時発行する**
(冒頭原則の「並列起動の実行形」)。実測例: 正典1本のあと6本を1本ずつ直列に呼び、素材工程だけで44分かかった(並列なら約12分)。

各ショットの素材を bible §10 の優先順位で調達:

1. library.json の既存素材(assetIdで参照)
2. SVG/コード生成(地図・図形・小物)→ assets/maps/ 等に保存
3. AI画像(キャラ新バリアント・場所): **asset-generatorエージェントへ委譲**(プロンプトの型・身体語彙・失敗→修正表を内蔵。gen-image.tsを生のプロンプトで直接叩かない)。エージェントの成果物(コンタクトシート)を**ユーザーに提示して承認を得る** → library.json 登録(approvedBy: "human")
4. 新人物の正典が必要な場合も asset-generator の型1で候補生成 → ユーザー承認 → canonical.png として保存

**委任モード(auto)での承認**: コンタクトシートと asset-generator の自己評価を `episodes/<epId>/assets/` に保存した上で自動承認として進む(library.json の approvedBy は "auto" と記録し、工程12相当の最終確認で人間がまとめてレビューする)。semi / manual では従来どおり承認を待つ。

全新規素材を library.json に登録(kind/subject/variant/file/source/license/approvedBy)。

**この工程がフェーズの終点である**(factory-ui のフェーズ3)。全素材の調達と登録が済んだら
`npm run status episodes/<epId> assets_ready` を実行し、工程8へは進まずに `<done>` を出して終了する。
工程8は新しいセッションが担当する — 素材工程12エージェントとのやりとりを実装工程が
引き継がないための区切りで、ep002 実測ではこの1セッションだけで投入47.2M(1本の24.7%)だった。

**再開時は library.json を先に読む**: 登録済みの素材は再調達しない。ep002 では枠切れ中断からの
再開で素材5本をまるごとやり直し、23分と約10Mトークンを捨てた。

**素材の確認はコンタクトシート1枚で行う**: 生成物・調達物を1枚ずつ Read させない
(asset-generator / image-researcher の定義に内蔵。実測で1本が19枚8.74MBを個別Readしていた)。

## 8. シーン実装 → `composition.html`

### 【H3経路】生成と検品(シーン実装は行わない)

**この工程は新しいセッションで始まる**(`<stage>実装</stage>`)。**課金が発生する唯一の工程である。**

1. **状態を確認する**: `npm run h3:pod -- status`(起動状況と概算コストが出る。課金を増やさないのでロック不要)
2. **Pod起動は要ユーザー確認**: `npm run h3:pod -- up` を勝手に実行しない。ユーザーの明示的な確認を取ってから起動する(manual 限定なのはこのため)。**課金が始まるのはこの瞬間である**($1.23/h・自動停止なし)ため、`up` / `wait-up` も `H3_ALLOW_GPU=1` が無ければ exit 3 で止まる

    ```
    H3_ALLOW_GPU=1 npm run h3:pod -- up
    ```

    `tools/comfy-runpod/` の `pod.mjs` を直接叩かない。**課金ロックを通らない**(直叩きは別リポジトリの CLI をロック無しで呼ぶことになる)
3. **初回は必ず `--only` で1〜2本から**。新しい環境では実生成経路(鎖の起点フレーム抽出・`batch.mjs` 呼び出し・出力実在チェック・LoRA/steps)が通る保証が無い。1〜2本(約$0.05)で通ることを確かめてから章全体を回す

    ```
    H3_ALLOW_GPU=1 npm run h3:run -- <epId> <章ID> --only cL01,cL02 --url <PodのURL>
    ```

    **既存クリップがあるエピソードでは、先に1本隔離してから `--only` で作り直す。** 生成済みのIDは対象から外れるので、そのままでは対象0本の「生成するものはありません」で正常終了し、**実生成経路を1本も通していないのに通ったと読めてしまう**(run-chapter は落ちたIDを警告に出す)。

    ```
    npm run h3:reject -- <epId> cL01          # 隔離(削除ではなく移動。GPUは使わない)
    H3_ALLOW_GPU=1 npm run h3:run -- <epId> <章ID> --only cL01 --url <PodのURL>
    ```

4. **章ごとに回す**: `H3_ALLOW_GPU=1 npm run h3:run -- <epId> <章ID> --url <PodのURL>`。**章カード(`card`)のカットは生成しなくてよい**(2026-09-05: 文字は工程9の `h3:figures` が不透明な板として焼き、assemble は生成クリップが無ければ紙色で合成する。`--only` で章カード以外を名指しするか、生成しても差は無いのでそのまま回してもよい。検品の対象からは外す)。`--plan` / `--dry` は計画と検査だけでGPUを使わない。**常駐監視ループを作らない**(欠けを自動検出して投げ直す仕組みは意図しない課金を起こす)
5. **章ごとに h3-clip-inspector を並列起動して検品する**(章シートとストリップを自分で焼き、絵を見て判定する)。成果物は **`h3/episodes/<epId>/defects/<章ID>.md`** への追記。**章ごとにファイルを分ける**(並列起動した検品エージェントが1つのファイルへ同時追記すると混線する)
   - **破綻を検出できる機械指標は存在しない**(較正で実証)。**検品は目視が唯一の手段である。** `h3:inspect` が出す「契約違反」は申告どおりの尺と解像度かだけで、破綻の有無とは無関係
6. **不合格は h3-fix-writer で文面を直し、`npm run h3:reject -- <epId> <clipId…>` で隔離してから再生成する**(隔離は削除ではなく移動。移せば skip 判定が外れて作り直される)
   - **鎖の途中を作り直すと下流は古い起点のまま残る。鎖区間は入口から隔離する**(対象IDは h3-fix-writer が報告に列挙する)
7. **全章合格したら `npm run h3:pod -- down` を必ず実行する。** そのあと `npm run h3:pod -- status` で停止を確認してから次工程へ進む(止め忘れが最大の課金事故)。**`down` と `status` にロックは掛かっていない** — 止める道具をロックすると「止められない」事故になるため

工程8.4(音声ミックス)まで終えたら `npm run status episodes/<epId> implemented` を実行して `<done>`。**`narration/master.mp3` が無いと工程9の組み立てが止まる**(H3は生成クリップの音を捨てない。ナレーション+BGMの `master.mp3` に加え、`h3:ambient` が生成音を `narration/ambient.wav` へまとめてその下に敷く)。

### 【HF経路・既定】シーン実装

**この工程は新しいセッションで始まる**(factory-ui のフェーズ4)。素材は前フェーズで確定済み
(status: `assets_ready`)なので、**この工程で素材を作り直したり追加調達したりしない**。
不足が判明したらその旨を報告して止まる(メインが判断してフェーズ3へ差し戻す)。
工程8.4(音声ミックス)まで終えたら `npm run status episodes/<epId> implemented` を実行して `<done>`。

**まずメインセッションが骨格を機械生成する**(エージェントに作らせない):

```
npx tsx src/pipeline/scaffold-composition.ts episodes/<epId> --groups "cL01-cL50,cL51-cL108,cL109-cL166"
```

`timing.json` から clipセクション・字幕・プリミックス音声の配線・素材テーブル(storyboard.md の使用素材列 → library.json → PNGのアルファから不透明bboxを実測)・共通ヘルパー(`assets/hf/hf-helpers.js`)・章グループの `SPLICE` マーカー・未実装clipのフォールバックまでを生成する。**この時点で `npm run check` が通る**(未実装clip数が warning に出るだけ)。`--groups` は storyboard.md の章割に合わせる。

あわせて **`_frag/<グループ>.brief.md`(実装ブリーフ)** をグループ数ぶん生成する。この回の設計(storyboard の clip表以外)・担当clipの表・その範囲で使える素材のキーと実寸・共通ヘルパーAPI・守る契約が1枚に入っている。

**これにより章グループを最初から並列で起動できる**(骨格を1体のエージェントに作らせると、後続グループがその完了まで待つ)。

**共通ヘルパーは書き直させない**: `assets/hf/hf-helpers.js` が素材配置(`pic` / `stage`)・紙の名札(`plate`)・木札(`placard`)・吹き出し(`bubble`)・章カード(`chapterCard`)・手描き線(`draw` / `pointer` / `cutArrow` / `blob` / `xMark`)・光と粒(`skyGlow` / `shafts` / `motes`)・シード付きPRNG(`prng`)を持つ。回固有の部品だけを実装させる。

**次に scene-implementerエージェントへ委譲**(各グループの成果物は `SCENES.cLxx = (g,D)=>{...}` の代入だけを書いたJSフラグメントとし、メインセッションが `SPLICE` マーカー行へ差し込む。composition.html への同時書き込みを避ける)(HF規約5点・三層規則・技術規則・音声/字幕配線はエージェント定義に内蔵。実装前に `hyperframes-core` / `hyperframes-animation` スキルを読ませる。メインセッションが演出コードを書かない — シーン実装は演出の質を最終決定する工程であり、エージェント定義のモデル固定が品質のモデル非依存を担保する)。成果物は `episodes/<epId>/composition.html`(storyboard.md のclip表を実装し、`assets/hf/<slug>-style.css` を link)。

- **10分超は章グループ並列で起動する**(visual-directorと同じ分担。共有様式・スパイン演出は実装オーナー1グループ、他は同じ見え方を再現)。
  骨格は上の scaffold で機械生成済みなのでグループ間に依存は無い — **全グループを1つのメッセージにまとめて同時発行する**(冒頭原則の「並列起動の実行形」)。
  直列にすると壁時計はグループ数ぶん積み上がる(実測例: 114分・30分・137分の3グループを直列に回して281分。並列なら137分)
- **コストは「グループの割り方」ではなく「総ターン数」で決まる**(実測)。
  ある回の実装6本のターン単価は $0.138〜$0.172 で、**担当clip数とは相関しなかった**(57ターン$8.1 / 103ターン$14.2 / 157ターン$27.0)。
  毎ターン持ち回る固定分(システム+参照物)が自分の出力の累積より大きいため、細かく割ってもその固定分は減らない(体数ぶん増える)。
  したがって粒度の規定は **1体あたり80ターンの予算**とする(超えそうなら報告させる。エージェント定義に内蔵)。
- **`npm run check` は実装者に走らせない**(並列時はルートの index.html を奪い合って互いを壊す)。スプライス後にメインセッションが1回走らせる。
- **発注プロンプトには scaffold が出す「ブリーフのパス」だけを渡す**(storyboard.md・composition.html・hf-helpers.js のパスを渡さない — 探索の往復がコストの本体)。
- **共有装置のオーナーを先に走らせた場合、完了後に `npx tsx src/pipeline/frag-api.ts episodes/<epId>/_frag/<owner>.js` で API 表を作り、他グループへはそのパスだけを渡す**(実測 96KB → 8KB)。
  ※旧記述「1体のコストはターン数のほぼ2乗/3体に割れば1/3」は実測で否定された。
  実測例: 最大グループは 200ターン・平均23万tok・**単独 $57**。同じ量を3体に割れば読み込み分は概算で 1/3 になる。
  壁時計も最遅グループに律速されるので、**グループ間のclip数を ±20%以内に均す**(章境界はグループ境界に合わせなくてよい。共有様式のオーナーだけ決めておけばよい)。
  `--groups` は全clipをちょうど1回ずつ覆うこと(覆い漏れ・重なりは scaffold が exit 2 で止める)
- メインセッションの監査観点:
  - **`npm run check` 緑の報告(出力つき)**(HF: lint+runtime+layout+motion+contrast)
  - **ゼロ持ち越し**: 過去ep composition.html からの場面演出の流用が0件であること(過去エピソード由来の場面演出が1件でも混入していたら差し戻し)
  - composition.html の実装が storyboard.md の clip表と数・内容で整合すること
  - **テンプレ量産でないこと**: 単一factory/ヘルパーの文言差替え変種群は1演出と数える。実効演出数が定量規則を満たさなければ差し戻し

## 8.4 音声ミックス(ナレーション+BGM+SE を1本に焼く)

**この工程を飛ばすとBGMもSEも一切鳴らない。** 工程として書かれていなかった時期に、あるエピソードが全編無音のまま check緑 → レンダー → 承認 → コミットまで通った(2026-08-01 の /system-refine で工程化)。

1. **BGM の計画を書く** — `episodes/<epId>/bgm-plan.json`(包絡線 `envelope` × 曲の割り当て `assignment`。契約は `src/schemas/bgm-plan.schema.json`)。
   storyboard の「BGM」節が正本で、これはその機械可読版。曲を差し替える指示は `assignment` だけを書き換える(包絡線を写し直さない)
2. `npm run audio-cues episodes/<epId>` — **SEキューを composition の台帳から、BGMキューを bgm-plan.json から機械生成する**(手で書かない)。
   scene-implementer が出す `window.__G<n>_SE_CUES` が入力。台帳が無い/素材が見つからない場合はここで止まるので、実装へ差し戻す
   SE台帳の内容ハッシュが `audio-cues.json` に埋まり、以後 `check:audio` が composition と突合する(ミックス後にSEを足した/動かしたまま焼き直していない状態を捕まえる)
3. `npm run audio-mix episodes/<epId>` — SE音量を素材ごとの実測ラウドネスから -22 LUFS へ揃え、リミッタ(-1.5 dBFS)を通して `narration/master.mp3` を焼き、**composition.html の `<audio id="master" src>` をこの master へ差し替える**(2026-08-01 からツール側で行う。以前はここが唯一の手作業で、無音事故と同じ入口だった)
4. `npm run check:audio episodes/<epId>` が緑になること(工程9とレンダー前ゲートでも自動で走る)

### 【H3経路】音声ミックス

**H3は生成クリップの音を捨てない。** ナレーション+BGMの `narration/master.mp3` に加え、生成音を `narration/ambient.wav` として別トラックにまとめ、組み立ての最終muxで master.mp3 の下に敷く。手順は上の1・3を共通で使い、2だけ差し替えて4(環境音)を足す(5は実行しない):

1. BGMの計画 `episodes/<epId>/bgm-plan.json` と、**SEの計画 `episodes/<epId>/se-plan.json`** を書く。**SE設計の正本は storyboard.md §5「SE設計」と §3 clip表のSE列**で、se-plan.json はその機械可読版である(HF経路の `window.__G<n>_SE_CUES` に相当する台帳がH3には無いため、宣言で代替する)。形: `{ "se": [ { "clipId": "cL001", "start": 0.0, "src": "assets/audio/se/pop-3-nyu.mp3" } ] }`(`start` は clip表の開始秒。音量は書かない — audio-mix が素材ごとに -22 LUFS へ揃える)
2. `npm run h3:audio-cues -- <epId>` — cues を **timing.json(総尺)+ bgm-plan.json + se-plan.json** から作る。`composition.html` は読まない。**SEは se-plan.json があればそこから載る**(無ければ従来どおり0件)。**環境音は SE として通さない** — audio-mix はテンプレート同期でバイト一致が要求され改変できないうえ、SEを1本ずつ -22 LUFS へ正規化する設計のため、静かな環境音を通すと持ち上がって鳴り続けてしまう。環境音は 4 の `h3:ambient` が別トラックで敷く。`seLedgerHash` は書かず、宣言の内容ハッシュを **`sePlanHash`** に残す(HF経路の上書き保護と同名にすると自分自身を弾くため別名にしてある)。BGMの計算はHF経路と同一(`build-bgm-cues.ts` を共有。`npm run audio-cues` の出力と全区間一致することを実証済み)
   - HF実装が同居するエピソードでは `audio-cues.json` がHF経路の産物(`seLedgerHash` を持つ)なので上書きを拒む。別名にするなら `--out <名前>`、承知の上で上書きするなら `--force`
   - **`--out` で別名にしたものを `audio-mix` は読まない**(読むのは `audio-cues.json` だけ)。突き合わせ用の出力であって、焼くための入力にはならない
3. `npm run audio-mix episodes/<epId>` — 共通。`composition.html` が無いエピソードでは `<audio src>` の差し替えが素通りし、master.mp3 を焼くだけになる
4. `npm run h3:ambient -- <epId>` — 生成音を環境音トラック(`narration/ambient.wav`)へまとめる。
   **この工程を飛ばすと環境音が敷かれない**(assemble は ambient.wav が無ければ黙って従来どおり焼く)。
   敷き量・除外は `h3/episodes/<epId>/ambient.json` で調整する
5. **`npm run check:audio` はH3経路では実行しない** — composition のSE台帳との突合が前提の検査で、H3には台帳が無い。master.mp3 の存在は工程9の `h3:assemble` が入口で検査する

`npm run audio-cues`(HF用)はH3経路では使わない。SE台帳の入力に `composition.html` を要求するため、composition を持たない新規エピソードでは「composition.html がありません(HF経路専用です)」で止まる。

## 8.5 プレビュー早期確認(レンダリング前・推奨)

### 【H3経路】章コンタクトシートでの確認(任意)

HyperFramesのプレビュー(`npm run dev`)はH3経路では使えない(composition.html を焼かないため)。代わりに章のコンタクトシートで見る:

```
npm run h3:inspect -- <epId> <章ID>
```

`review/<epId>/<章ID>-sheet.png` が章のコンタクトシート(33本以上の章は32本ずつに分割される)。特定のクリップを判読したいときは `--strip cL01,cL02`(6コマ3x2のストリップ)、暴発防止の上限は `--max N`(既定40)、別の置き場を見るなら `--dir <置き場>`。
**任意工程である** — 工程8の検品で h3-clip-inspector が同じ材料を焼いているので、ユーザーがすぐ確認できないならスキップして工程9へ進んでよい。

### 【HF経路・既定】

実装完了後、**レンダリングを焼く前に** HyperFrames プレビューでユーザーが確認できる:

```
npm run use episodes/<epId>   # HFのエントリ(ルートindex.html)を作業中epに向ける
npm run dev   # 必ずbackgroundで起動。起動ログに出る http://localhost:<port> を開く
```

ブラウザ(hyperframes preview が表示するポート)でスクラブ・再生し、レイアウト・演出の問題をレンダー1周(30〜50分)を消費せずに発見する。音声ミックスの最終確認・QAはレンダー後のmp4で行う(プレビューは視覚の早期ゲート)。ユーザーがすぐ確認できない場合はスキップして次工程(検査)へ進んでよい。

## 9. レンダー前検査(日中・機械ゲートの前倒し)

### 【H3経路】字幕焼き → 組み立て(ここで完成品ができる)

**HF系ゲート(`npm run use` / `npm run check` / `npm run check:audio` / `npm run check:assets` / `npm run qa:frames`)はH3経路では実行しない** — すべて composition.html を前提にしているため。

1. **字幕を焼く**: `npm run h3:subs <epId>` → `h3/episodes/<epId>/subs/`(**1回の表示=1文**。台本の1行に複数の文があれば句の時刻で分け、表示窓は `subs/subs.json` に書かれる。bible §8・2026-09-04)
1.5. **図解と章カードを焼く**: `npm run h3:figures -- <epId>` → `h3/episodes/<epId>/figures/`(工程7の figure-planner の宣言から透過PNG連番を焼く。暗転層ごと。**章カードも cuts.json の `card` から不透明な板 `card-<cutId>` として同時に焼く**(2026-09-05。H3 に文字を描かせない — 手・ペンが湧くため)。**一覧 `figures/contact.jpg` を工程12で見せる**)。figures.json が index より新しいと assemble が止まるので、宣言を直したら焼き直す
2. **組み立てる**: `npm run h3:assemble -- <epId>` — クリップを区間の尺へ早回しで収め、図解(映像の上・字幕の下)と字幕を重ね、`narration/master.mp3` を載せて1本にする
   - **既定の出力先 `episodes/<epId>/out/final.mp4` に既存ファイルがあれば1バイトも書かずに exit 2 する。** HF版の final.mp4 が現存するエピソードでは `--out final-h3.mp4` のように別名へ出す(`out/` は .gitignore でgitから復元できない)
   - **組み立ての直前に master.mp3 を検査して止める**(HF経路の `check:audio` が持つ砦のうち、H3で成立する2つ):音の床(0.1秒窓RMSの下位10%点)が -60dB 未満なら `no_bed`(BGMが乗っていない)、`audio-cues.json` より master.mp3 が古ければ `master_stale`(工程8.4の `audio-mix` を忘れている)。閾値と計測は `check-audio.ts` のものを共有する。`--plan` でも走るので、焼く前に確かめられる
3. **総尺を確かめる**: 出力の総尺が `episodes/<epId>/timing.json` の `totalDurationSec` と一致すること。尺の基準は**タイムライン区間**であり、発話区間で組むと実測で130秒短くなる

総尺が一致したら → `npm run status episodes/<epId> prechecked`。**`<stage>レンダー</stage>` は出さない**(H3経路にレンダー工程は無い。出すとサーバーのバックストップが `render-check` ゲートを強制発行する)。

### 【HF経路・既定】

夜間レンダーを一発で通すため、機械ゲートを日中に前倒しで実行する:

```
npm run use episodes/<epId>   # HFのエントリ(ルートindex.html)を作業中epに向ける
npm run check                                    # check:visual(視覚多様性)→ HF lint+runtime+layout+motion+contrast
npm run check:audio episodes/<epId>              # 音声の配線(cues/master/BGMが実際に乗っているか)
npm run check:assets episodes/<epId>             # 絵コンテの使用素材と実装の突合
```

`check:visual` は評価済みDOMを読み、ユニーク画像密度・同一素材上限・連続する素材なしclip・AI比率・尺をBLOCK判定し、実効演出数(テンプレ量産)・ゼロ持ち越し・様式clip比率・縦長素材のフレーミングをADVISEで報告する。設定は `channel/visual-rules.json`(無いチャンネルはSKIP)。

composition.html の実行時エラー・レイアウト事故・モーション/コントラスト不足・**未実装clipの残り**を、レンダー1周を消費せずに検出する。
`npm run check` は `scripts/render-episode.sh` のレンダー前ゲートと**同一の検査**である(2026-08-01に等価化)。

**実フレームでの確認も日中に済ませる**(推奨): `npm run probe episodes/<epId> -- --at <秒,...> -o episodes/<epId>/review/frames`。
レンダー結果と一致するフレームが数秒/枚で取れる(輝度stdの機械判定+コンタクトシートつき)。

- **check の NG は修正して再実行(修正ループは最大3周。3周で残るNGはユーザーへエスカレーション)**
- **check:audio の NG はレンダーを起動しない**(`scripts/render-episode.sh` も同じゲートを持つ)
- **check:assets は既定では報告のみ(exit 0)**。BLOCK 行は「実装が素材を使わず図形で代用している」か「絵コンテがコード描画のclipに素材名を書いている」のどちらかなので、**メインセッションが1件ずつ判定して、実装か絵コンテのどちらかを直す**。既存の食い違いを一掃したチャンネルは `--strict` でゲートへ格上げできる

全て緑になったら → `npm run status episodes/<epId> prechecked`

## 10. 準拠レビュー(フレーム検査。新規コンテキストのエージェント1体)

mp4 非依存(レンダー前で成立する):

- **compliance-reviewer**: bible.md + review-checklist.md + script/storyboard/composition に加えて、**工程9で実行した `npm run check` の出力を渡す**(エージェントに再実行させない)。判定するのは review-checklist.md の **`@frame` タグの項目のみ** — `@script`(工程3)・`@check`(工程9)・`@fact`(工程3)・`@assets`(工程7)・`@publish`(工程11)は担当ゲートが判定済みであり、ここでの再検査は禁止する。PASS/FAIL。FAILは修正して再レビュー(修正したら工程9の検査から再確認。**FAIL→再レビューは最大2周** — 2周で解決しなければユーザーへエスカレーション)。視覚検証のフレームは `hyperframes-cli` スキルの snapshot 系(指定時刻のフレーム抽出・エージェント定義に内蔵)で取得する — **レビューのためにフルレンダーを起動しない**(80秒動画で12分、通常尺で30分超の浪費を実測。フレーム十数枚で足りる)
- **audience-sim はこの工程では起動しない**(工程2へ移設済み)
- → `npm run status episodes/<epId> reviewed`

## 11. 公開パッケージ(タイトル・サムネ・概要欄 — finalレンダー前に作る)

**publisherエージェントへ委譲**: `publish/PUBLISH.md`(タイトル・概要欄)+ `publish/thumbnails.json`(サムネ3案スペック+image宣言、bible §13)+ `publish/metadata.json`(factory-uiのYouTubeアップロードが読む機械可読契約。`npm run validate:metadata episodes/<epId>` で検証)+ `channel/episode-ledger.json` への追記(全話台帳。マンネリ検出の入力)。
タイトル・サムネは research.md「約束」節の最終化として作る(整合規則はpublisher定義に内蔵)。
サムネイル3枚をレンダリング(静止画で軽負荷。軽量バンドル+再試行内蔵。CLIのremotion stillを直接使わない — メモリ逼迫時に不安定):

```
npx tsx src/pipeline/render-thumbs.ts episodes/<epId>
```

タイトルはbible(公開パッケージ節)の規定に従う — 固定型ならそのまま確定、3案方式ならユーザーが1案選定。**サムネは選定不要 — 3枚とも朝のアップロード時にYouTube Studio「テストと比較」へ投入**しABテストする(bibleの公開パッケージ節)。
publisherの後、**asset-generatorへ委譲**: PUBLISH.mdの「サムネ画像ブリーフ」から `publish/thumb-oneshot-{1..3}.png` を生成する(型5・正典`--ref`・16:9)。生成完了後に上のrender-thumbsを実行する。
→ `npm run status episodes/<epId> packaged`

## 12. 人間レビュー(一括)→ 承認 → 夜間レンダーキューへ

### 【H3経路】人間レビュー → 承認(キューへは投入しない)

提示するのは `npm run dev`(HFプレビュー)ではなく **工程9の assemble が出した mp4**(既定 `episodes/<epId>/out/final.mp4`。HF版が同居するエピソードは `--out` で付けた別名)である。サムネ3枚・タイトル・概要欄・`channel/review-checklist.md` の `@human` 項目をあわせて提示するのはHF経路と同じ。**図解の一覧 `h3/episodes/<epId>/figures/contact.jpg` と `publish/next-videos.json`(終了画面に置く2本。API に無いのでアップロード後に Studio で人間が置く)も添える**(板の文字が読めるか・誇張が無いか・出るタイミングが句に合っているかを見てもらう)。

**承認ゲート**: ヘッドレス(Factory UI)では `<gate>` を出して停止する。**`kind:"render-check"` を使わない** — この種別を承認するとサーバーが夜間レンダーキューへ自動登録し、`render-episode.sh` が composition.html を見つけてHF実装を焼き、H3の成果物を上書きする。`kind:"h3-final-check"` を明示し、`gateId` に `render-check` を含めない。対話セッションでは AskUserQuestion で承認を得る。

**承認後の完了処理(H3経路の終点)**:

- `npm run finalize episodes/<epId> -- --images <サムネ生成数>` を実行する(status を `render_ready` にし、metrics追記・backlog消し込み・git commit まで行う)
- **`scripts/render-queue.sh` へ投入しない。キュー登録の curl も打たない。Factory UI の「夜間レンダーキューへ」も押さない。** 工程9の assemble の完了が最終物である
- **assemble(工程9)を必ず先に済ませてから finalize すること。** サーバーはジョブ成功時に「status が `render_ready` かつ `episodes/<epId>/out/final.mp4` が無い」エピソードを自動でキューへ登録する。final.mp4 が既にあれば登録されない
- ここで `<done>` を出して終了する。**auto / semi モードではこの工程に到達しない**(H3経路は manual 限定 — 冒頭の砦1)

### 【HF経路・既定】

動画・サムネ・タイトル・概要欄を**まとめて**確認してもらう。**レンダーはここでは実行しない**(夜にサーバーが焼く):

1. `npm run dev`(HyperFramesプレビュー・必ずbackground起動)を立ち上げ、表示された http://localhost:<port> で動画本編を確認してもらう
2. サムネ3枚・タイトル・概要欄(publish/)をあわせて提示する
3. フィードバックは「単発修正」と「システム還元(/channel-refine)」に分類して対応。修正したら工程9(検査)から再確認して再提示
4. 承認を求める — ヘッドレス実行(Factory UI)では規約どおり `kind:"render-check"` のゲートを発行して停止する。対話セッションでは AskUserQuestion で承認を得る

**承認後の完了処理(このジョブの終点。レンダーはしない):**

- `npm run finalize episodes/<epId> -- --images <画像生成数>` を実行する。**所要時間とコストは finalize がセッション記録(サブエージェントの記録を含む)から機械計測する**(episode.json の `startedAt` が起点。人の申告値を渡さない)。出力に出る**ターン予算超過のエージェント**が次回の是正対象
  (status更新・metrics追記・backlog消し込み・git commit を一括実行。手作業で個別に行わない)
- キュー登録の確認: Factory UI 経由(ヘッドレス)ならゲート承認時にサーバーが自動登録済み。**対話セッションの場合のみ** `curl -s -X POST http://127.0.0.1:4700/api/render-queue/enqueue -H 'Content-Type: application/json' -d '{"dir":"<チャンネルフォルダ名>","epId":"<epId>"}'` で登録する(サーバー未起動で失敗したら、Factory UI のエピソード詳細から「夜間レンダーキューへ」を押すようユーザーへ案内)
- ここで `<done>` を出して終了する。**status "final" は夜のレンダー成功時にサーバーが書く**(このジョブでは書かない)

**委任モード(auto)**: 目視確認は承認済みとして進めてよい(ゲートは発行しない)。上記の完了処理を行って終了すれば、サーバーがジョブ成功を検知して自動でキュー登録する。**即時レンダーはしない**(promote-preview による昇格も不要 — preview 自体を焼かないため)。

## 夜間レンダー(サーバー実行 — このスキルの工程外)

寝る前に Factory UI の「夜間レンダー開始」を押すと、サーバーが承認済み(render_ready)エピソードを全チャンネル横断・1本ずつ `scripts/render-episode.sh episodes/<epId> final` で直列レンダーする(Infinityゲート・Mechanical QA・caffeinate・自動再挑戦は同スクリプトに内蔵)。成功時はサーバーが機械的に episode.json `status: "final"`・metrics の renderMinutes・git commit を行う。

HF経路のレンダーは**前後にゲート**を持つ:
- レンダー前 `check-audio` — 音が配線されていなければ焼かない(HF本編は実測で1本100分。無音のまま焼くのが最も高い無駄)
- レンダー後 `qa-flat-frames` — 何も描かれていないclipがあれば `qaNotes:"blank_clips"` で赤にする
- レンダー後 ラウドネスQA — bible §11 の -14 LUFS ±1.0 を外れれば赤にする

QA落ち・レンダー失敗は朝の Factory UI に赤表示される → 日中に通常ジョブ(途中再開)で修正 → 工程9(検査)から再確認 → 再承認 or UIの「再キュー」で再投入。

## 13. 朝: 確認・アップロード(手動)

Factory UI でQA結果と final.mp4 を確認し、YouTube Studio へ手動アップロードする。サムネ3枚は「テストと比較」へ投入しABテストする。
「テストと比較」の結果が出たら、factory-ui のエピソード詳細から `publish/thumb-test.json` に勝者と所感を記録する(channel-refineの入力になる)。
