# H3経路の見直し — 生成設定・カット割り・生成音・Ref2VA 設計

作成日: 2026-08-24
対象: 動物転生(animal-isekai-hell)
状態: 設計確定・実装前
前提となる設計: `docs/superpowers/specs/2026-08-19-h3-prompt-pipeline-design.md`(工程・契約の正本。本書はその差分)

## 1. 背景

H3経路は ep015(移設)・ep016(初回実走)・ep017 の3本を通した。仕組みは動いているが、
**構築時に決めた設定のまま一度も見直していない**。H3 は 2026-07-31 公開の新しいモデルで、
turbo LoRA・推奨サンプラ・Ref2VA チェックポイントが公開後に更新されている。

同時に、既存の実測ログ(700本)を再集計したところ、設計時には見えていなかった欠陥が2つ出た
(§3)。本書はこの2系統 — **外部の更新への追随**と**実測から出た欠陥の是正** — をまとめて扱う。

## 2. 決定事項(2026-08-24 ユーザー判断)

| 項目 | 決定 |
|---|---|
| 生成音 | **捨てない。** ナレーション+BGM+既存SEの下に環境音として敷く |
| 音と早回しの関係 | **音は原速のまま区間ぶんを頭から切り出す**(映像の早回しに追従させない) |
| 早回しカットの是正 | 束ね直しを主・切り出しを受け皿にする。**「1カット1被写体」を機械的に緩めることはしない** |
| ep018(カバ) | **本改修を全部済ませてから**着手する |
| 第1弾のA/B | 2段構え(まず一式で差を見て、差があれば要素へ割る) |
| Ref2VA | **検証だけ先に行う。** 採用判断は見てから。ep018 は現行経路で回す |

## 3. 実測 — 何が根拠か

### 3.1 生成時間はフレーム数に対し超線形

`clips/batch-log.jsonl` の成功行を集計した(ep016 267行・ep017 189行・ep015 350行)。

| 生成尺 | 1本あたり(ep016) | 1映像秒あたり |
|---|---|---|
| 5.17秒(124F) | 45.9秒 | 8.9秒 |
| 6.58秒(158F) | 62.8秒 | 9.5秒 |
| 8.00秒(192F) | 82.3秒 | 10.3秒 |
| 10.83秒(260F) | 131.0秒 | 12.1秒 |

**長いクリップほど1秒あたりが高くつく。** 設計 §6.3 が steps=20 の時点で出していた結論
(15秒級への長尺化はしない)は turbo 4step でも変わらない。**束ねの目的は尺の延長ではなく、
下限 5.17秒への詰め寄せである。**

### 3.2 完成尺の28%が1.4〜2.6倍速で流れている

ep016 の `cuts.json` と `timing.json` を突き合わせた(生成尺 ÷ タイムライン区間)。

```
カット数 248 | 生成 1508.0秒 | タイムライン 1277.6秒 | 余剰 230.4秒(18.0%)
早回し倍率  1.00–1.05: 64本 / 1.05–1.2: 99本 / 1.2–1.4: 15本 / 1.4–1.7: 38本 / 1.7以上: 32本
最大 2.61倍(cL251 区間1.98秒 → 生成5.17秒)
```

**1.4倍以上の70本はすべて「束ねられなかった2秒台の単行カット」である。** 下限 5.17秒で焼いて
早回しで詰めているため、映像は不自然に速くなり、GPU時間の18%は捨てられている。

### 3.3 生成音はすでに手元にある

既存クリップは `CreateVideo` が音声つき mp4 を出しているため、**全クリップに 32kHz ステレオAAC が
入っている**(ep016 の実測で確認)。`assemble.ts` が最終 mux で `-map 0:v` と `-map 1:a`(master.mp3)
だけを拾い、クリップ側の音を捨てている。**評価にも実装にも GPU は要らない。**

### 3.4 公式推奨のうち3点が未適用

| 項目 | 現状 | 公式/コミュニティ推奨 |
|---|---|---|
| turbo LoRA | `..._turbo_4step_v1.0_768p_comfyui_bf16` | **v1.1** が公開済み |
| sampler | `res_multistep` | turbo は `euler` |
| sigma shift | **未適用**(実装はあるがテストからしか呼ばれていない) | v1.1 は `shift_video: 6` / `shift_audio: 3` |
| LoRA strength | 1.0 | 1.2〜1.3 の報告あり |
| 解像度 | 1152x640(0.74MP・短辺640) | ネイティブは短辺768(1344x768 ≒ 1.03MP) |
| attention | 不明(記録なし) | `--use-sage-attention` で約2倍の報告 |

**8/23のベイクオフの「steps=20 は暗く潰れる」は、両条件とも sigma shift 未適用での比較だった。**
turbo 採用の結論は覆さないが、turbo 側に詰め代が残っている根拠になる。

出典: [ComfyUI 公式チュートリアル](https://docs.comfy.org/tutorials/video/minimax/minimax-h3) /
[lightx2v/Minimax-h3-Turbo discussions/42](https://huggingface.co/lightx2v/Minimax-h3-Turbo/discussions/42) /
[ComfyUI Wiki](https://comfyui-wiki.com/en/tutorial/advanced/video/minimax/minimax-h3)

## 4. 第1弾 — 生成設定の確定

### 4.1 目的

「どの設定で焼くか」を実測で決める。**画質の良否は機械で測れない**
(`docs/h3-defect-calibration.md`: 12指標すべてが破綻を分離できなかった)ため、
判定はユーザーの目視で行う。本弾の成果物は**採用する設定値**であり、コードの汎化ではない。

### 4.2 素材

**ep016 の既存プロンプトをそのまま使う。** 新しく文面を書かない。
`npm run check:h3 -- ep016-honeybee <章> --dump` が出す全文から10カットを選び、
`tools/comfy-runpod/jobs/` の素の経路(`batch.mjs`)へ渡す。

選ぶ10カットの条件(画風の評価軸が全部出るように):

- 寄り(`close shot`)2本 / 引き 2本
- 動きの速いカット 2本 / ほぼ静止 2本
- 章カード(`text: true`)1本 — **文字精度は解像度に最も敏感なので必ず入れる**
- 鎖(i2v)1本 — first_frame 経路が設定変更で壊れないことの確認

出力先は `tools/comfy-runpod/out/settings-2026-08-24/`。
**`scratchpad_gen/minimax-style/<epId>/clips/` へは絶対に書かない**(既存クリップと同名で
上書きすると、その ep の再生成が要る)。

### 4.3 段1 — 現行 vs 公式推奨一式

| 条件 | LoRA | steps | sampler | sigma shift | 解像度 |
|---|---|---|---|---|---|
| `base` (現行) | v1.0 | 4 | res_multistep | なし | 1152x640 |
| `rec` (推奨一式) | **v1.1** | 4 | **euler** | **6 / 3** | **1344x768** |

20本・約20分・約$0.35。**同一 seed(0)・同一プロンプト**で焼き、ユーザーが10組を見比べる。

判定:

- `rec` が明確に良い → 段2へ進まず採用。§4.6 へ
- 差が無い / 悪い → 段2で要素へ割る

### 4.4 段2 — 要素の切り分け(段1で差が出なかった場合のみ)

`base` から1要素ずつ変えた4条件 × 10本。約$0.7。

| 条件 | 変える要素 |
|---|---|
| `v11` | LoRA を v1.1 にするだけ |
| `euler` | sampler を euler にするだけ |
| `shift` | sigma shift 6/3 を足すだけ |
| `768` | 解像度を 1344x768 にするだけ |

**LoRA strength 1.2〜1.3 は段2でも試さない。** 報告の出どころが1件のコメントで、
強度を上げると画風が LoRA 側へ寄る性質があるため、STYLE 文の逐語一致で担保している
画風の同一性と衝突する。段1・段2で決着しなかったときの予備に置く。

### 4.5 sage attention

**設定のA/Bとは別枠で、Pod を起動したときに1回だけ確認する。**

1. `node comfy.mjs stats` に加え、`/system_stats` の返す起動引数を見る
2. 有効でなければ、Volume の venv に `sageattention` が入っているかをログAPI(`/internal/logs/raw`)で確認する
3. 入っていれば `buildCreateBody` の `env` 経由で ComfyUI へ `--use-sage-attention` を渡せるかを調べる

**この調査で Pod の稼働を延ばさない。** 段1の生成と同じ Pod セッション内で済ませ、
分からなければ「分からなかった」と記録して `down` する。恒久化は別件にする。

### 4.6 採用の反映先

決まった設定は次の2箇所に書く。**両方を同時に変える。**

- `src/pipeline/h3/config.ts` — `LORA` / `STEPS` / `SIZE_DEFAULT` / `SIZE_HI` と、新設する `SAMPLER` / `SIGMA_SHIFT`
- `tools/comfy-runpod/lib/workflow-minimax.mjs` の既定値は**変えない**。呼び出し側(`run-chapter.ts`)が
  明示的に渡す。ファクトリールートの CLI は他チャンネル(業の日本史)も使うため、
  動物転生の判断を既定へ焼き込まない

`run-chapter.ts` が書き出す `jobs/job-<id>.json` の `defaults` に `sampler` と `sigmaShift` を足す。
`batch.mjs` は `job.sigmaShift` を既に読むが、**`sampler` は現状 `buildT2V` の既定値を使っており
ジョブから渡せない**。`batch.mjs` に1行足す。

### 4.7 解像度を上げた場合の影響

`SIZE_DEFAULT` を 1344x768 にすると画素が +40%、生成時間も概ね +40%(§3.1 より超線形なので
それ以上になりうる)。ep016 規模で 4.3時間 → 6時間程度。

**これは §5 の束ね直しによる -18% と、sage attention が有効なら -50% で相殺する見込みだが、
相殺を前提に採用を決めない。** 解像度の採否はあくまで段1・段2の目視で決め、
所要時間は決まった後に実測で報告する。

## 5. 第2弾 — カット割り・生成音・プロンプト

### 5.1 早回しの是正(§3.2 への対応)

#### 5.1.1 早回し倍率を機械で可視化する

新設: `src/pipeline/h3/plan.ts` に `speedupRatios()` を足し、`build-cuts.ts` と
`check-h3-prompt.ts` の両方から呼ぶ。

```
ratio = (grid(cut.seconds) / FPS) / spanSeconds(...)
```

`check:h3` に **ADVISE A10** を新設する。

| # | 規則 | 根拠 |
|---|---|---|
| A10 | 早回し倍率が 1.4 を超える | 映像が不自然に速くなり、生成音がそのままでは使えない(§3.2 実測) |

**BLOCK にしない。** 束ねの可否は意味判断であり、束ねられないカットは正当に存在する
(設計 §6.3「別々の実物を指す場合は束ねない」)。機械が止めてよい種類の規則ではない。

#### 5.1.2 h3-cut-planner の責務を1つ足す

`.claude/agents/h3-cut-planner.md` に次を書く。

> `plan.ts` が出す早回し倍率が 1.4 を超えるカットについては、**隣接行との束ねを検討する義務を負う**。
> 束ねられない場合(別々の実物を指す・章をまたぐ)は、`cuts.json` の当該カットに
> `"holdSlow": true` を立てて、束ねなかったことを明示する。判断の理由は書かない(台帳は契約であって散文ではない)。

`Cut` 型に `holdSlow?: boolean` を足す。この値を読むのは §5.1.3 の切り出しだけにする。

**`place` / `subject` / `needsVocab` がどのコードにも読まれていない**(引き継ぎメモの指摘)状態を
これ以上増やさないため、**新しい欄は必ず読み手とセットで入れる。**

#### 5.1.3 切り出し(受け皿)

`holdSlow: true` のカットは、`assemble.ts` で**早回しをやめて頭から等速で必要フレームだけ使う**。

現行:
```
setpts=(dst/src)*PTS, fps=24, trim=start_frame=0:end_frame=dst
```
`holdSlow` のとき:
```
fps=24, trim=start_frame=0:end_frame=dst, setpts=PTS-STARTPTS
```

`speedFilter()` を `videoFilter(srcFrames, dstFrames, holdSlow)` へ広げる。**純粋関数のまま保つ**
(`preview-chapter.ts` が import しており、プレビューと本番の一致がこれで担保されている)。

代償: クリップ後半に置いた動きは切れる。したがって `h3-prompt-writer` に次を書く。

> 担当カットが `holdSlow: true` のときは、**絵が先頭2〜3秒で完結するように書く**。
> 動きの山を後半へ置かない。カメラは静止か、ごく小さい動きにする。

#### 5.1.4 やらないこと

- **`MIN_CLIP_SEC` を下げない。** 124フレーム未満は学習レンジ外(`framesForSeconds` の
  `isBelowTrainedRange`)であり、下限を破ると画質が落ちる
- **早回し倍率で自動的に束ねない。** 束ねは意味判断であり、機械化すると「1カット1被写体」が壊れる

### 5.2 生成音を環境音として敷く

#### 5.2.1 なぜ独立したトラックにするか

`src/pipeline/audio-mix.ts` は**テンプレート同期区分 HF_IDENTICAL**(バイト一致必須)で改変できない。
また audio-mix は SE を1本ずつ **-22 LUFS へ正規化する**ため、環境音を SE キューとして登録すると
静かな環境音が持ち上がって鳴り続ける。

したがって **`master.mp3` とは別に `ambient.wav` を作り、`assemble.ts` の最終 mux で混ぜる。**
audio-mix・build-audio-cues-h3 は一切変更しない。

#### 5.2.2 新設: `npm run h3:ambient -- <epId>`

`src/pipeline/h3/build-ambient.ts`。

入力: `cuts.json` / `timing.json` / クリップ / `h3/episodes/<epId>/ambient.json`(§5.2.3)
出力: `episodes/<epId>/narration/ambient.wav`(総尺 = `timing.totalDurationSec`)

手順:

1. `assemble.ts` の `buildSegments()` をそのまま import して区間を得る(**組み立てと同じ純粋関数を使う**。
   別々に計算すると片方だけずれる)
2. 各区間について、クリップの音声を **0秒から区間長ぶん、原速で** 切り出す
   (クリップ尺は常に区間長以上なので、切り出しは必ず成立する。安全のため不足時は無音で埋める)
3. 除外指定のあるカットは同じ長さの無音にする
4. 区間は隙間なくタイル状に並ぶので、**順に連結するだけで総尺に一致する**
5. 全体を `ambient.json` の `gainDb` で減衰させて書き出す

自己検算: 出力尺と `totalDurationSec` の差が 0.05 秒を超えたら異常終了する。

#### 5.2.3 `h3/episodes/<epId>/ambient.json`(新設の契約)

```json
{
  "gainDb": -18,
  "exclude": ["cL023", "cL117"],
  "perClip": { "cL045": { "gainDb": -30 } }
}
```

- `gainDb` — 全体の敷き量。既定 -18 dB。**第2弾の実装時にユーザーが ep016 で聴いて決める**
- `exclude` — 音が破綻しているカット(人の声・音楽・耳障りなノイズ)。無音に置き換える
- `perClip` — 個別の増減

ファイルが無ければ `{ gainDb: -18, exclude: [], perClip: {} }` を既定とする。
JSON Schema を `src/schemas/` に置き、`h3:ambient` が起動時に検証する。

#### 5.2.4 assemble の最終 mux

```
-i video-subbed.mp4 -i master.mp3 [-i ambient.wav]
-filter_complex "[1:a][2:a]amix=inputs=2:duration=first:normalize=0[aout]"
-map 0:v -map [aout]
```

`normalize=0` を必ず付ける(既定の `normalize=1` は入力数で割ってナレーションを半分にする)。
`ambient.wav` が無ければ現行どおり `-map 1:a` にフォールバックする。
**リミッタは掛けない** — master.mp3 側で既に -1.5 dBFS に収まっており、
-18 dB の環境音を足しても超えない。総和が -1.0 dBFS を超えたら警告を出す。

#### 5.2.5 検品への追加

`npm run h3:preview -- <epId> <章ID>` は `buildSegments` と `speedFilter` を import する一方、
**映像のフィルタ列と音の mux は自前に持っている**(`master.mp3` から章の区間だけを切り出して
先頭へ寄せている)。したがって **§5.2.4 の変更だけでは環境音つきにならない。**
`preview-chapter.ts` にも同じ2点を入れる。

- `videoFilter()` への差し替え(`holdSlow` の反映)
- `ambient.wav` を master と同じ「章の区間を切り出して先頭へ寄せる」フィルタに掛け、
  2本を `amix=normalize=0` で混ぜる

**プレビューと本番の一致がこの経路の要**(章ごとの目視はこれでしか成立しない)なので、
フィルタ列は純粋関数として `assemble.ts` に置き、**両者が同じ関数を呼ぶ形にする**。
コピーを2箇所に持たない。

`h3-clip-inspector` に「音」の観点を足す。ただし**この検品は音を聴かずに行えない**ため、
エージェントには渡さず**人間の章プレビューで見る**。エージェント定義には
「音の可否は判定しない」と明記して、判定できないものを判定させない。

#### 5.2.6 `overall_soundscape` の扱い

音を使うようになった以上、**定型文で埋める運用はやめる**。`h3-prompt-writer` に
公式ガイド §4.6 の水準(1〜4文・環境音+動作音+非言語の人の声)で書くことを求める。

ただし **`non_diegetic_music` は `N/A` のまま固定する。** BGM は `bgm-plan.json` の
包絡線設計が正であり、カットごとに生成音楽が入ると設計と衝突する。
`compose.ts` の `music` 引数は残すが、writer には使わせない(`check-h3-prompt` に
**BLOCK B12: `non_diegetic_music` が `N/A` 以外**を新設する)。

#### 5.2.7 既存3エピソードの扱い

ep015・ep016・ep017 は**焼き直さない**。`h3:ambient` は既存クリップに対しても動くので、
ユーザーが望めば ep016 を組み立て直せるが、**それは本改修の完了条件に含めない**。

### 5.3 プロンプティング

#### 5.3.1 1クリップ内の時刻ブロック

公式ガイド §4.2 は `[Shot 2] At 00:03.500, the camera cuts to…` を認めており、
`check.ts` の B3・B5 は既に検査を持っている。**しかし一度も使われていない。**

**規約としては「7秒を超えるカットでは検討してよい」に留める。** 必須化しない。
理由は2つ:

- ADVISE A7(カメラの記述が無い)は既に「停滞」を拾っており、二重の網になる
- 1カット1被写体の原則と、カット内カットは相性が悪い

`h3-prompt-writer` に「7秒超のカットで絵が停滞するなら、公式のカット動詞で内部にショットを
足してよい」と1文だけ書く。効果測定は行わない(**測れないものを工程にしない**)。

#### 5.3.2 否定形の切り分け

社内実証は「否定形は効かない」、外部ガイド2件は "Negative direction is unusually effective" と
真逆を言う。凍結中の `STYLE` / `CLOSE` に否定形が残っており、`check:h3` の ADVISE が
ep015 で19件出続けている。

**本改修では判定しない。** 第1弾のA/Bと同じ Pod セッションで**2本だけ**確認する:
同一カットを「閉じの一文あり」「なし」で焼き、余白が埋まるかを見る。
結果がどちらでも `vocab` は変えない(凍結はユーザー確定事項)。**記録だけ残す。**

#### 5.3.3 やらないこと

- ADVISE の regex を増やさない。現行の A1〜A9 は実データで雑音率を詰めた結果であり、
  新語を足すと「語彙帳由来の雑音」が再発する(設計 §6.4 の脚注)

## 6. 第3弾 — Ref2VA 検証

### 6.1 位置づけ

**検証のみ。** 採用判断はユーザーが見てから行う。ep018 は現行経路(FL2VA)で回す。
本弾の成果物は**判断材料と記録**であって、パイプラインへの分岐実装ではない。

### 6.2 前提の確認(GPUを使う前に行う)

1. `minimax_h3_ref2va_pruned_int8_convrot.safetensors`(約19.5GB)と
   `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` の DL 先を確認する
2. **Network Volume の空き容量を確認する。** 足りなければここで止めてユーザーへ報告する
3. `MiniMaxH3ReferenceToVideo` ノードが Pod 上の ComfyUI に在ることを `/object_info` で確認する

### 6.3 検証の内容

参照は `~/.claude/skills/h3-prompt-writing/references/ref-en.txt` の6節形式に従う
(`subject_definitions` / `summary` / `retention_analysis` / `detailed_description` /
`overall_soundscape` / `non_diegetic_music`)。**`compose.ts` はこの形式を組めない**ため、
検証では文面を手で書き、素の `batch.mjs` 経路へ渡す。

- 参照画像: ep016 の既存クリップから「主人公の蜂が最もよく描けているフレーム」を1〜3枚抜く
- 比較対象: 同じカットの既存クリップ(FL2VA・STYLE文のみで同一性を担保したもの)
- カット数: 章をまたぐ8カット(序盤2・中盤3・終盤3)。**同一性は距離が離れるほど崩れる**ので、
  近接カットだけで測らない

約10本・$0.2程度。

### 6.4 判定

ユーザーが2系統を見比べ、次を記録する。

- 主人公の同一性(色・体の比率・目の形)が上がったか
- 画風(セルアニメ調)が保たれたか、参照写真寄りに崩れなかったか
- 生成時間が FL2VA と比べてどうか

**採用となった場合の設計は本書に含めない。** 別の設計として起こす。

## 7. 変更するファイル

| ファイル | 変更 | 弾 |
|---|---|---|
| `src/pipeline/h3/config.ts` | `SAMPLER` / `SIGMA_SHIFT` 新設、`LORA` / `STEPS` / `SIZE_*` 更新 | 1 |
| `tools/comfy-runpod/batch.mjs` | `job.sampler` を `buildT2V` へ渡す | 1 |
| `src/pipeline/h3/run-chapter.ts` | `defaults` に `sampler` / `sigmaShift` | 1 |
| `src/pipeline/h3/plan.ts` | `speedupRatios()` 新設 | 2 |
| `src/pipeline/h3/types.ts` | `Cut.holdSlow` | 2 |
| `src/pipeline/h3/check.ts` | ADVISE A10 / BLOCK B12 | 2 |
| `src/pipeline/h3/build-cuts.ts` | 早回し倍率の自己検算出力 | 2 |
| `src/pipeline/h3/assemble.ts` | `videoFilter()` へ拡張・ambient の mux | 2 |
| `src/pipeline/h3/preview-chapter.ts` | `videoFilter()` へ差し替え・章区間の ambient を mux | 2 |
| `src/pipeline/h3/build-ambient.ts` | **新設** | 2 |
| `src/schemas/h3-ambient.schema.json` | **新設** | 2 |
| `package.json` | `h3:ambient` | 2 |
| `.claude/agents/h3-cut-planner.md` | 早回し1.4倍超の束ね検討義務・`holdSlow` | 2 |
| `.claude/agents/h3-prompt-writer.md` | `holdSlow` の書き方・`overall_soundscape` の水準・時刻ブロック | 2 |
| `.claude/agents/h3-clip-inspector.md` | 音の可否は判定しないと明記 | 2 |
| `.claude/skills/video-create/SKILL.md` | 工程8.4 に `h3:ambient` を挿す | 2 |
| `CLAUDE.md` | `h3:ambient` をコマンド一覧へ | 2 |

**触らないもの**: `src/pipeline/audio-mix.ts` / `build-audio-cues.ts`(HF_IDENTICAL)、
`tsconfig.json` / `.gitignore`(IDENTICAL)、`h3/vocab/*.ts`(凍結)、
`tools/comfy-runpod/lib/workflow-minimax.mjs` の既定値(他チャンネルが使う)。

## 8. 検証

| 対象 | 方法 |
|---|---|
| `speedupRatios` / `videoFilter` / `build-ambient` の純粋部分 | 単体テスト(TDD)。既存 `*.test.ts` に倣う |
| A10 / B12 | 既存3エピソードの実データを通す。ep016 で A10 が70件出ることを確認する |
| ambient.wav | ep016 で焼き、**尺が `totalDurationSec` と一致する**ことを機械で確認 → ユーザーが聴いて `gainDb` を決める |
| assemble の非退行 | ep016 を組み立て直し、**映像の尺とフレーム数が現行と一致する**ことを確認する |
| プレビューと本番の一致 | ep016 の1章を `h3:preview` で焼き、同じ区間を本番と突き合わせる(フィルタ列が同じ関数から出ていること) |
| 生成設定 | 第1弾のA/B。ユーザー目視 |
| Ref2VA | 第3弾。ユーザー目視 |

`npm test` / `npm run typecheck` / `npm run typecheck:h3` / `node scripts/check-template-sync.mjs`
を各弾の終わりに通す。

## 9. リスク

| リスク | 対策 |
|---|---|
| A/Bの出力が既存クリップを上書きし、その ep の再生成が要る | 出力先を `tools/comfy-runpod/out/settings-2026-08-24/` に固定。§4.2 |
| 解像度を上げて所要時間が跳ね、ep018 が高くつく | 採否は目視で決め、**決まった後に実測を報告してからep018へ入る** |
| Ref2VA の 19.5GB で Volume が溢れる | DL前に空き容量を確認して止まる。§6.2 |
| `amix` の既定 `normalize=1` でナレーションが半分になる | `normalize=0` を明示。§5.2.4 |
| 環境音に人の声・音楽が混じって作品の音設計を壊す | `ambient.json` の `exclude`。章プレビューで人間が聴いて拾う |
| `holdSlow` が `place` / `subject` と同じ「誰も読まない欄」になる | `assemble` が読む。読み手とセットでしか欄を作らない。§5.1.2 |
| 束ねを機械化して「1カット1被写体」が壊れる | A10 は ADVISE。束ねの判断は planner に残す。§5.1.4 |
| Pod の停止忘れ | 各弾の終わりに `npm run h3:pod -- down`。GPUコマンドは `H3_ALLOW_GPU=1` の二重ロックのまま |
| 設定変更で i2v(鎖)経路が壊れる | A/Bの10本に鎖1本を必ず含める。§4.2 |

## 10. 未決事項

| # | 事項 | いつ決まるか |
|---|---|---|
| U1 | 採用する生成設定(LoRA版・sampler・shift・解像度) | 第1弾のA/B |
| U2 | sage attention が現行 Pod で有効か、有効化できるか | 第1弾の Pod セッション |
| U3 | `ambient.json` の `gainDb` の既定値 | 第2弾で ep016 を聴いて決める |
| U4 | 否定形が効くか | 第1弾で2本だけ確認。**結果に関わらず vocab は変えない** |
| U5 | Ref2VA を採用するか | 第3弾 |
| U6 | 既存3本(ep015–017)を環境音つきで組み立て直すか | 第2弾の完了後にユーザーが決める。完了条件に含めない |
| U7 | 本改修をテンプレート正本・業の日本史へ還元するか | ep018 の実走後。`/system-refine` 案件 |
