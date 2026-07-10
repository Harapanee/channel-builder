---
name: video-create
description: このチャンネルの新規エピソード動画を制作する。「/video-create 織田信長」のように題材を渡す。調査→台本→ファクトチェック→TTS→ストーリーボード→ショット→素材→シーン実装→検査→レビュー→公開パッケージ→承認までを実行する(レンダーは承認後に夜間キューでサーバーが実行)。
---

# /video-create — エピソード制作パイプライン

仕様書§7に基づく。**開始前に必ず `channel/bible.md` 全文と `.channel-system.json` を読むこと。**
各ステップ完了時に `episodes/<epId>/episode.json` の `status` を更新する(中断・再開の基盤)。

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

ブラウザ(http://localhost:3400)でスクラブ・再生し、レイアウト・演出の問題をレンダー1周(30〜50分)を消費せずに発見する。音声ミックスの最終確認・QAはレンダー後のmp4で行う(Studioは視覚の早期ゲート)。ユーザーがすぐ確認できない場合はスキップして次工程(検査)へ進んでよい。

## 9. レンダー前検査(日中・機械ゲートの前倒し)

夜間レンダーを一発で通すため、render-episode.sh 内の機械ゲートを日中に前倒しで実行する
(夜のスクリプト内でも同じゲートが二重に走る=安全側):

- `npx tsc --noEmit`
- `npm run validate episodes/<epId>`
- `grep -rnw 'Infinity' src/scenes/episodes/<epId>` → ヒット0であること(Infinityゲートの前倒し。ヒットしたら修正)
- `npx tsx src/pipeline/qa-smoke.ts episodes/<epId>` → **NGゼロになるまで修正**(全ショット2フレームサンプリングでランタイムエラー・静止・黒を検出。夜のレンダー失敗の主因をここで潰す)

全て緑になったら → status: "prechecked"

## 10. LLMレビュー(2系統、いずれも新規コンテキストのエージェント)

いずれも mp4 非依存(レンダー前で成立する):

- **compliance-reviewer**: bible.md + review-checklist.md + script/storyboard/shots を渡す。PASS/FAIL。FAILは修正して再レビュー(修正したら工程9の検査から再確認)
- **audience-sim**: **bible.mdとstoryboard.mdは渡さない**。script.mdの行とshots.jsonのintentを時系列順に開示して疑似初見反応を得る。助言として扱う
- → status: "reviewed"

## 11. 公開パッケージ(タイトル・サムネ・概要欄 — finalレンダー前に作る)

**publisherエージェントへ委譲**: `publish/PUBLISH.md`(タイトル3案・概要欄)+ `publish/thumbnails.json`(サムネ3案スペック、bible §13)。
サムネイル3枚をレンダリング(静止画で軽負荷。軽量バンドル+再試行内蔵。CLIのremotion stillを直接使わない — メモリ逼迫時に不安定):

```
npx tsx src/pipeline/render-thumbs.ts episodes/<epId>
```

タイトルはbible(公開パッケージ節)の規定に従う — 固定型ならそのまま確定、3案方式ならユーザーが1案選定。**サムネは選定不要 — 3枚とも朝のアップロード時にYouTube Studio「テストと比較」へ投入**しABテストする(bibleの公開パッケージ節)。
一言と矢印の配置はコンポジション側で自動補正される(顔帯回避・矢印は一言→胴へ自動接続)。publisherは一言のxPctで左右(<50=左)だけ決めればよい。
→ status: "packaged"

## 12. 人間レビュー(一括)→ 承認 → 夜間レンダーキューへ

動画・サムネ・タイトル・概要欄を**まとめて**確認してもらう。**レンダーはここでは実行しない**(夜にサーバーが焼く):

1. `npx remotion studio src/remotion/Root.tsx --props='{"episodeDir":"episodes/<epId>"}' --port 3400` を起動し、動画本編を確認してもらう
2. サムネ3枚・タイトル・概要欄(publish/)をあわせて提示する
3. フィードバックは「単発修正」と「システム還元(/channel-refine)」に分類して対応。修正したら工程9(検査)から再確認して再提示
4. 承認を求める — ヘッドレス実行(Factory UI)では規約どおり `kind:"render-check"` のゲートを発行して停止する。対話セッションでは AskUserQuestion で承認を得る

**承認後の完了処理(このジョブの終点。レンダーはしない):**

- episode.json の status を "render_ready" へ更新
- `.channel-system.json` の `metrics` にエントリ追加(wallClockHours / imageGenCount を実測で記入。**renderMinutes は null** — 夜のレンダー完了時にサーバーが追記する)
- **消し込み**: `channel/backlog.md` に該当行があれば状態を「済(<epId>)」へ更新
- git commit(内容は承認時点で確定するため)
- キュー登録の確認: Factory UI 経由(ヘッドレス)ならゲート承認時にサーバーが自動登録済み。**対話セッションの場合のみ** `curl -s -X POST http://127.0.0.1:4700/api/render-queue/enqueue -H 'Content-Type: application/json' -d '{"dir":"<チャンネルフォルダ名>","epId":"<epId>"}'` で登録する(サーバー未起動で失敗したら、Factory UI のエピソード詳細から「夜間レンダーキューへ」を押すようユーザーへ案内)
- ここで `<done>` を出して終了する。**status "final" は夜のレンダー成功時にサーバーが書く**(このジョブでは書かない)

**委任モード(auto)**: 目視確認は承認済みとして進めてよい(ゲートは発行しない)。上記の完了処理を行って終了すれば、サーバーがジョブ成功を検知して自動でキュー登録する。**即時レンダーはしない**(promote-preview による昇格も不要 — preview 自体を焼かないため)。

## 夜間レンダー(サーバー実行 — このスキルの工程外)

寝る前に Factory UI の「夜間レンダー開始」を押すと、サーバーが承認済み(render_ready)エピソードを全チャンネル横断・1本ずつ `scripts/render-episode.sh episodes/<epId> final` で直列レンダーする(Infinityゲート・Mechanical QA・caffeinate・自動再挑戦は同スクリプトに内蔵)。成功時はサーバーが機械的に episode.json `status: "final"`・metrics の renderMinutes・git commit を行う。

QA落ち・レンダー失敗は朝の Factory UI に赤表示される → 日中に通常ジョブ(途中再開)で修正 → 工程9(検査)から再確認 → 再承認 or UIの「再キュー」で再投入。

## 13. 朝: 確認・アップロード(手動)

Factory UI でQA結果と final.mp4 を確認し、YouTube Studio へ手動アップロードする。サムネ3枚は「テストと比較」へ投入しABテストする。
