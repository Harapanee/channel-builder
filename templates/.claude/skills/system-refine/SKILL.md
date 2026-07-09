---
name: system-refine
description: 工場OS層(video-createパイプライン・エージェント定義・パイプラインツール・スキーマ・共有コンポーネント)を変更し、channel-builderテンプレートへ同期して「次に作る全チャンネル」に反映する。チャンネル固有の教義(bible等)の変更は /channel-refine を使う — 本スキルは全チャンネル共通の仕組みの変更専用。
---

# /system-refine — 工場OSの改善と全チャンネル反映

## 使い分け(最初に必ず分類)

| 変更対象 | 使うスキル |
|---|---|
| bible.md / review-checklist / このチャンネルの見た目・音・素材方針 | `/channel-refine` |
| **video-create等のスキル手順 / エージェント定義 / src/pipeline のツール / スキーマ契約 / 共有コンポーネント(shared/)/ hooks** | **このスキル** |
| 両方に跨がる(例: 新工程の追加=スキル改定+bible規則) | 両方を順に(channel-refine → system-refine) |

## 手順

1. **変更をSRC(現在のFactoryリポジトリ)に適用する**
   - 保護対象(bible/voice/コア)に触れる場合は `/channel-refine` のマーカー手順に従う
   - スキーマ(契約)の変更は後方互換を原則とする(optionalフィールド追加は可、既存フィールドの意味変更・削除は既存エピソードの検証を通してから)
2. **検証**: `npm run typecheck` / 影響するエピソードの `npm run validate` / ツール変更なら該当ツールの実行テスト
3. **ドキュメント同期(必須)**: 変更がユーザーから見える挙動(スキル・コマンド・エージェント・契約)を追加・変更した場合、(a) `README.md` の該当節(パイプライン図/ファイルの地図/エージェント一覧/コマンド早見表)を更新し、(b) `CLAUDE.md` の Key commands / Skills / Agents 節を更新する。**ドキュメント更新のない system-refine の完了宣言を禁止する**(ユーザー可視の変更が無い場合は「ドキュメント影響なし」と CHANGELOG に明記)
4. **references更新**: 変更が channel-builder の手順に影響する場合(工程の追加・削除)、`~/.claude/skills/channel-builder/SKILL.md` と references/ も同時に更新する
5. **テンプレートへ同期**(`~/.claude/skills/channel-builder/templates/`):
   - **IDENTICAL区分のファイル**(パイプライン・スキーマ・共有コンポーネント・README.md等): SRCからそのままコピー
   - **VARIANT区分のファイル**(video-create/channel-refine SKILL.md・エージェント定義の一部): テンプレ側は汎用化版なので**上書きコピーせず**、同等の編集をテンプレ版に適用する。チャンネル固有文字列(話者名・人物名・チャンネル名)を持ち込まない
   - **新ファイルを追加した場合**: `scripts/check-template-sync.mjs` のマニフェスト(IDENTICAL/VARIANTリスト)にも追加する
6. **channel-builderへ反映**: `~/.claude/skills/channel-builder` は独立したgitリポジトリ(GitHub private)。手順3-5でこのディレクトリに加えた変更をコミットしてpushする:
   ```
   cd ~/.claude/skills/channel-builder
   git add -A
   git commit -m "sync: <変更概要>"
   git push
   ```
7. **同期チェッカーで機械検証**: `node scripts/check-template-sync.mjs` が**全緑になるまで**終わらない。テンプレ内容の一致だけでなく、channel-builderのコミット漏れ・push漏れも検証する(手順6を飛ばすとここで失敗する)。コード変更時はテンプレのコンパイル確認も推奨(スモーク環境で `tsc --noEmit`)
8. **記録**: CHANGELOG.md に「契機 / 変更 / 期待効果」+ **「全チャンネル適用」の明記**。git commit

## 原則

- **テンプレートが真実**: 次のチャンネルはテンプレートから生まれる。SRCだけ直してテンプレを忘れると、改善は「このチャンネル限り」で消える(=このスキルが存在する理由)
- **既存チャンネルへの伝播は /factory-update**: テンプレ更新は「次に作るチャンネル」に自動反映される。既存の他チャンネルFactoryでは、そのFactory内で `/factory-update` を実行して取り込む(改善は必ず Factory → system-refine → テンプレート → factory-update → 他Factory の一方向で流す)
- **汎用化の検査はチェッカーに任せる**: 「固有文字列が入っていないか」を目視で判断しない。禁止語リスト(check-template-sync.mjs)に不足があればリスト自体を増やす
- **channel-builderのGitHub反映もチェッカーに任せる**: 手順6のpushを忘れても手順7が検出する。目視での「pushしたはず」判断に頼らない
- 変更が大きい場合(工程の追加・エージェント新設)は、適用前にユーザーへ変更提案(diff+期待効果)を提示して承認を得る
