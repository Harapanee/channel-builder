---
name: video-create
description: このチャンネルの新規エピソード動画を制作する。「/video-create 織田信長」のように題材を渡す。調査→台本→ファクトチェック→TTS→ストーリーボード→ショット→素材→シーン実装→QA→レビュー→レンダリングの全工程を実行する。
---

# /video-create — エピソード制作パイプライン

仕様書§7に基づく。**開始前に必ず `channel/bible.md` 全文と `.channel-system.json` を読むこと。**
各ステップ完了時に `episodes/<epId>/episode.json` の `status` を更新する(中断・再開の基盤)。

**運用原則(モデル非依存)**: メインセッションの役割は監査・ゲート管理・ユーザー対話である。
台本(script-director)・絵コンテとショット(visual-director)・調査と検証(fact-checker)・
シーン実装(scene-implementer)・レビュー(compliance-reviewer / audience-sim)はすべて
専用エージェントへ委譲し、メインセッション自身が創作物を書かない。
これにより制作の品質はエージェント定義(=システム)が担保し、メインのモデルに依存しない。

## 0-a. 題材の決定(引数なしで呼ばれた場合)

題材が渡されなかったら、ネタ帳から選ぶ:

- `channel/backlog.md` が存在し状態「候補」が3件以上ある場合: 合計点上位5件を採点内訳・候補メモつきで提示し(AskUserQuestion)、選ばれた題材で以降の工程を進める
- 帳が無い、または「候補」が3件未満の場合: `/theme-scout` の実行を提案して停止する

**消し込み(開始)**: 題材が確定したら(引数あり起動で帳に同じ題材が載っている場合も含む)、backlog.md の該当行の状態を「制作中(<epId>)」へ更新する(更新は §0 で epId を確定した後に行う)。

## 0. 準備

- epId は `epNNN-<slug>`(例 ep001-<slug>)。`episodes/<epId>/episode.json` を作成(episodeId / subject / targetDurationSec / status: "researched"の前は無し→調査完了後に設定)
- VOICEVOX起動確認: `curl -s http://127.0.0.1:50021/version`

## 1. 調査 → `research.md`

fact-checkerエージェントに委譲。出典つき・確度(定説/有力/諸説)つきで、「フック候補(視聴者を掴む要素のランキング)」を含めること。→ status: "researched"

## 2. 台本 → `script.md`

**script-directorエージェントへ委譲**(目標尺と題材を渡す。執筆手順・セルフチェックはエージェント定義に内蔵)。
メインセッションはエージェントのセルフチェック報告を監査し、疑義があれば差し戻す。
→ status: "scripted"

## 3. 台本の二重審査(並列で起動できる)

- **fact-checker**(新規起動): script.md + research.md の事実検証
- **script-reviewer**(新規起動・**合否権あり**): 構造・笑い・テンポ・分かりやすさ・bible規則の審査。REVISEの指摘は script-director に差し戻して修正(最大2周。解決しない論点はユーザーへエスカレーション)

両方が通ってから工程4へ進む。**台本段階の修正コストは映像化後の1/10以下** — ここで妥協しない。

## 4. TTS → `narration/` + `timing.json`

- **誤読プリチェック(合成前・高速)**: まず `npm run tts episodes/<epId> -- --readings-only` で読み仮名レポート(narration/readings.md)だけを生成し(VOICEVOX audio_queryのみ・数十秒)、reading-checkerエージェント(合否権あり)で検査する。REVISEなら台本表記を修正して再プリチェック。**PASSしてから** `npm run tts episodes/<epId>` で本合成を1回だけ実行する(本合成はプリチェックと同じaudio_queryの読みで合成するため、表記が変わらない限り合成後の再検査は不要)
- 自己検証エラーが出たら台本表記を調整(読みの揺れ・難読語)
- PASSまで**工程7(素材)以降**へ進まない
- → status: "voiced"

## 5-6. ストーリーボード + ショットプラン → `storyboard.md` / `shots.json`

**visual-directorエージェントへ委譲**(設計手順・多様性の定量規則・検証はエージェント定義に内蔵)。
**二相で起動できる**: Phase A(storyboard.md)は script.md だけで設計できる(開閉時刻は概算と明記させる。visual-director定義に内蔵)→ **台本の二重審査PASS直後から工程4のTTSと並行開始してよい**(概算時刻と実タイミングの差はretime-shotsが吸収)。Phase B(shots.json)は timing.json(実タイミング)確定後に行う。
**流れは「演出が先、素材が後」**: visual-directorは手持ち素材に縛られず演出を設計し、
不足素材リストを storyboard.md に出す → 工程7で充足 → shots.json 確定。
**10分超は章並列**: 全体設計(Phase 1)→章グループ並列(Phase 2)→統合(Phase 3)。Phase 1の分担は**グループ間のショット数が±20%以内**になるよう均す(壁時計は最遅グループに律速される)。共有コンポーネントは1グループが実装オーナー、他はprops契約参照。
メインセッションは 多様性の自己計測表・role分布・不足素材リストの妥当性・validate合格を監査する。
→ status: "storyboarded"

## 7. 素材取得

各ショットの素材を bible §10 の優先順位で調達:

1. library.json の既存素材(assetIdで参照)
2. SVG/コード生成(地図・図形・小物)→ assets/maps/ 等に保存
3. AI画像(キャラ新バリアント・場所): **asset-generatorエージェントへ委譲**(プロンプトの型・身体語彙・失敗→修正表を内蔵。gen-image.tsを生のプロンプトで直接叩かない)。エージェントの成果物(コンタクトシート)を**ユーザーに提示して承認を得る** → library.json 登録(approvedBy: "human")
4. 新人物の正典が必要な場合も asset-generator の型1で候補生成 → ユーザー承認 → canonical.png として保存

全新規素材を library.json に登録(kind/subject/variant/file/source/license/approvedBy)。

## 8. シーン実装

**scene-implementerエージェントへ委譲**(コアprops/カスタム新設の使い分け・三層規則・技術規則はエージェント定義に内蔵。メインセッションが演出コードを書かない — シーン実装は演出の質を最終決定する工程であり、エージェント定義のモデル固定が品質のモデル非依存を担保する)。

- **10分超は章グループ並列で起動してよい**(visual-directorと同じ分担。共有コンポーネントは実装オーナー1グループ、他はprops契約参照)
- メインセッションの監査観点:
  - typecheck / validate の合格報告(出力つき)
  - **ゼロ持ち越し**: shots.json の `custom:` 参照が全て `src/scenes/episodes/<epId>/` 新設であること(registry.tsのimport元パスで確認。過去エピソード由来の場面演出が1件でも混入していたら差し戻し)
  - 新設コンポーネントが storyboard.md の演出意図と数・内容で整合すること
  - **テンプレ量産でないこと**: 単一factory関数の文言差替え変種群は1演出と数える。実効演出数が定量規則を満たさなければ差し戻し
- → status: "implemented"

## 8.5 Studio早期確認(レンダリング前・推奨)

実装完了後、**レンダリングを焼く前に** Remotion Studio でユーザーが確認できる:

```
npx remotion studio src/remotion/Root.tsx --props='{"episodeDir":"episodes/<epId>"}' --port 3400
```

ブラウザ(http://localhost:3400)でスクラブ・再生し、レイアウト・演出の問題をレンダー1周(30〜50分)を消費せずに発見する。音声ミックスの最終確認・QAはレンダー後のmp4で行う(Studioは視覚の早期ゲート)。ユーザーがすぐ確認できない場合はスキップしてレンダーへ進んでよい。

## 9a. スモークQA(必須・レンダー前)

```
npx tsx src/pipeline/qa-smoke.ts episodes/<epId>
```

全ショットを2フレームずつサンプリングし、**ランタイムエラー・静止(フレーム間無変化)・黒(未描画)** をフルレンダーを焼く前に3〜10分で検出する。**NGがゼロになるまで工程9bのフルレンダーに進まない**(フルレンダー後のNG発見→フル焼き直しの往復は1回60〜80分を浪費する)。

修正後の再検証も必ず **スモークQA → (repair or フルレンダー)** の順で行う。

## 9b. プレビュー(フルレンダー)+ Mechanical QA

スモークQA全緑を確認したら、**ユーザーに「今すぐレンダーする」か「夜間キューに積む」かを確認する**(AskUserQuestion)。ユーザー不在(委任モード等)なら即時レンダーでよい。

- **夜間キュー**: `scripts/render-queue.sh add episodes/<epId>` で積むだけ(消化は寝る前に `/render-queue` で開始)。レンダーのCPU占有で日中の作業が止まるのを避けられる
- **即時レンダー**: 必ず **nohup+wait-render.sh の2段運用** で行う:

```
nohup scripts/render-episode.sh episodes/<epId> > episodes/<epId>/out/render-preview.log 2>&1 &   # 本体はnohupで切り離す
scripts/wait-render.sh episodes/<epId>          # ハーネスにはこれ「だけ」を置く(バックグラウンドBash、完了を即時通知)
```

本体をハーネス管理タスクとして走らせてはならない — **ハーネス管理タスクはセッション切替で殺される**。nohupで切り離した本体は生き残り、殺されうるのは監視係(wait-render)だけにする。
(render-episode.sh はスリープ防止・メモリ適応concurrency・自動再挑戦・QA内蔵の恒久スクリプト。remotion renderの直叩きより速く安定)

- render-episode.sh は完了時に `out/.render-status-<out>.json` を書き、wait-render.sh がそれを検知して終了する(完了=ハーネスが即時に通知)
- **長間隔のMonitorポーリングや自前sleepループを一次監視にしない**(完了後の空白待ちが数十分発生した実測がある)。wait-renderが停止された場合は再実行するだけでよい(レンダー本体は独立して生きている)

**QA失敗・修正が特定ショットに限られる場合は、フル再レンダーではなく部分修復を原則とする**(フル再レンダー禁止ではないが、修正範囲が局所ならrepairが2〜3分で済む):

```
npx tsx src/pipeline/repair-render.ts episodes/<epId> <shotId> [--out preview]   # 該当ショットのみ再レンダー+既存mp4へ継ぎ接ぎ
```

qa-report.json が全pass するまで修正(再検証はスモークQA→repair/フルの順)。→ status: "qa_passed"

## 10. LLMレビュー(2系統、いずれも新規コンテキストのエージェント)

- **compliance-reviewer**: bible.md + review-checklist.md + script/storyboard/shots を渡す。PASS/FAIL。FAILは修正して再レビュー
- **audience-sim**: **bible.mdとstoryboard.mdは渡さない**。script.mdの行とshots.jsonのintentを時系列順に開示して疑似初見反応を得る。助言として扱う
- → status: "reviewed"

## 11. 人間レビュー → 最終化

preview.mp4 とレビュー結果をユーザーに提示。フィードバックは「単発修正」と「システム還元(/channel-refine)」に分類して対応。

**最終レンダリング前に必ず `npm run studio` でRemotion Studioを起動し、ブラウザで動画を確認してもらった上でユーザーの明示的な承認を得ること。** 承認が得られるまで以下のfinalレンダリングを実行してはならない。承認後:

```
nohup scripts/render-episode.sh episodes/<epId> final > episodes/<epId>/out/render-final.log 2>&1 &
scripts/wait-render.sh episodes/<epId> final     # ハーネスのバックグラウンドBashで
```

**人間レビューで修正がゼロだった場合は、finalを焼き直さず `scripts/promote-preview.sh episodes/<epId>` でpreview.mp4を無劣化昇格する**(入力の更新なしを機械検査。通常モードでも同一内容の二重レンダーはしない)。

- **委任モード(ユーザーが事前に最終化まで委任した無人進行)**: Studio確認とユーザー承認は事後報告に置き換わる。このとき**同一内容の二重レンダーを禁止**する:
  - preview後に一切の変更が無ければ `scripts/promote-preview.sh episodes/<epId>` で preview.mp4 を final.mp4 へ昇格する(スクリプトが「previewより新しい入力ファイルが無いこと」を機械検査する。QAは同一ビットのpreviewで合格済み)
  - preview後に修正が入った場合は、previewを焼き直さず `scripts/render-episode.sh episodes/<epId> final` でfinalを直接1回レンダーする
  - 通常モード(ユーザー同席)は従来どおり

- `.channel-system.json` の `metrics` に実測値(wallClockHours / imageGenCount / renderMinutes)を追記
- **消し込み(完了)**: `channel/backlog.md` に該当行があれば状態を「済(<epId>)」へ更新
- → status: "final"、git commit

## 12. 公開パッケージ(タイトル・サムネ・概要欄)

final確定後、**publisherエージェントへ委譲**: `publish/PUBLISH.md`(タイトル3案・概要欄)+ `publish/thumbnails.json`(サムネ3案スペック、bible §13)。
サムネイル3枚をレンダリング(専用ツール。軽量バンドル+再試行内蔵。CLIのremotion stillを直接使わない — メモリ逼迫時に不安定):

```
npx tsx src/pipeline/render-thumbs.ts episodes/<epId>
```

タイトルはbible(公開パッケージ節)の規定に従う — 固定型ならそのまま確定、3案方式ならユーザーが1案選定。**サムネは選定不要 — 3枚ともYouTube Studio「テストと比較」へ投入**しABテストする(bibleの公開パッケージ節)。
一言と矢印の配置はコンポジション側で自動補正される(顔帯回避・矢印は一言→胴へ自動接続)。publisherは一言のxPctで左右(<50=左)だけ決めればよい。
