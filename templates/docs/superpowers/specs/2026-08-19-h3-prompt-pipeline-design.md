# MiniMax H3 本編映像パイプラインの仕組み化 — 設計

作成日: 2026-08-19
対象: 動物転生(animal-isekai-hell)
状態: 設計確定・実装前

## 1. 背景

動物転生の本編映像を、HyperFrames のコード実装から MiniMax H3(RunPod 上の ComfyUI)の生成動画へ移行する検証を、2026-08-17 から別セッションで進めてきた。ep015-salmon の全長版(303カット / 974.9秒)まで到達している。

しかし制作が1つの長いセッションに載っており、次の3点が問題になっている。

1. **セッションが長くなるほど失敗が増える。** 303カットを1つの文脈で書き切る形になっており、後半ほど語彙の揺れと規則の取りこぼしが出る。
2. **生成器一式が揮発領域にしかなかった。** `lib.mjs` / `shots/ch00〜ch11.mjs` / `chain.mjs` ほか一式が `/private/tmp/.../scratchpad/remake/` にあり、1行もコミットされていなかった(本設計の着手時に `動物転生/h3/_archive/v2-remake/` へ退避済み)。
3. **課金前の検査が薄い。** GPU は RTX 5090 で約 $1.23/h、1クリップ 44〜72秒。にもかかわらず生成前の機械検査は画面内文字の字数照合(`check-text.mjs`)だけで、尺レンジ外などは Pod 起動後に落ちる=課金中に判明する。

本設計は、この制作を**作業単位のエージェントへ切り分け、課金前にプロンプトを完成させる**仕組みにする。

## 2. 決定事項(2026-08-19 ユーザー判断)

| 項目 | 決定 |
|---|---|
| 置き場 | 動物転生の中だけ(まず1ch専用)。テンプレ正本への還元は行わない |
| 射程 | 新規エピソードをこの経路で作れるところまで |
| カット粒度 | 短い行だけ束ねる(5.17秒未満の隣接行を統合) |
| レビュー権限 | 機械検査は BLOCK、LLM レビューは ADVISE |
| 生成音 | 捨てる。`overall_soundscape` は短い定型文で埋める(**2026-08-24 の決定で覆った** — 捨てずに環境音として敷き、`overall_soundscape` も定型文運用をやめる。`docs/superpowers/specs/2026-08-24-h3-pipeline-improvements-design.md` §2・§5.2 を見よ) |
| 検品対象 | 画風の逸脱 / 物理・解剖の破綻 / 尺・カット割りとナレーションの不一致(音は対象外) |
| カット割りの分離 | する(h3-cut-planner を独立させる) |
| v2 の絵の評価 | 未実施。**規則の中身の凍結は保留** |

## 3. 中核の設計判断 — 構造とデータを分ける

v2 の生成器は既に「**宣言 → 決定的合成器 → jobs.json**」の三層になっている。`shots/chXX.mjs` は `{ body, sound, chain, hi, text, card }` を宣言するだけで、公式3フィールド形式は `lib.mjs` の `P()` が組み立てる。**形式違反が構造的に起きない**設計であり、「課金前にプロンプトを完璧にする」という要求に直接効く。

この**構造**の正しさは、v2 の絵の出来と独立している。一方 STYLE 文・場所定数・3原則という**規則の中身**は v2 評価待ちである。したがって両者を分離し、規則を差し替え可能な「語彙帳」として置く。

**この分離により、v2 を評価する前に仕組みの実装を進められる。** 評価後に変わるのは `vocab/<epId>.ts` だけになる。

## 4. 工程マップ

動物転生の `.claude/skills/video-create/SKILL.md` を書き換える。このファイルの同期区分は **VARIANT**(チャンネル独自の改変が許される)ため、**factory-ui もテンプレート正本も一切変更しない**。他8チャンネルへの波及はゼロ。

| 工程 | 現行 | H3経路 | factory-uiフェーズ |
|---|---|---|---|
| 0〜4 | 題材・調査・台本・審査・TTS | **変更なし**。`timing.json` がここで確定する | 1・2 |
| 5-6 | ストーリーボード(clip表) | `storyboard.md` は残す。H3 が読むのは**体験設計節(中心の問い・章割・入口出口)だけ**。clip表の「演出記述」列は渡さない | 2 |
| 6.5 | (新設) | **h3-cut-planner → `cuts.json`** | 2 |
| 7 | 素材取得 | **h3-prompt-writer(章並列) → `shots/chXX.ts`** → `check-h3-prompt`【BLOCK】→ h3-prompt-reviewer【ADVISE】→ **人間ゲート(プロンプト承認)** | 3 |
| 8 | シーン実装 | **Pod起動 → 章単位生成 → h3-clip-inspector(章並列) → 差し戻し** → 全章終了で Pod停止 | 4 |
| 8.4 | 音声ミックス | **変更なし**(master.mp3) | 4 |
| 8.5 | プレビュー早期確認 | HyperFrames のプレビューは使えない。**章コンタクトシートでの確認**に置き換える | 4 |
| 9 | レンダー前検査 | **assemble**(早回し+字幕焼き+音声合成)→ `episodes/<epId>/out/final.mp4`。HF 系ゲート(`npm run use` / `check` / `check:assets`)は H3 経路では実行しない | 5 |
| 10〜11 | レビュー・公開パッケージ | **変更なし** | 5・6 |
| 12 | 人間レビュー → 承認 | 提示するのは HyperFrames プレビューではなく **assemble が出した `out/final.mp4`**。承認後は**夜間レンダーキューへ投入しない**(assemble の完了が最終物) | 6 |

工程番号が factory-ui のフェーズ文と1対1で保たれるので、`VIDEO_CREATE_PHASES` も `stages` ラベルもそのまま流用できる。

### 夜間レンダーキューに載せない理由

`scripts/render-episode.sh` は `composition.html` の有無で HyperFrames と Remotion を分岐する。**ep015-salmon には既に composition.html が存在する**ため、H3 経路のエピソードをキューに投入すると、エラーにならずに HyperFrames 実装を再レンダーして `out/final.mp4` を上書きし、**H3 の成果物を黙って捨てる**。H3 経路では assemble の完了をもって最終物とし、キュー投入の工程を持たない。

### 課金の砦を factory-ui のモードに預けない

`factory-ui/server/operations.ts` の `MODE_INSTRUCTIONS` は、semi モードで「途中の確認ポイントは自分で採用して先へ進んでよい(`<gate>` を出さない)」、auto モードで「`<gate>` は一切出力しない」と指示する。`jobs.ts` の `maybeAutoRespond` も auto では全ゲートを、semi では `render-check` 以外を自動承認する。動物転生の video-create の実績は **semi 6件・auto 1件・manual 0件**であり、semi が実運用の既定になっている。

したがって「人間がゲートで止める」ことを課金の唯一の砦にはできない。二重に守る。

1. **H3 経路は factory-ui の manual モードでのみ走らせる**(SKILL.md と `.channel-system.json` に明記)
2. **GPU を使うコマンドは環境変数 `H3_ALLOW_GPU` が無ければ非ゼロ終了する**(`run-chapter` と Pod 起動)

`render-check` 種別のゲートは流用しない。`jobs.ts` で revise 以外の応答をすると `renderApproved` が立ち、レンダー突入のバックストップが解除される副作用があるため。

### 「演出記述」列を渡さない理由

v1 は絵コンテの演出記述(HyperFrames 用の DOM/GSAP 指示)をそのまま英訳して H3 に渡し、画面内日本語80本・抽象装置79本・**ナレーションに無い文字を出したカット76件**を生んだ。ユーザーは7分20秒で視聴を放棄している。v2 は実質 `timing.json` の行本文を入力にすることで解決した。この入力経路は設計上の禁則として固定する。

## 5. ディレクトリ構成

実装コードは TypeScript にして既存の `src/pipeline/` 配下へ置き、データは `h3/` へ置く。語彙帳の定数名の綴り間違いを型検査が捕まえられるようにするため(章をまたいだ語彙の一貫性が本件の中心課題である)。

```
動物転生/
  src/pipeline/h3/
    types.ts              型(Vocab / ShotDecl / Cut / CutsFile / Finding)
    frames.ts             秒 → フレーム数(17k+5)
    compose.ts            【合成器】宣言 → 公式3フィールド。i2v指示行・CLOSEUP_GUARD 自動付与
    plan.ts               timing.json → 束ね候補の機械提示
    check.ts              検査規則(純粋関数)
    check-h3-prompt.ts    【課金前の砦】BLOCK/ADVISE・exit 0/1/2・--dump
    clip-metrics.ts       クリップの機械指標
    inspect-clips.ts      検品(コンタクトシート・ストリップ)
    config.ts             パス・Pod URL・LoRA・解像度(ハードコード解消)
    run-chapter.ts        章単位の生成(旧 chain.mjs)
    assemble.ts           早回し+字幕焼き+音声合成(v2 から移設)
  h3/
    vocab/<epId>.ts       【データ】STYLE・場所・被写体・脇役・閉じ文・ガード
    episodes/<epId>/
      cuts.json           カット割り台帳(h3-cut-planner の成果物)
      shots/chXX.ts       文面(h3-prompt-writer の成果物)
      jobs/               実際に投げた jobs.json(追跡用。batch-log には残らないため)
      subs/               字幕PNG(再生成できるので .gitignore)
      defects.md          検品台帳
    _archive/v2-remake/   退避済みの v2 一式(手を入れない)
  tsconfig.h3.json        h3/ を型検査の対象に含める(tsconfig.json は触らない)
```

**`tsconfig.json` は同期区分 IDENTICAL** であり、`include` を書き換えるとテンプレート同期チェッカーが恒久的に赤になる。`h3/` を型検査に含めるには、`tsconfig.json` を `extends` する `tsconfig.h3.json` を新設し、`package.json`(区分 VARIANT)へ `typecheck:h3` を足す。`src/pipeline/h3/` は既存の `include: ["src"]` に含まれるので `npm run typecheck` だけで足りる。

クリップ本体は `scratchpad_gen/minimax-style/<epId>/clips/` に置く。**ただし ep015-salmon だけは既存の `10-remake/clips/`(303本)へ写像する。** `batch.mjs` の skip 判定は出力ディレクトリ内のファイル存在だけを見るため、既存エピソードの出力先を変えると 303本が全部再生成される(=約4.6 GPU時間の課金)。写像は設定の1箇所に閉じる。

**クリップ置き場をエピソードごとに分けるのは必須である。** カットIDは `cL` + `lineId` の数字部分で、`lineId` は ep015 も ep018 も `L01, L02…` から始まる。置き場が共通だと、新規エピソードで生成を回したときに「その名前のファイルが既にある」と判定され、**ep015 のクリップを黙って新しいエピソードの素材として採用したまま正常終了する**。エラーにならないので気付けない。

同じ理由から、**カットIDの付け方(`cL` + `lineId.slice(1)`、束ねたカットは先頭行のID)は変更しない**。既存クリップと1対1で対応する唯一の鍵である。

## 6. コンポーネントの契約

### 6.1 vocab/<epId>.ts(データ層)

エピソード固有の語彙定数だけを持つ。エクスポートする名前は固定にし、`compose.ts` はこの名前でしか参照しない。

| 名前 | 役割 |
|---|---|
| `STYLE` | 画風。一字一句変えない |
| `CLOSE` / `CLOSE_H` / `CLOSE_TEXT` | 閉じの一文。人が写る/文字を出すカットで切り替える |
| `CLOSEUP_GUARD` | 寄りのカットに自動付与する画風保持文 |
| 場所定数 | `SEA` / `RIVER` / `HATCHERY` など。**カットは必ず場所から書き始める** |
| 被写体定数 | `ADULT` / `FRY` / `EGG` など |
| 脇役定数 | `BEAR` / `SEABIRD` など |
| `BLANK_PLATE` | 紙・帳面・罫線の代わりに使う無地の矩形 |

**v2 の内容をそのまま初版とする。** ユーザーが v2 を視聴して規則の変更を求めた場合、変わるのはこのファイルだけになる。

### 6.2 compose.ts(合成器)

`P({ body, sound, open, text })` を核とする。v2 の実装を移設したうえで次を加える。

- `non_diegetic_music` を `N/A` 固定にせず、引数で受け取れるようにする(既定は `N/A`)
- i2v 指示行の付与を `chain.mjs` から移す(合成器の責務にする)
- 寄り判定(`close shot` / `very close shot`)による `CLOSEUP_GUARD` 自動付与を移す
- **合成結果を返すだけにし、副作用を持たない**(検査器とレビュアーが同じ関数で全文を得られるようにするため)

### 6.3 plan.ts(束ね候補の提示)

`timing.json` を読み、各行の尺を出し、**5.17秒未満の行の隣接統合候補**を機械的に列挙する。統合の可否は意味判断なので h3-cut-planner が決める。plan.ts は候補と、統合後の尺・フレーム数・17k+5 グリッドへの丸め結果を出すだけにする。

束ねの効き所は「短い行を2〜3行まとめて6〜7秒に収める」ことであり、15秒級への長尺化ではない。15秒クリップは映像1秒あたりの生成時間が 26.2秒(5.17秒クリップは 14.5秒)で効率が悪い。

束ねの制約:

- **章をまたぐ束ねは禁止**(章の切れ目はカットの切れ目である)
- 束ねたカットの目標尺は、先頭行の `startSec` から「最終行の次の行の `startSec`」までの**タイムライン区間**とする(発話区間の合計ではない。次項参照)
- 束ねた行のナレーションが別々の実物を指す場合は束ねない(1カット1被写体の原則が破れるため)。この判断が h3-cut-planner の仕事である
- 生成尺は目標区間以上にする(早回しで縮めるのが v2 の方式であり、スロー再生は絵が破綻する)

### 束ねが組み立てに与える影響

v2 の `assemble.mjs` は「1クリップを対応する区間へ早回しして収める」方式である。

**尺の基準は「発話区間」ではなく「タイムライン区間」である。** 台本行の `endSec` と次の行の `startSec` の間には無音がある(ep015 実測: 302箇所すべてに 0.35〜0.70秒)。発話区間の合計で尺を決めると、ep015 では Σ(endSec − startSec) = 844.89秒 に対し総尺が 974.94秒 で、**130.05秒短い動画になる**。

正しい計算は v2 の実装どおり「その行の `startSec` から**次の行の `startSec`** まで(最終行は `totalDurationSec` まで)」であり、フレーム数で決める。

```js
const stop = i + 1 < lines.length ? lines[i + 1].startSec : totalDurationSec;
const frames = Math.round(stop * FPS) - Math.round(lines[i].startSec * FPS);
```

束ねたカットでは、先頭行の `startSec` から「最終行の次の行の `startSec`」までが1クリップの受け持ち区間になる。クリップと行の対応表は `cuts.json` の `lineIds` が持つ。

秒でなく**フレーム数**で決めるのは、秒で計算した試作が303本で +6.6秒ずれたため。字幕の表示窓も `(Math.round(start × FPS) − 区間先頭のフレーム) / FPS` という絶対時刻からの引き算で出しており、**この恒等式はタイムライン区間基準でのみ成立する**。発話区間基準にすると字幕の表示位置も後半で最大130秒ずれる。

### 6.4 check-h3-prompt.ts(課金前の砦)

`shots/chXX.ts` を読み、`compose.ts` で全文を組み、次を検査する。exit 0=緑 / 1=ADVISE のみ / 2=BLOCK あり。

**BLOCK(生成に進ませない)**

| # | 規則 |
|---|---|
| B1 | `integrated_multimodal_description:` / `overall_soundscape:` / `non_diegetic_music:` が、この順で各1回だけ存在する |
| B2 | first_frame を使うカットは、先頭行が `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.` と**逐語一致**し、直後に空行がある。使わないカットにはこの行が無い |
| B3 | `[Shot 1]` に時刻が付いていない。`[Shot 2]` 以降があれば `At MM:SS.mmm,` が単調増加し、いずれも尺の範囲内 |
| B4 | カメラ表現が公式12種の集合内(`Zoom In/Out`・`Push In/Pull Out`・`Pan Left/Right`・`Truck Left/Right`・`Tilt Up/Down`・`Pedestal Up/Down`・`Arc Shot`・`Tracking Shot`・`Static Shot`・`Shake Slightly/Strongly`・`POV`・`Roll Clockwise/Counterclockwise`)。振幅は `with small/large amplitude`、速度は `at slow/fast speed` のみ。**カメラ文の存在自体は要求しない**(公式に無い要件のため ADVISE に置く) |
| B5 | `[Shot 2]` 以降が公式のカット動詞5句(`the camera cuts to` / `the shot cuts to` / `the shot transitions to` / `the shot changes to` / `the shot switches to`)のいずれかを使っている |
| B6 | 尺が 17k+5 グリッドに乗り、124〜362フレーム(5.167〜15.083秒)に収まる |
| B7 | `firstFrameFile` が実在し、**basename が jobs 全体で一意**(Pod 側は basename でアップロードするため、別ディレクトリの同名ファイルが衝突する) |
| B8 | `id` が重複しない。`prompt` が空でない |
| B9 | 本文が英語(`<d>` 内と英語ダブルクォート内は除外)。英文中に漢字・かなが混ざっていない |
| B10 | 画面内文字の `"文字列", spelled with those N characters` の N が実際の文字数と一致する(既存 `check-text.mjs` を吸収) |

**ADVISE(指摘するが止めない)**

| # | 規則 | 根拠 |
|---|---|---|
| A1 | 禁則語(`paper` を場所以外で / `ruled line` / `notebook` / `ledger`)を含む | 紙・帳面・罫線は指定していない文字を強く呼ぶ(2026-08-19 に2度実証。鎖で4〜6カット引きずった) |
| A2 | 変形動詞(`transforms into` / `turns into` / `morphs`)を含む | 「AがBに変形」は事故る。移動・出現・拡大で書く |
| A3 | 多義語(`tank` など)を含む | `tank` は戦車になる |
| A4 | 閉じの一文が無い | 余白が人物・アイコン・数字で埋まる |
| A5 | 場所の記述から始まっていない | 場所を書かないとモデルが場所を発明する |
| A6 | 否定形での禁止(`no windows` など)を本文に含む | 否定形は効かない。描くものを限定する書き方に寄せる |
| A7 | カメラの記述が1つも無い | 公式の必須要件ではないので止めないが、動きの指定が無いカットは絵が停滞しやすい |
| A8 | ディゾルブ・フェード・ワイプを使っている | 公式は「ユーザーが明示的に求めたときは使ってよい」としているので禁止ではない。ただし既定はカットであるべき |

**ADVISE の判定は、合成後の全文ではなく書き手が書いた `body` に対して当てる。** 全文には合成器が必ず付ける閉じの一文が含まれ、その末尾の `and no people appear.` が A6 の否定形検出に毎回一致してしまう(実データで ADVISE 71件中40件が語彙帳由来の雑音になるという報告があった)。

**negative prompt が存在しない**(BasicGuider・CFG なし)ため、禁止は本文で「これ以外は出ない」と閉じるのが唯一の手段である。A4 はこの制約の帰結。

### 6.5 inspect-clips.ts(検品の機械側)

生成済みクリップから、AI が見るための材料と数値を作る。

- **章コンタクトシート**: 既存 `sheet.mjs` を移設。ただし代表フレームの抽出位置を `-ss 4.0` 固定から**クリップ尺に対する相対位置**へ変える(現行は 5.17秒クリップで末尾付近になる)
- **クリップ内ストリップ**: 1本を 3〜5フレーム(先頭・1/4・中間・3/4・末尾)横並びの1枚に合成する。**クリップ内で進行する破綻(途中のモーフィング・崩壊)は現行の1枚方式では構造的に見えない**
- **機械指標**: フレーム間差分、輝度std、先頭/末尾フレームの差。どれを採用するかは §8 の較正で決める

**`signalstats` は単体では値を一切出力しない。** フィルタはフレームのメタデータを立てるだけなので、`metadata=print:key=lavfi.signalstats.YAVG` を連結して初めて `lavfi.signalstats.YAVG=2.06403` の形で標準エラーに出る。実測: 連結なしで 0行、連結ありで 123行(cL01)。`key=` を省くと28キー×フレーム数の行が出るので必ず指定する。

機械指標は**当たりを付けるためだけに使う**。閾値は §8 の較正で決め、相関しない指標は採用しない(既存規約「解析できない検査は緑にしない」)。

### 6.6 run-chapter.ts(生成)

v2 の `chain.mjs` を移設し、次を直す。

- Pod URL のハードコードを `config.ts` + 引数へ
- 出力先・クリップ置き場・エピソードパスの定数を config へ
- `batch.mjs` が全ジョブ失敗でも exit 0 を返す欠陥への対応(戻り値でなく `batch-log.jsonl` の `ok` を見る)
- 投げた jobs.json を `episodes/<epId>/jobs/` へ保存する(`batch-log.jsonl` にプロンプトが残らないため、これをしないと後から追跡できない)

**常駐監視ループ(v2 の `watch.sh`)は作らない。** クリップの欠けを検出して自動でジョブを投げる仕組みは、ファイル整理や検品作業に反応して意図しない GPU 課金を起こす。実際に本設計の着手時、3時間50分稼働していた `watch.sh` を停止させる必要があった。章単位で明示的に回す。

## 7. エージェント5体

置き場は `動物転生/.claude/agents/h3-*.md`。既存作法(`asset-generator.md` / `reading-checker.md`)に合わせる。

| 名前 | tools | model | 入力 | 出力 |
|---|---|---|---|---|
| `h3-cut-planner`(1体) | Read, Grep, Glob, Write, Bash | opus | `timing.json` / `script.md` / storyboard の体験設計節 / 束ね候補 | `cuts.json` |
| `h3-prompt-writer`(章ごと) | Read, Grep, Glob, Write | opus | `cuts.json` の担当章 + `vocab/<epId>.ts` | `shots/chXX.ts` |
| `h3-prompt-reviewer`(章ごと) | **Read, Grep, Glob のみ** | opus | 書き出された全文 + ナレーション原文 | PASS / REVISE の指摘【ADVISE】 |
| `h3-clip-inspector`(章ごと) | Read, Grep, Glob, Bash | opus | 章シート + ストリップ + 機械指標 | `defects/<章ID>.md` への追記 |
| `h3-fix-writer` | Read, Grep, Glob, Write | opus | `defects/<章ID>.md` と reviewer の REVISE | `shots/chXX.ts` の当該 body 書き直し |

モデルは全体 opus とする(ユーザー決定 2026-08-19)。2026-07-28 に `scene-implementer` が sonnet で稼働して演出を最小充足へ格下げし、根因特定のうえ opus 化した経緯があり、`h3-prompt-writer` はその H3 版にあたる創作出力である。

`h3-prompt-reviewer` は Bash を持たないので、合成後の全文は工程7で `check-h3-prompt --dump` がファイルへ書き出し、レビュアーにはそのパスだけを渡す(既存の「委譲はパス渡し」規律に合う)。

**Bash を持つエージェント(`h3-cut-planner` / `h3-clip-inspector`)の定義冒頭には、`pod.mjs` / `batch.mjs` / `npm run h3:run` を実行してはならないと逐語で書く。** GPU 課金が発生する。

`h3-fix-writer` は Write しか持たないのでクリップを移動できない。不合格クリップの隔離は `npm run h3:reject -- <epId> <clipId…>` に任せる。

### 共通の規律(既存作法から継承)

- 委譲は**パス渡し**。内容を貼らない
- 報告は30行以内の構造化サマリ
- **メインは全文 Read しない。メインは grep/sed で内容検査しない**(廃止したレビュアーの仕事の復活になるため)
- 合否に関わるエージェントは「制作の文脈を持たない新規コンテキストで起動される」ことを本文冒頭に明記し、`Write` / `Edit` を持たせない
- サブエージェントは同期実行。並列は1メッセージ内に複数の Agent 呼び出しを並べる

### h3-cut-planner の責務境界

**文面を書かない。** 出力は各カットについて次だけ。

```json
{
  "chapters": [
    { "id": "ch00", "title": "第一章", "name": "誕生", "cuts": ["cL001", "cL002"] }
  ],
  "cuts": {
    "cL001": {
      "lineIds": ["L001"],
      "seconds": 5.17,
      "place": "IN_GRAVEL",
      "subject": "EGG",
      "role": "導入",
      "chain": false,
      "hi": false,
      "text": false
    }
  }
}
```

`lineIds` が複数なら束ねたカット。`place` / `subject` は vocab の定数名であり、writer はこの指定に従う。

vocab に無い場所・被写体が必要になった場合、planner は **`cuts.json` の `needsVocab` に「定数名・用途・その行のナレーション」を書き出して止まる。** planner も writer も vocab を勝手に増やさない。語彙の追加は人間が承認してから vocab へ入れる(語彙が増えるほど章をまたいだ同一性が崩れるため)。

### h3-prompt-writer の責務境界

`cuts.json` の担当章だけを見て `body` / `sound` を書く。守る規則は3つ。

1. その行のナレーションが指している実物しか描かない(比喩・記号・図解を作らない)
2. 画面に文字・数字を出さない(章カードと明示指定のカットを除く)
3. 1カット = 1つの場所・1つの被写体・1つの動き・1つのカメラ動作

語順は「場所 → 被写体 → 動き → カメラ」。ナレーション原文はコメントとして残す。

**1体あたり25カット前後**に収まるので、ターン予算(80)の内側で完結する。303カットを1体に書かせる設計は取らない(23分尺の前例で、長時間1体はサブエージェントの31%が API エラーで死亡している)。

## 8. 較正 — GPU を使わずに閾値を決める

手元に**正常クリップ303本 + `clips-broken` 33本 + `clips-literal` 2本**がある。1本も生成せずに検品の閾値を詰められる。

1. broken 33本に症状ラベルを付ける(画風逸脱 / 解剖破綻 / 文字湧き / 被写体違い)
2. 正常側からも同数を無作為に抽出する
3. 両者に `inspect-clips.ts` の機械指標をかけ、ラベルとの相関を測る
4. 相関のある指標だけを採用し、閾値を決める。相関しない指標は捨てる

この較正は実装の**最初**に行う。指標の設計が検品エージェントの入出力を決めるため。

## 9. 生成と検品のループ

```
プロンプト承認ゲート(人間)
  ↓
Pod 起動(pod.mjs up)        ← ここで初めて課金が始まる
  ↓
章ごとに: run-chapter → inspect-clips → h3-clip-inspector → defects.md
  ↓ 不合格があれば
h3-fix-writer → check-h3-prompt → 該当クリップを clips-rejected/ へ移動 → 再生成
  ↓ 全章合格
Pod 停止(pod.mjs down)
```

### 差し戻しの規約

- 不合格クリップは**削除せず** `clips-rejected/<epId>/` へ移す(較正材料になる)。移せば `batch.mjs` の skip 判定が外れて再生成される
- **鎖の途中を直すときは鎖の入口から作り直す。** 前カットの最終フレームを起点にしているため、途中を差し替えると下流が全部ずれる。鎖は版面の保持に効く一方、事故も同じ強さで伝播する
- `seed` は 0 固定(再現性)。同じ body で別の絵が欲しいときだけ振る。振り方は2つで、
  章全体は `npm run h3:run -- <epId> <章ID> --seed <n>`、1カットだけは宣言(`shots/<章>.ts`)に `seed: <n>` を書く。
  **宣言が CLI より強い**(採用した take の seed を宣言に残せば、章全体の指定で流されずに再現できる)。
  ぶつかったカットは実行時に列挙される。不合格クリップの作り直しは `h3:reject` で隔離してから `--only <id> --seed <n>`

### 検品の見せ方(コンテキスト規律)

1章25カットに対して、章シート1枚を Read → 機械指標で疑わしいクリップを絞る → **そのクリップだけ**ストリップを Read。1章あたり画像6枚程度(約10k tok)に収める。全クリップを多フレームで見せる設計はコンテキストが破綻する(画像1枚 ≈ 1,600 tok)。

## 10. 未決事項

| # | 事項 | 影響 |
|---|---|---|
| U1 | **v2(ep015-minimax-v2.mp4)の評価が未実施** | `vocab/<epId>.ts` の中身が変わる。構造と検査器の実装は影響を受けない。なお全長版は ch04・ch06b・ch08〜ch11 が未検品のまま焼かれている |
| U2 | 地図カット(`NPAC_MAP` / `JAPAN_MAP`)を採用するか | v2 の方針文「地図も原則描かない」と定数の存在が食い違っている。vocab に残すが、cuts.json で指定されなければ使われない |
| U3 | `overall_soundscape` の定型文が映像側の描画に影響するか | 未検証。音映像同時生成モデルのため無関係とは言い切れない。定型文で埋める方針は決定済みなので、影響が疑われたときに再検証する |

## 11. リスク

| リスク | 対策 |
|---|---|
| クリップの出力先を変えると 303本が再生成される(課金) | ep015-salmon の出力先は既存パスへ写像する。§5 に明記 |
| 新規エピソードが ep015 のクリップを黙って流用する | クリップ置き場を epId ごとに分ける。§5 に明記 |
| factory-ui の semi/auto が人間ゲートを自動突破して無人で GPU を回す | manual 限定 + `H3_ALLOW_GPU` の二重ロック。§4 に明記 |
| 承認後のキュー投入が HyperFrames を焼いて H3 の成果物を上書きする | H3 経路はキューに投入しない。§4 に明記 |
| 発話区間で尺を決めて 130秒短い動画になる | タイムライン区間で決める。§6.3 に明記 |
| `signalstats` が値を出さず機械指標が常にゼロになる | `metadata=print` を連結する。§6.5 に明記 |
| `tsconfig.json` を書き換えてテンプレート同期が恒久的に赤になる | `tsconfig.h3.json` を新設する。§5 に明記 |
| 常駐ループが意図しない生成を起こす | `watch.sh` 相当を作らない。§6.6 に明記 |
| 参照画像の basename 衝突で別の画像が起点になる | B7 で検査 |
| 尺レンジ外が Pod 起動後に判明する | B6 で検査 |
| 検査器が緑なのに絵が破綻する | 検査器は形式のみを保証する。意味は reviewer(ADVISE)と inspector が見る |
| エージェント新設が既存規約に触れる | `/system-refine` の規定によりユーザー承認が要る。2026-08-19 に取得済み |

## 12. 実装の順序

1. **指標の探索と較正**(§8)— GPU ゼロ。使い捨てスクリプトで broken 33本と正常サンプルを測り、採用する指標と閾値を確定させる。`inspect-clips.ts` の設計はこの結果に従う
2. **恒久化**— `_archive/v2-remake/` から `h3/` へ移設し、config 化する
3. **check-h3-prompt.ts**— 課金前の砦。既存 `shots/ch00〜ch11.mjs` 303カットを実データとして通す
4. **inspect-clips.ts**— 較正で決めた指標を実装
5. **エージェント5体**の定義
6. **video-create/SKILL.md** の工程書き換え
7. **ep015 で実走検証**(既存クリップがあるので生成本数は最小で済む)
