# <slug>-style.css — クラス台帳(HF共通様式)

このチャンネルの HyperFrames コンポジションが共通で読む様式CSS。
**このファイルが後工程(scene-implementer)にとって唯一の様式参照**。
各エピソードの `composition.html` は `<head>` で次を読み込む:

```html
<link rel="stylesheet" href="assets/hf/<slug>-style.css">
```

目的は**完全ピクセル一致ではなく「様式として同一チャンネルに見える」こと**。

## scaffold 直後にやること

1. `style-template.css` を `<slug>-style.css` へ改名する
2. bible §8「映像スタイル」に従って `:root` の変数を実値へ置き換える
3. チャンネル固有の様式クラス(吹き出し・札・枠など)を追加し、下の台帳へ追記する
4. 追加した様式クラスのうち「反復が正当なもの」を `channel/visual-rules.json` の
   `styleClasses` に列挙する(視覚多様性検査が様式の反復を違反と数えないため)

## `maxUsesPerImage` の形式に関する注意

`channel/visual-rules.json` はHF本編(`check-composition.ts`)とRemotionショート
(`validate-shots.ts`)の両方から読まれる。`maxUsesPerImage` には2つの形式があるが、
**Remotion側は数値形しか解釈しない**:

| 形式 | HF本編 | Remotionショート |
|---|---|---|
| `"maxUsesPerImage": 3` | 全kind一律で3回 | 3回(正常) |
| `"maxUsesPerImage": { "default": 3, "byKind": { "character": null } }` | kind別。characterは無制限 | **静かに無効化**(例外は出ない) |

立ち絵の反復を除外したい場合はオブジェクト形を使うが、そのチャンネルのショートでは
同一素材の上限検査が効かなくなることを承知したうえで選ぶこと。

## カラー契約

| 変数 | 用途 |
|---|---|
| `--ch-paper` | 地(チャンネル基調) |
| `--ch-ink` | 本文・線 |
| `--ch-accent` | 主役の強調 |
| `--ch-warn` | 危険・警告 |
| `--ch-hope` | 希望・光 |

## クラス台帳

| クラス | 用途 | 使用規則 |
|---|---|---|
| `.clip` | 1シーン=1ラッパー(HF規約) | 並列siblingのclipは重なる。必ず1シーン1個 |
| `.paper-bg` | 地 | 素材を敷かないシーンの下地 |
| `.bg` | 全画面素材 | 縦長素材では `object-position` を明示する |
| `.char` | 立ち絵・切り抜き | z-index 3 を基準に前後を調整 |
| `.subtitle` | 字幕 | y 85〜93%。**シーン内テキストは y<82%** に収めて被せない |
| `.diagram-text` | 図解テキスト | **28px 下限**(恒久規則) |
| `.chapter-card` | 章カード | 様式clip。`styleClasses` に登録する |
| `.credit-line` | クレジット | 様式clip。`voice.json` の `creditNotice` を必ず含める |
| `.title-card` | タイトル札 | 様式clip |

## 運用規則

1. シーン内のテキスト・札は y<82% に収める(字幕セーフゾーンを侵さない)
2. 図解の文字は 28px を下回らない
3. 様式クラスは「チャンネルの一貫性」を担う。**場面演出をここへ足さない**
   — 場面演出は毎回そのエピソード用に新規実装する(ゼロ持ち越し)
