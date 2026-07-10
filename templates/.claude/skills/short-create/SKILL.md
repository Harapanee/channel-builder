---
name: short-create
description: 完成済みエピソードの要素からショート動画(縦型1080x1920)を生成する。「/short-create ep001-xxx rank3-reasons」のように起動(フォーマットが1つなら第2引数省略可、引数なしはエピソード選択から)。台本→承認→TTS→ショット実装→Studio確認→夜間レンダーキュー投入までを実行する。
---

# /short-create — ショート生成パイプライン

**開始前に必ず読む**: `channel/bible.md` 全文、対象フォーマットの契約(`channel/short-formats/<formatId>.json`)と教義(同名.md)。
各工程完了時に `shorts/<shortId>/short.json` の status を更新する(中断・再開の基盤)。

**運用原則**: メインセッションは監査・ゲート管理・ユーザー対話のみ。創作(台本・ショット設計・実装)は short-director エージェントへ委譲する。
**サブエージェントは必ず同期実行**(run_in_background: false)。ヘッドレス実行ではターン終了=プロセス終了のため、バックグラウンド起動で完了を待つ形を禁止する。

**本編との違い(軽量化の根拠)**: 調査・ファクトチェックは本編の research.md(検証済み)を再利用するため行わない。素材は library.json の承認済み素材のみ使うため素材承認も行わない。人間ゲートは「台本承認」と「Studio確認」の2回。

## 0. 準備

- 引数: `<epId> [formatId]`
  - epId 省略時: `episodes/*/episode.json` の status が implemented / qa_passed / reviewed / render_ready / final のものを一覧提示して選択(AskUserQuestion)
  - formatId 省略時: `channel/short-formats/*.json` が1つならそれを使う。複数なら選択。**0件なら /short-builder を案内して停止**
- VOICEVOX起動確認: `curl -s http://127.0.0.1:50021/version`
- shortId 採番: `shorts/` 直下の既存 `shNNN-*` の最大NNN+1(なければ001)。slugは題材の英小文字(例 sh001-mola-top3)。`shorts/<shortId>/` を作成
- **素材棚卸し**: `assets/library.json` から sourceEpisode 関連(subject一致・approvedBy: "human")の素材を列挙する(short-director への入力)

## 1. 台本(short-director フェーズ1)

- short-director に渡す: epId / shortId / formatId、素材棚卸しリスト、直近ショートの script.md の場所(あれば)
- 出力: `shorts/<shortId>/script.md`(§5.4形式)
- エージェントのセルフチェック報告(尺概算±10%・セグメント充足・事実の出所)を監査し、疑義があれば差し戻す
- `short.json` を作成(shortId / formatId / sourceEpisodeId / title / status: "scripted")

## 2. 人間ゲート1: 台本承認

- 台本全文+使用予定素材(assetId一覧)を提示する
- 修正指示は short-director に差し戻して反映(最大2周。解決しない論点はエスカレーション)
- 承認で status: "script_approved"

## 3. TTS

- 誤読プリチェック: `npm run tts shorts/<shortId> -- --readings-only` → reading-checker エージェント(合否権あり)。PASSまで本合成しない
- 本合成: `npm run tts shorts/<shortId>`
- **実測尺検査**: `timing.json` の totalDurationSec がフォーマットの targetDurationSec ±10% に収まること。外れたら short-director に圧縮/増量を差し戻して再TTS(最大2周)
- status: "voiced"

## 4. ショット+実装(short-director フェーズ2)

- timing.json 確定後に起動。出力: `shorts/<shortId>/shots.json`(resolution 1080×1920 / fps 30)
- custom シーンが必要な場合は `src/scenes/shorts/<shortId>/` に実装し registry.ts の customRegistry へ登録される
- **素材は library.json 登録済みのみ**。short-director が不足素材を報告したら停止し、「本編側で素材を追加してから再実行」を案内する(ショート工程内でAI画像生成しない)
- 監査点: validate合格ログ / RankCard位置 / 最終ショットの creditNotice / セーフエリア
- status: "implemented"

## 5. 人間ゲート2: Studio確認

- 起動コマンドを提示:
  `npx remotion studio src/remotion/Root.tsx --props='{"episodeDir":"shorts/<shortId>"}' --port 3400`
- ブラウザ(http://localhost:3400)で「Short」コンポジションを選んで確認するよう案内する
- NG項目は該当工程(台本 or ショット)へ差し戻し
- 承認で status: "studio_checked"

## 6. 夜間レンダーキュー投入

- factory-ui 起動確認: `curl -s http://127.0.0.1:4700/api/render-queue`
- 投入(dir は `basename $(pwd)` = チャンネルフォルダ名):

```

curl -s -X POST http://127.0.0.1:4700/api/render-queue/enqueue \
-H 'Content-Type: application/json' \
-d '{"dir":"<チャンネルフォルダ名>","epId":"<shortId>","kind":"short"}'

```

- 201(JSONにid)を確認して status: "queued"。「夜間レンダー開始はfactory-uiのレンダーキューパネルのボタンから」と案内する
- factory-ui が起動していない場合の代替: `scripts/render-episode.sh shorts/<shortId> final` を案内(この場合レンダー成功後に status: "rendered" を手動更新)
- キュー経由の場合、レンダー+QA成功時はサーバーが status: "rendered" 更新と git commit を行う
