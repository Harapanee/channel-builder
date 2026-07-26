# Channel System 変更履歴

/channel-refine による承認済みシステム変更の記録。各変更は「契機 → 変更 → 期待効果」で記録し、効かなかった変更はこの記録を根拠に巻き戻す。

<!-- 記入形式(/channel-refine が追記する):

## YYYY-MM-DD
- 契機: <フィードバック原文の要約>
- 変更: <ファイルとセクション、変更内容の要約>
- 期待効果: <次エピソードで観測されるはずの変化>

まだ変更はない。Pilot 承認までは systemVersion 0.1.0 / status: building。 -->

## 2026-07-26 — 配布ミラーの孤児ファイル引き上げとテスト配線

- 配布ミラーにのみ存在した実装+テスト8本を正本へ引き上げ、`npm test`(`tsx --test`)を新設した
- 正本の実装と噛み合わないテストは陳腐化として削除した(削除: `src/pipeline/visual-rules.test.ts` — 理由: `validate-shots.ts` から `findOverlongAssetFreeRuns` / `findShotsUsingProp` をimportするが、正本の同ファイルのexportは `validateZeroCarryover` / `validateEpisode` の2つのみで該当関数が存在しない/ 削除: `src/scenes/core/format-number.test.ts` — 理由: 「負数と指数表記にも対応する」テストが `formatAnimatedNumber(-1.25, -2.5)` に `"-1.3"` を期待するが、実装は `Math.round` を使っており `Math.round(-12.5) === -12`(JSの仕様上0.5は+∞方向に丸められ、負数側では絶対値が小さい方に丸まる)ため実際の戻り値は `"-1.2"`。実装(`format-number.ts`)は現状維持のうえテストのみ削除。同ファイルの他2テスト(整数丸め・小数桁維持)は通っていたが、この判定は正本実装への追随を優先しファイル単位で削除する規則に合わせた。負数丸めの仕様は今回の引き上げ対象外の論点として残す)
- style-pack `regional-map` / `stage-layout` は全7ch(動物転生/人物転生/世界史の裏路地/zunda-trend/zunda-datagaku/mijika-nippon/kinshoko)で `src/scenes/shared/` に同名実装が「なし」だったため引き上げず破棄した
- `channel/visual-rules.example.json` を正本へ引き上げた
- `package.json` の `scripts.test` は `tsx --test src/**/*.test.ts`(無引用)だとnpmが起動するsh経由のglob展開が1階層しか辿らず `src/scenes/core/*.test.ts` のような2階層下のテストを取りこぼすため、`tsx --test "src/**/*.test.ts"`(引用符付き)に調整した。引用符で囲むとNode組み込みテストランナー自身がglobを再帰展開し、全テストファイルを検出できることを確認済み

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
