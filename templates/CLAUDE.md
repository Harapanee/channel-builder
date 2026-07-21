# Project identity

このリポジトリは「{{CHANNEL_NAME}}」専用のYouTube動画制作システム(Channel Video Factory)である。汎用動画ツールではない。全ての制作判断はこのチャンネルの人格に従う。

# Source of truth

- `channel/bible.md` — チャンネル教義(人格・文法・画風・音)の唯一の定義。全工程がここを参照する
- `channel/voice.json` — ナレーション音声の定義(話者・話速・creditNotice)。**変更禁止**
- `DESIGN.md` — 映像の見た目トークン(配色・書体・線)の具体値。bible §8 の教義を実装値へ落とした契約で、`src/scenes/style.ts` はこれを実装する。変更は design-forge の手順(`validate_design.py` を通す)+ `/channel-refine`
- `channel/review-checklist.md` — レビュアーの検査観点
- `src/schemas/` — 全データ契約(shots/timing/library/episode)のJSON Schema
- `channel/episode-ledger.json` — 全話台帳(題材・アーク・署名・モチーフ。マンネリ検出の機械可読契約)
- 仕様書: `docs/spec-v1.1.md`(設計判断の根拠)

# Mandatory rules

- 台本・映像・素材の創作判断は必ず `channel/bible.md` に従う。迷ったらbibleを読み直す
- 契約(コードが読むJSON)と教義(LLMが読む散文)を混同しない。契約に機械検証できない値を書かない
- 素材は `assets/library.json` に登録済み(approvedBy: "human")のもののみショットから参照する
- 新規キャラクター素材は必ず参照画像方式: 正典(canonical)を `--ref` に渡して生成 → `remove-bg.ts` → 人間キュレーション → library登録
- AI画像の生成はメインセッションで直接行わず、必ず asset-generator エージェント経由で行う(テンプレ逐語使用と塗り検査を確実にするため)
- 音声素材は `assets/audio/LICENSES.md` に記録のあるもののみ使用
- 再発し得る問題は個別エピソードで直さず `/channel-refine` でシステムへ還元する
- `.channel-system.json` の status が "approved" のとき、bible.md / voice.json / src/scenes/core/ を直接変更しない(hooksがブロックする)
- **エンディングに `channel/voice.json` の `creditNotice` の文言によるクレジット表記を必ず入れる**(音声プロバイダの利用規約上の義務)

# Key commands

- `npm run tts episodes/<epId>` — 台本→音声+timing.json(自己検証・ラウドネス正規化つき。最終行に pause_after_sec を明示するとその秒数の無音尾が付く=アウトロ尺の確保用)
- `npm run tts episodes/<epId> -- --readings-only` — 誤読プリチェック(audio_queryのみ・数十秒。合成前にreading-checkerへ)
- `npm run validate episodes/<epId>` — shots.json契約検証(shotId一意性・bgmTracks含む)
- `npx tsx src/pipeline/gen-image.ts ...` — AI画像生成(**直接叩かずasset-generatorエージェント経由**。codex CLI主経路+evolinkフォールバック、`--provider codex|evolink`で強制可)
- `npx tsx src/pipeline/remove-bg.ts <in> <out>` — 背景除去(緑=クロマキー/白=flood-fill自動判別)
- `npx tsx src/pipeline/qa.ts episodes/<epId>` — Mechanical QA(7項目)
- `npx tsx src/pipeline/precheck.ts episodes/<epId>` — レンダー前検査4ゲート(tsc/validate/Infinity/qa-smoke)の一括実行+入力ハッシュ記録(**入力未変更なら数秒でSKIP** — 工程9・再確認はこれを使い個別ゲートを手で焼き直さない。強制再実行は `--force`)
- `npx tsx src/pipeline/qa-smoke.ts episodes/<epId>` — レンダー前スモークQA(全ショット2フレームサンプリングでランタイムエラー・静止・黒を3〜10分検出。**NGゼロまでフルレンダー禁止**。通常はprecheck経由で走る)
- `npx tsx src/pipeline/render-stills.ts episodes/<epId> --shots <id,..> [--at 秒,..]` — 指定ショット中央フレームの静止画一括レンダー(レビューの視覚検証用。**レビュー目的のフルレンダーは禁止** — こちらで代替)
- `npx tsx src/pipeline/repair-render.ts episodes/<epId> <shotId> [--out preview]` — 部分再レンダー+継ぎ接ぎ(1ショット修正を2〜3分に。局所修正はフル再レンダーよりこちらが原則)
- `npx tsx src/pipeline/retime-shots.ts episodes/<epId>` — 台本改訂後のショット追従
- `npx tsx src/pipeline/render-thumbs.ts episodes/<epId>` — サムネ3枚+計測(thumb-metrics.json)+モバイルプレビュー(CLIのremotion still直叩き禁止。720p未満はexit 1)
- `scripts/render-episode.sh episodes/<epId> [out名]` — レンダリング(Infinityゲート・QA・状態書き出し内蔵。remotion render直叩きより優先)
- `npm run tts shorts/<shortId>` — ショート台本→音声+timing.json(本編と同じTTSパイプライン)
- `npm run validate shorts/<shortId>` — ショートshots.json契約検証
- `npm run validate:short-format channel/short-formats/<formatId>.json` — ショートフォーマット契約検証
- `npm run validate:metadata episodes/<epId>` — publish/metadata.json(YouTube公開メタデータ契約)検証(YPP対策のAI開示・制作工程明記・公開予約を含む)。factory-uiのアップロードが読む
- `npm run validate:ledger` — 全話台帳(channel/episode-ledger.json)の契約検証
- `npm run render:test:short` — 縦型スモークレンダー(shorts/sh000-test)
- `scripts/render-episode.sh shorts/<shortId> [out名]` — ショートレンダー(shorts/はShortコンポジション自動選択)
- `scripts/wait-render.sh episodes/<epId> [out名]` — レンダー完了待ち(nohup本体+これをバックグラウンドBashで=完了即時通知)
- `scripts/promote-preview.sh episodes/<epId>` — 委任モードでpreview→final昇格(入力の更新なしを機械検査)
- `scripts/render-queue.sh add <episodeDir> [out]` / `run` / `list` / `clear` — 夜間レンダーキュー(runはnohupランナー切り離しで順次消化。消化開始は `/render-queue` から)
- `node scripts/check-template-sync.mjs` — channel-builderテンプレート同期の機械検証
- VOICEVOXエンジンが http://127.0.0.1:50021 で起動している必要がある

# Skills

- `/video-create <題材>` — 新規エピソード制作(パイプライン全工程。台本はscript-director+二重審査、10分超は章並列)。引数なし起動でネタ帳(channel/backlog.md)の上位候補から選択
- `/theme-scout` — ネタ帳の補充・再採点(題材候補の採点はtheme-scoutエージェント)
- `/render-queue` — 溜まったレンダリングジョブを夜間にまとめて消化(寝る前に起動。`/render-queue add <episodeDir>` で積むだけも可)
- `/channel-refine <フィードバック>` — このチャンネルの教義への還元(人間承認+マーカー手順)
- `/system-refine` — 全チャンネル共通の工場OS(スキル・エージェント・ツール・契約)の変更+テンプレート同期
- `/short-builder` — ショートフォーマット(構造の型)の登録・改修
- `/short-create <epId> [formatId]` — 完成エピソードからショート動画を生成(台本承認→TTS→実装→Studio確認→夜間キュー)

# Agents(制作の実働。メインセッションは監査・ゲート管理のみ)

fact-checker / script-director / **script-reviewer(台本合否)** / reading-checker(誤読検査) / visual-director / scene-implementer(シーン実装) / asset-generator / compliance-reviewer(準拠合否) / audience-sim / theme-scout(題材採点) / publisher / short-director(ショート台本+ショット)

# ショート動画の運用注記

- 台本行に `- subtitle: off` を付けると、画面文字と重複するその行の字幕を非表示にできる(縦型の字幕は自動で大きく中央やや下に表示される)
- `channel/short-formats/<formatId>.json` にトップレベル `speech: { speedScale, pauseLengthScale }` を追加すると、そのフォーマットのショートだけ本編と異なる話速・句読点ポーズにできる(未指定時は `channel/voice.json` 準拠)

# チャンネル署名(全動画共通)

- 冒頭はトラック転生オープニング(you-modern+TruckIsekai、bible §4)
- 地名の初出はJapanMapで位置を示す(bible §8)
- サムネの構造はbible §13の規定に従う(方式=AI生成1枚絵/既存素材の部品構成はチャンネルごとに選択)
