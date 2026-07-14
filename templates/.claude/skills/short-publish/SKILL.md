---
name: short-publish
description: 完成したショートのYouTube公開メタデータ(shorts/<shortId>/publish/metadata.json)を生成する。「/short-publish sh001-xxx」で起動(引数省略時は未作成のショートから選択)。short-create の工程6でも呼ばれるが、レンダー済みショートへの後付けにも単体で使える。
---

# /short-publish — ショートの公開メタデータ生成

**開始前に必ず読む**: `channel/bible.md` §13(公開パッケージ)、`docs/thumbnail-principles.md`(タイトルの語調)。

**本編(publisher)との違い**: ショートはサムネイルを作らない(Shortsフィードでは縦動画のフレームが使われるため)。
出力は `metadata.json` の1本のみで、`PUBLISH.md`(サムネ3案の散文)は作らない。

## 0. 対象の決定

- 引数 `<shortId>` 省略時: `shorts/*/short.json` のうち `publish/metadata.json` を持たないものを一覧提示して選択(AskUserQuestion)
- 対象の `shorts/<shortId>/script.md` と `short.json` が存在することを確認する。無ければ停止して理由を報告する

## 1. 生成(publisher エージェントへ委譲)

publisher エージェントに「ショートモード」で依頼する(`.claude/agents/publisher.md` の『# ショート(/short-publish から呼ばれた場合)』節を参照させる)。渡す入力:

- `shorts/<shortId>/script.md`(実内容。タイトルはこれが答える範囲を超えてはならない)
- `shorts/<shortId>/short.json`(title / formatId / sourceEpisodeId)
- 元エピソードの `episodes/<sourceEpisodeId>/research.md`(出典・数字)
- `channel/bible.md` §13、`assets/audio/LICENSES.md` 末尾(クレジット文例)

出力: `shorts/<shortId>/publish/metadata.json`

## 2. 検証

```bash
npm run validate:metadata shorts/<shortId>
```

- OKになるまで publisher へ差し戻す(最大2周)
- 結果(OK/NG)を最終メッセージに含める

## 3. 完了報告

- 生成した title と privacyStatus、`#Shorts` が description に含まれることを報告する
- `short.json` の status は**変更しない**(公開の記録は factory-ui のアップロードが書く `publish/upload-result.json`)
- factory-ui のショート詳細画面からアップロードできる旨を案内する
