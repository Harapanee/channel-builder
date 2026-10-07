---
name: studio-finish
description: アップロード済み(非公開+予約)のエピソードを YouTube Studio で仕上げる — サムネ3枚の A/B テスト・収益化オン・メンバー先行公開・終了画面。Claude in Chrome で操作し、設定を読み直して publish/studio-result.json に書く。「/studio-finish <epId>」で起動。video-create 工程12で youtube:publish と finalize の後に呼ばれる。
---

# studio-finish — Studio 仕上げ

YouTube Data API で設定できない4項目を、Claude in Chrome(ログイン済みの普段の Chrome)で Studio を操作して設定する。画面の細部(ボタンの場所・つまずき)は `references/studio-ui.md` に書いてある。**操作の前に必ず読む。**

## 入力

`episodes/<epId>/publish/` の次のファイル:

- `upload-result.json` — `videoId`(無ければ止める。先に `npm run youtube:publish -- <epId> --auto-slot`)
- `thumbnails.json` — A/B テストに入れる3枚(`variants[].image` の順に1〜3枠)
- `metadata.json` — `publishAt`(公開日時)と `memberEarlyAccess`(あればメンバー先行)
- `studio-result.json` — 前回の結果。`done` の項目は飛ばす(二重に設定しない)

## 手順

0. **Chrome の確認**: `tabs_context_mcp` が失敗する(Chrome 未接続・夜間)なら、4項目すべてを `pending`(evidence「Chrome 未接続」)で `studio-result.json` に書き、HANDOFF に「`/studio-finish <epId>` が残っている」と書いて終える。予約公開は API で済んでいるので、公開は止まらない
1. **A/B テスト(thumbTest)**: 詳細ページ → タイトル下「A/B テスト」→「サムネイルのみ」→ 3枠に thumbnails.json の順で入れる →「テストを設定」→ ページの「保存」
2. **収益化(monetization)**: 左メニュー「収益化」→ オフならオン →「次へ」→ 自己評価は**ページ下部の「上記のいずれも含まない」1つだけにチェック**して送信 → ページの「保存」
3. **メンバー先行(memberEarlyAccess)**: `metadata.json` に `memberEarlyAccess` が無ければ `skipped`(evidence に理由)。あれば公開設定 →「メンバー限定から公開にする」→ **公開切替の日時を metadata の publishAt に合わせ直す**(選んだ瞬間に 0:00 へ戻る)→「完了」→「保存」
4. **終了画面(endScreen)**: 「終了画面」→ テンプレート「2本の動画」→ 要素1=**視聴者に適したコンテンツ**・要素2=**最新のアップロード** →「保存」(既定。チャンネルの方針が違うならここを書き換える)
5. **読み直し**: 各項目を保存したら、ページを開き直して状態を読む。読んだ画面の文言を evidence に書く。読み直しで確かめられなければ `failed`
6. **記録**: `publish/studio-result.json` を書き(形は `src/schemas/studio-result.schema.json`)、`npm run check:studio episodes/<epId>` が exit 0 になること。チャンネルリポジトリへ `studio-result.json` だけをパス指定でコミットする

## 判断の基準

- 自己評価の回答は**チャンネルの方針で固定する**(既定は全項目「含まない」。導入時に人間が決め、ここを書き換える)。送信後は変更できない
- 公開まで `memberEarlyAccess.hours` を切っている回は、youtube:publish の `--auto-slot` がメンバー先行と概要欄の案内行をすでに外している。metadata に無ければ `skipped` でよい
- A/B テストが「対象外: 動画が公開になっていない」と出るのは正常(公開で始まる)。テストが登録されている証拠は、A/B テストを開き直すと「現在のテストは削除されます」と出るか「テスト実行中」のレポートが出ること

## やってはいけないこと

- 公開日時・公開範囲(メンバー先行以外)・タイトル・概要欄・タグの変更。他の動画の操作
- 自己評価をチャンネルの方針以外の回答で送信すること
- 読み直していない項目を `done` と書くこと
