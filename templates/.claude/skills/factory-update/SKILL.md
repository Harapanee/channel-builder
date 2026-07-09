---
name: factory-update
description: この既存Factory(チャンネル)に、channel-builderテンプレートの最新の工場OS(パイプライン・エージェント定義・スキル・共有コンポーネント・契約)を取り込む。別チャンネルで行われた /system-refine の改善を、このチャンネルへ反映するときに使う。チャンネルの人格(bible/voice/素材/エピソード)には一切触れない。
---

# /factory-update — テンプレートから工場OSを取り込む

/system-refine の対(逆方向)。system-refine = Factory→テンプレート(改善の還元)、**factory-update = テンプレート→この既存Factory(改善の受領)**。

## 手順

1. **クリーンな状態を作る**: `git status` を確認し、未コミットの変更があれば先にコミット(更新の差分を見分けるため必須)
2. **チェッカー自体を最新化してから診断**:
   ```
   cp ~/.claude/skills/channel-builder/templates/scripts/check-template-sync.mjs scripts/
   node scripts/check-template-sync.mjs
   ```
   NG一覧が「テンプレートとこのFactoryの差分」(方向は問わない)
3. **ローカル改変の検出(重要・先にやる)**: 差分のあるIDENTICALファイルについて `git log --oneline -3 -- <file>` を確認。**このFactory側で意図的に改善していた場合は上書きしない** — それは /system-refine でテンプレートへ還元すべき改善である(還元→他Factoryが受領、の一方向フローを守る)。還元してから改めて本スキルを実行する
4. **IDENTICAL区分を取り込む**(テンプレートが正): チェッカーのIDENTICALリストの各ファイルを テンプレート→Factory へコピー。**Factory側に無い新ファイル**(新エージェント・新スキル・新共有コンポーネント・新スキーマ)もリストに従いコピーする
   - **コピー直後に必ず `git diff` を全件レビューする**(手順1のコミットが基準点)。差分の中に「このFactory固有の改善の消失」が見えたら、該当ファイルを `git checkout -- <file>` で即戻し、手順3(還元が先)へ回す。**diffレビューを終えるまで次の手順へ進まない** — これが channel-refine の蓄積を上書き事故から守る最後の防壁である
5. **VARIANT区分は差分を読んで同等編集**: bible-template・video-create SKILL等はコピーせず、テンプレート側の変更点(git履歴かdiff)を読み、このチャンネルの固有内容(チャンネル名・話者・素材)を保ったまま同等の編集を適用する。bibleの「不変規則」ブロックはそのまま反映してよい
6. **依存とレジストリ**: package.json が変わったら `npm install`。新共有コンポーネントは src/scenes/registry.ts に登録(import+エントリ)
7. **検証**: `npm run typecheck` / 既存エピソード1本の `npm run validate` / `node scripts/check-template-sync.mjs`(IDENTICALが全緑になること。VARIANTの禁止語NGが出たら固有文字列の持ち込みなので手順5をやり直す)
8. **記録**: CHANGELOG.md に「factory-update: 取り込んだ改善の要約」を追記して git commit

## 触ってはいけないもの(チャンネルの人格)

`channel/bible.md`(§の不変規則の追記を除く)/ `channel/voice.json` / `assets/`(素材・library.json)/ `episodes/` / `.channel-system.json` / `.env`

## 原則

- **一方向フロー**: 改善は必ず「どこかのFactory → /system-refine → テンプレート → /factory-update → 他のFactory」と流れる。Factory同士で直接コピーしない(テンプレートが唯一の合流点)
- 更新後に最初の1本を作るとき、新機能(新エージェント・新ゲート)が効いているかを意識して観察する
