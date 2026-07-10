---
style_ref: stripe
colors:
  bg: "#f7f8fa"
  surface: "#ffffff"
  text-primary: "#0f172a"
  text-secondary: "#475569"
  border: "#e2e8f0"
  accent: "#4f46e5"
  on-accent: "#ffffff"
status:  # 状態バッジ専用の機能色(状態の意味にのみ使用。装飾パレット外)
  run: "#2563eb"   # running(ジョブ稼働)
  ok: "#15803d"    # approved / final / succeeded
  warn: "#b45309"  # building / awaiting_gate(要対応)
  err: "#b91c1c"   # failed
derived:  # 既存トークンからの導出(新色を増やさない)
  surface-2: "color-mix(in srgb, #f7f8fa 60%, #e2e8f0 40%)"   # hover・選択面
  text-muted: "color-mix(in srgb, #475569 65%, #ffffff 35%)"  # 非必須メタ(タイムコード等)のみ
typography:
  display: "-apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Segoe UI', sans-serif"
  body: "-apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Segoe UI', sans-serif"
  mono: "ui-monospace, 'SF Mono', Menlo, monospace"
  scale: [12, 13, 14, 16, 20, 24, 30]
  weights: [400, 500, 600, 700]
spacing: { base: 4, section: 32 }
radius: { small: 6, large: 12 }
signature: "制作ラインのステージレール(調査→台本→…→レンダーの工程を水平の点連結で描き現在地を強調)と、各カードに1つだけ置く『次の推奨アクション』ボタン"
---

# DESIGN.md — Factory UI(Channel Video Factory 管制ダッシュボード)

## Overview

チャンネル動画工場のオーナー(単独ユーザー)に、複数チャンネルの制作ラインの**現在の状態と次に必要な操作を一目で**把握・実行させる、ライトテーマのモダンSaaS管理ダッシュボード。閲覧環境はPCブラウザ(1280px〜)中心、最小768pxまで崩れないこと。ターミナルを開かずにカードとフォームで操作が完結することを主眼に置く。

## スタイル選定(2+1比較)

- **stripe(採用)**: 白地・クールニュートラル・抑えたアクセント・青み微陰影は、情報密度のある運用コンソールに最適。
- notion(外し候補): 温色editorialで読みやすいが「情報密度の高いデータダッシュボードには向かない」と明記されており不採用。
- 丸写し回避: stripeのシグネチャ(斜めグラデ帯・blurpleグラデCTA)はマーケLP用途なので**使わない**。色は運用コンソール向けに落ち着いたindigo単色へ、シグネチャは題材(制作ライン=工場)から再発明する。

## Colors

- bg: アプリ全体の基調背景(クールな極淡グレー)
- surface: カード・パネルの面(白)。影は青み微陰影 + 1pxヘアライン
- text-primary: 見出し・主要ラベル
- text-secondary: 本文・説明・**意味を持つ**補助ラベル(コントラスト十分)
- border: すべての面の区切り(1px)
- accent: primaryボタン・リンク・フォーカスリング・アクティブタブ・ステージレールの現在地のみ。装飾に広げない
- on-accent: accent地のボタン文字色
- status.run/ok/warn/err: 状態バッジ専用の機能色。running=run、approved/final/succeeded=ok、building/awaiting_gate(要対応)=warn、failed=err。**色だけでなく必ずテキストラベルを併記**
- derived.surface-2: hover・選択面(bg/borderからの導出。新色扱いしない)
- derived.text-muted: タイムコード等の**非必須**メタのみ(意味を持つ情報には使わない)

## Typography

- display: 画面タイトル・チャンネル名・カード見出し(scale 20/24/30、weight 600〜700、letter-spacing -0.01em)
- body: 本文・ボタン・タブ(scale 13/14/16、weight 400〜500)
- mono: タイムコード・尺・日時・ジョブID・エピソードID・進捗数値(scale 12/13、tabular-nums)
- scale: 12=メタ/バッジ、13=UI標準、14=本文、16=読ませる本文(bibleエディタ等)、20=カード見出し、24=セクション題、30=画面題
- weights: 400本文 / 500ボタン・タブ / 600カード見出し / 700画面題

## Components

- 状態バッジ(pill): status色の小円 + テキストラベル(RUNNING/APPROVED/BUILDING/FAILED/要対応)。薄い status 色地 + 濃い status 色文字。色のみに依存しない
- ステージレール(signature): 工程を小さな点で水平連結し、完了=accent塗り/現在=accentリング拡大/未達=border。ジョブカード・チャンネルカードに置き「制作ラインのどこにいるか」を即伝える
- チャンネルカード: 白surface、radius.large、青み微陰影 + border。channelName(20/600)+状態バッジ+進捗(稼働ジョブのステージレール)+**次の推奨アクション**ボタン1つ
- 要対応インボックス: ダッシュボード最上部。判断待ちゲート・失敗ジョブを status.warn/err のリスト行で集約、件数バッジ
- primaryボタン: accent地 + on-accent、radius.small、hover時わずかに暗く。secondary(ghost): 白地 + border + text-secondary
- 危険操作(キャンセル等): 白地 + status.err 文字 + border
- タブ: 高さ40px、text-secondary、アクティブは text-primary + accent 2px下線
- ゲートカード: question + option ボタン群。選択で応答送信、応答後は待機表示
- フォーカスリング: 全操作要素に outline 2px solid accent、offset 2px
- 空状態: text-secondary の1文 + 必要なら次アクションボタン。イラスト・絵文字なし

## Anti-slop宣言

- 避けた禁止定型: 紫青グラデ+ガラス(stripeのグラデ帯を含む)、絵文字アイコン、統計ヒーロー、均一カード化での階層喪失
- 理由: これは長時間の運用監視コンソールであり、装飾グラデや発光は判断の邪魔になる。色は「状態の意味」に割り当て、装飾はステージレールという機能的シグネチャに集約する
- signatureとの整合: ステージレールが「均一カードの中で最重要=進捗を差別化」し、各カードの単一の次アクションボタンが「次に何をすべきか」を装飾なしで明示する
