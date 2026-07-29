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
   `styleClasses` に列挙する。**clip全体を様式clipにするクラス(章カード・クレジット・
   タイトル札)だけを挙げること** — 字幕・吹き出しのようなインライン装飾を挙げると、
   ほぼ全clipが除外されて視覚多様性検査(規則6・7)が死ぬ
5. 素材が無くても正当なclip(タイトル札・クレジット等)のクラスを
   `assetFreeExemptClasses` に列挙する。素材なしclipの連続上限がここで切れる

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

## visual-rules.json のキーと担当エンジン

| キー | HF本編(`check-composition.ts`) | Remotionショート(`validate-shots.ts`) |
|---|---|---|
| `sceneClipSelector` / `styleClasses` / `assetFreeExemptClasses` | ○ | 無視 |
| `assetFreeExemptComponents` / `maxBubbleShots` | 無視 | ○ |
| `minDurationSec` / `minUniqueImagesPerMin` / `maxAiRatio` / `maxConsecutiveAssetFreeShots` / `minCoverAspectRatio` / `maxCaptionShotRatio` | ○ | ○ |
| `maxUsesPerImage` | ○(数値形・オブジェクト形) | 数値形のみ |

素材なしclipの免除は、HFでは**クラス名**(`assetFreeExemptClasses`)、Remotionでは
**コンポーネント名**(`assetFreeExemptComponents`)で指定する。両方を書いておけば
本編とショートの双方で免除が効く。

## 検査が「素材」として数えるもの

視覚多様性検査は、ブラウザが解決した絶対URLを見て `assets/` 配下を参照するものを
素材と数える。記法は問わない:

| 記法 | 数える |
|---|---|
| `<img src="assets/...">`(`./` `../` 付きも可) | ○ |
| `<svg><image href="assets/...">` | ○ |
| CSS `background-image` / `mask-image` / `border-image-source` | ○ |
| `data:` URI・外部URL(https等) | × |
| `assets/hf/` と `assets/fonts/` 配下 | ×(様式資産のため) |
| canvas に JS で描いたもの | ×(DOMから追えない) |

**全clipに敷く様式の地素材は `assets/hf/` 配下に置く**。素材として数えられると
規則2(同一素材の使用回数上限)に当たるため。

規則9(縦長素材のフレーミング)だけは `<img>` 限定で動く。background-image や
SVG `<image>` は実寸(naturalWidth)が取れないため、判定対象から自動的に外れる。

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
| `.bg` | 全画面素材 | 縦長素材では `object-position` を明示する。規則9は `<img>` にのみ効く |
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

## 音量 — モノラル音源はステレオ化で +3.0 LU 大きく測られる(HF経路の必修事項)

**`npm run tts` が出力する `narration/narration.wav` はモノラル**で、`src/pipeline/tts.ts` は
これを **-14.5 LUFS** に正規化する。ところが HyperFrames はモノラル音源を**両チャンネルへ
複製(デュアルモノ)**して出力するため、EBU R128 のチャンネル加算により、完成mp4の統合
ラウドネスは **約 -11.5 LUFS**(= -14.5 + 3.01 dB)になる。

これは QA基準(-14 LUFS ±1)を **2.5 LU 超過**する。**何もしなければ必ず QA に落ちる。**

### 対処

composition 側で**全音声要素を同率でトリム**する(比を変えないこと)。目安は **×0.708(-3.0 dB)**
だが、BGM/SE の構成で変わるので**必ずレンダー実測で追い込む**:

```
scripts/render-episode.sh episodes/<epId> qa-mix
cat episodes/<epId>/out/.render-status-qa-mix.json   # "lufs" が -15.0〜-13.0 なら合格
```

**BGM/SE だけを下げても解決しない。** 寄与は 0.1 LU 未満であり、いくら下げても統合ラウドネスは
動かない(実測例: ナレーション単体 -14.7 / Lch単独 -14.8 / ステレオ -11.8 = BGM/SE の寄与 0.08 LU)。

### やってはいけないこと

**`src/pipeline/tts.ts` の `NARRATION_TARGET_LUFS` を下げて解決しないこと。** この定数は
**Remotion経路のチャンネルで正しく機能している**(実測で複数チャンネルが -14.5〜-14.8 = 規格内)。
下げるとそれらのチャンネルの音声を壊す。Remotion はモノラルをステレオへ等パワーで配置するため
この加算が起きない。**これは HyperFrames 経路に固有の問題である。**
