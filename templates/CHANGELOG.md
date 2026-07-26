# Channel System 変更履歴

/channel-refine による承認済みシステム変更の記録。各変更は「契機 → 変更 → 期待効果」で記録し、効かなかった変更はこの記録を根拠に巻き戻す。

<!-- 記入形式(/channel-refine が追記する):

## YYYY-MM-DD
- 契機: <フィードバック原文の要約>
- 変更: <ファイルとセクション、変更内容の要約>
- 期待効果: <次エピソードで観測されるはずの変化>

まだ変更はない。Pilot 承認までは systemVersion 0.1.0 / status: building。 -->

## 2026-07-26 — 配布ミラーの孤児ファイル精査とテスト配線

- `npm test`(`tsx --test`)を新設し、テンプレートで初めて単体テストが走るようにした
- 配布ミラー(`6c4d0f2` 2026-07-20 で凍結)にのみ存在した孤児13ファイルを精査し、引き上げたのは2本のみ:
  - `src/motion/index.test.ts` — 正本の `src/motion/index.ts`(`kenBurns` / `wipeIn`)を検査する有効なテスト
  - `channel/visual-rules.example.json` — 後継を持たない設定雛形
- 引き上げなかったもの(正本 `1d67616` 2026-07-21 で後継に置き換わっている、または参照ゼロ):
  - `src/pipeline/visual-source-lint.ts` + テスト — 後継は `qa-smoke.ts` の style.ts 駆動の図解文字下限検査
  - `src/pipeline/component-contracts.ts` + テスト — 後継は `validate-shots.ts` Rule 10 のprops形状検査
  - `src/scenes/core/format-number.ts` + テスト — テンプレにも全8chにも参照ゼロの死んだコード
  - `src/pipeline/visual-rules.test.ts` — import先の関数が正本の `validate-shots.ts` に存在しない
- style-pack `regional-map` / `stage-layout` は全7ch(動物転生/人物転生/世界史の裏路地/zunda-trend/zunda-datagaku/mijika-nippon/kinshoko)で未使用のため引き上げず破棄した
- `package.json` の `scripts.test` は `tsx --test src/**/*.test.ts`(無引用)だとnpmが起動するsh経由のglob展開が1階層しか辿らず2階層下のテストを取りこぼすため、`tsx --test "src/**/*.test.ts"`(引用符付き)に調整した。引用符で囲むとNode組み込みテストランナー自身がglobを再帰展開し、全テストファイルを検出できることを確認済み

> **修正履歴(fix round 1, 同日中):** 当初は上記精査前に孤児8ファイルを一括で正本へ引き上げてコミットしていたが、配布ミラーが `6c4d0f2`(2026-07-20)で凍結済みで正本 `1d67616`(2026-07-21)が後継実装で置き換え済みだったことが判明したため、引き上げ対象を2本のみに縮小して修正した。詳細は `task-1-report.md` の「fix round 1」節を参照。

## 2026-07-13 system-refine: サムネのAI生成1枚絵方式(image契約)+publisher中立化(全チャンネル適用)
- 変更: Thumbnail.tsx参照実装にimageバリアント(旧contract後方互換)/ publisher.mdの旧構造焼き込みを除去しbible §13へ委譲 / asset-generator型5(サムネ場面)/ bible-template §13雛形とvideo-create SKILL更新
- 期待効果: サムネ構造が完全にbible §13の教義になり、チャンネルごとにAI生成/素材構成を選べる

## 2026-07-13 system-refine: サムネCTR原則の組み込み(全チャンネル適用)

- 契機: クリックされやすいサムネの実証リサーチ(deep-research、査読付き研究3本+公式ヘルプ検証)
- 変更: docs/thumbnail-principles.md(知見文書)新設 / publisher.mdにCTR原則とセルフチェック追加 /
  render-thumbsに計測レポート(thumb-metrics.json)・解像度ハード検査(1280x720)・モバイルプレビュー追加 /
  契約 src/schemas/thumb-metrics.schema.json 新設
- 期待効果: 表情誇張×感情中立の一言でクリックと視聴時間の両立。Test & Compare勝敗×計測値の蓄積で
  チャンネル別の実測閾値を将来導出できるデータ基盤
- ドキュメント影響: CLAUDE.md(Key commands)/ README.md(エージェント一覧・コマンド早見表)更新済み
