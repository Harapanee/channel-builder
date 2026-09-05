# H3 経路の図解オーバーレイ(figures)設計

日付: 2026-09-04 / 対象: H3 経路のエピソード(最初の適用は ep026-sea-otter)

## 動機

bible は「スケールは比較で見せる」(§8)・説明の道具5つ(§?174行)・図解はコード生成(186行)と定めるが、
H3 経路には図解を焼く工程が無く、数字が続く行が字幕だけで流れていた。
H3 自身に図や文字を描かせるのは不可(文字化け・否定形が効かない。ep026 の章カードで実証)。

## 方式(B案: 透過連番オーバーレイ)

1. **契約** `h3/episodes/<epId>/figures.json` — 図解の宣言。行ID(+句の番号)で表示窓を決め、型(`bars` / `grid`)とデータを持つ
2. **焼き** `npm run h3:figures -- <epId>` — 図解1つを小さな HTML(GSAP タイムライン・paused・決定論)として組み、
   Playwright で 24fps の各フレームをシークして **透過PNG連番** に焼く(`h3/episodes/<epId>/figures/<id>/f%05d.png`)。
   **下の映像を暗くする層(rgba 黒 × dim)も図解側に焼き込む**ので、assemble には「重ねる」以外の仕事を増やさない。
   結果台帳 `figures/index.json`(id・絶対開始フレーム・フレーム数・宣言のハッシュ)
3. **重ね** `h3:assemble` — 字幕PNGと同じ `overlay` + `enable=between(t,from,to)` の経路。区間(CHUNK)ごとに
   連番の必要範囲だけを `-start_number` で読み、`setpts` で区間内の時刻へ置く。**字幕より下、映像より上**。
   part のキャッシュ鍵に図解の(id・開始・フレーム数・index の mtime)を含める

## 表示窓

- `from` = `lines[lineId].phrases[fromPhrase].startSec`(省略時は行頭)
- `to` = `lines[toLineId ?? lineId]` の `phrases[toPhrase].endSec`(省略時は行末)+ `holdSec`(既定 0.3)
- フェードイン/アウト(0.35秒)は図解のタイムラインに焼き込む

## 項目の留め(2026-09-05 追加・先バレ防止)

- 契機: 板は窓の頭で出るが、項目(棒・塊・目盛り・内訳)は固定間隔(0.45秒等)で並んでいたため、
  ナレーションが言う前に数字が見えていた(ep027 の「五十匹」は7秒、「数十万匹」は8秒早かった)
- 各項目に `atPhrase`(+`atLineId`。省略時は図解の `lineId`)を書くと、その句の `startSec` に出る(`figures.ts` の `figureReveals`)。
  留めの無い項目は前の項目の直後(型ごとの間隔: bars 0.45 / scale 0.5 / timeline 0.35 / recap 0.4 / grid 0.6)。先頭は 0
- `caption` は `captionAtPhrase`(+`captionAtLineId`)で留める。省略時は板と同時
- 描画は項目の時刻を `data-at` として HTML に埋め、GSAP タイムラインへそのまま置く。**尺に合わせて縮めない**(縮めると句とずれる)
- 検査(`validateFigure`): `bars` / `scale` / `timeline` / `grid` の `segments`(2つ以上)では**2つ目以降の項目の留めが必須**。
  留めた句が窓の頭より前・窓の尻(フェード)に食い込む・前の項目より先、は ❌。`--check` は項目ごとに「絶対秒・表示文字・留めた句の文面」を1行ずつ出す

## 規則(機械検査)

- 表示窓は 45 秒以降に置く(bible 69行: 冒頭45秒は「画面で何が起きているか」を優先)
- 章カード(`card`)・画面内文字(`text`)・`noSub` のカットには置かない
- 行ID・句番号は timing.json に実在すること。窓の from < to

## 画風

紙色(#F4F1E7)の板に墨色(#1B1A17)の手描き風の枠、Yusei Magic。文字は少なく大きく(モバイル42%・TV33%)。
強調は赤(#C6382C)、基準は藍(#37416B)、補助は黄(#E7B23A)。誇張はしない(§? 177行: 数値では誇張しない)。

## 型

- `bars`: 横棒の比較(値の比で伸びる。「何倍」「A時間 vs B時間」「30万頭 vs 2千頭」)
- `grid`: 100 個(または total 個)の粒の並び。`highlight` で「何個中何個」、`segments` で内訳、`mode: "remove"` で減る演出
- `scale`(同日追加): 大きさの実物比較。`size` の比で面積が変わる塊に icon(hand / bottle / pole / human / otter)
- `timeline`(同日追加): 一生のタイムライン。`events[].at / label / pos`。線が伸びたあと目盛りが順に立つ
- `recap`(同日追加): 章の切れ目の「ここまでの請求書」。章カードの直後の行にだけ置ける(検査)。`items[].now` で今回の章の項目を赤

## 同日の追加(仕組み化)

- `figure-planner` エージェントが宣言を書く(工程7で h3-prompt-writer と並列)。`h3:figures --check` が自己検算。`h3:assemble` は figures.json 必須(`--no-figures` で明示的に外す)
- 冒頭45秒の規則は `cuts.json` の `firstWorstLineId` + `check:h3` の B14 で機械化(h3-cut-planner が書く)

## 今後(還元先)

- 図解の宣言を書く役(figure-planner)をエージェント化するか、visual-director の H3 版に組み込むかは /channel-refine で決める
- `h3:preview` にも同じ overlay を通す(未実装)

## 章カードの機械化(2026-09-05 追加)

- 契機: H3 に章カードの文字を描かせると、1コマ目に「ペンを持つ人の手」が湧く(ep026 で2回・ep027 で3回。seed を振っても再発。
  否定形「no hand」は効かない・文字は手を呼ぶ)。章カードは検品の差し戻し理由の常連だった
- 方式: `cuts.json` の `card: [番号, 章名]` から、`h3:figures` が **不透明な紙の板**(`card-<cutId>`、`kind: "card"`)を機械で焼き、
  同じ index に入れる。窓はカットの受け持ち区間(`buildSegments`)そのもの。全コマ同一(1枚撮って複製)。宣言(figures.json)は要らない
- assemble: `kind: "card"` も他の図解と同じ overlay 経路で重ねる。card のカットに card-* が無ければ止める。
  **生成クリップが無い card のカットは紙色(#F4F1E7)の静止映像を lavfi で合成する**ので、章カードは GPU で生成しなくてよい
  (`h3:run -- <ep> <章> --only …` で外す。生成してあっても板が全面を覆うので差は無い)
- 検品: 章カードのカットは目視の対象から外れる(板が覆う)
