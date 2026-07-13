# Channel System 変更履歴

/channel-refine による承認済みシステム変更の記録。各変更は「契機 → 変更 → 期待効果」で記録し、効かなかった変更はこの記録を根拠に巻き戻す。

<!-- 記入形式(/channel-refine が追記する):

## YYYY-MM-DD
- 契機: <フィードバック原文の要約>
- 変更: <ファイルとセクション、変更内容の要約>
- 期待効果: <次エピソードで観測されるはずの変化>

まだ変更はない。Pilot 承認までは systemVersion 0.1.0 / status: building。 -->

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
