# Review Checklist — 工程別ゲートの検査観点

bible.md と併読すること。各項目は PASS / FAIL と根拠(該当箇所・時刻)を記録する。

## タグの読み方(1項目1ゲート)

各項目の先頭のタグは、その項目を判定する**責任ゲート**を示す。

| タグ | 担当ゲート | 工程 |
|---|---|---|
| `@lint` | `npm run lint:script` | 3 |
| `@script` | script-reviewer | 3 |
| `@fact` | fact-checker | 3 |
| `@assets` | asset-generator セルフチェック | 7 |
| `@check` | `npm run check`(HF)/ `npm run validate`(Remotion) | 9 |
| `@frame` | compliance-reviewer | 10 |
| `@publish` | publisher セルフチェック | 11 |

規則:

- **各ゲートは自分のタグの項目のみを判定する。他ゲートのタグが付いた項目を再検査してはならない**
- `@check` は「そのチャンネルの工程9の機械ゲートが**実際に判定している**項目」にのみ付ける。判定していない項目は `@frame` に残す
- 1項目に複数ゲートの判断が混ざる場合、タグを2つ付けず**項目を2行に分割**してそれぞれに1タグを付ける

## 構造(bible §4)

- [ ] `@script` 冒頭10秒以内に「何の話で、何が最悪か」が分かる
- [ ] `@script` 30秒以内に最初の笑いがある
- [ ] `@script` 20秒を超えて説明だけが続く区間がない
- [ ] `@script` 終盤に冒頭の回収(台詞・構図・SEのいずれか)がある
- [ ] `@script` 中心の問いが冒頭で開かれ、終盤で回収されている
- [ ] `@script` 因果接続語(結果/そのせいで/極めつけ等)の指示対象が、直前の行から明確に分かる
- [ ] `@script` 3分・6分相当の位置に新規の引き(再フック)がある(docs/retention-principles.md 原則4)
- [ ] `@script` 終端が回収→クレジット→即終了になっている(エンドトーク・次回予告・余韻がない。同 原則6)

## 笑い(bible §5)

- [ ] `@script` 禁止された笑い(被害者侮辱・史実捏造ギャグ・同一死亡ネタ反復・差別)がない
- [ ] `@script` 各ジョークに機能(release/contrast/characterization/transition)がある
- [ ] `@script` ジョークが3連続以上していない

## 史実(bible §9・§12)

- [ ] `@fact` 台本の全事実主張が research.md の出典と整合する
- [ ] `@frame` 誇張(ギャグ)と事実(説明)が画面上で区別できる
- [ ] `@frame` 地図・数字・年表に誇張が混入していない
- [ ] `@fact` 諸説ある事柄を断定していない(または諸説自体を扱っている)

## 映像(bible §8)

- [ ] `@frame` 画風が統一されている(オフホワイト/黒線/藍・赤・黄/陰影なし)
- [ ] `@assets` キャラ素材に緑透け・塗り省略がない(gen-image/remove-bgの塗り検査を通過している)
- [ ] `@frame` ショットの役割が show / explain に偏っていない(gag/reveal/payoff等が存在する)
- [ ] `@check` 視覚多様性の定量規則: 同一コンポーネントが3ショット以上連続していない/各章に3種以上の視覚様式(**HF経路のみ `@check`。Remotion経路は未機械化のため `@frame` に付け替えること**)
- [ ] `@check` 文字主体ショットが2割以下(章カード除く)
- [ ] `@check` 同一画像の使用回数・ユニーク画像密度・AI生成比率が `channel/visual-rules.json` のしきい値内(HF: check:visual / Remotion: validate Rule 6-8)
- [ ] `@check` 縦長画像(minCoverAspectRatio未満)のショットにfocus/fitが明示されている(HF: check:visual / Remotion: validate Rule 9)
- [ ] `@check` 場面演出のゼロ持ち越し(bible三層規則。HF: check:visual / Remotion: validate Rule 2b)
- [ ] `@check` 場面演出がテンプレ量産でない: 単一factory関数の文言差替え変種群は全体で1演出と数える(**HF経路のみ `@check`。Remotion経路は未機械化のため `@frame` に付け替えること**)
- [ ] `@frame` 地図・地理形状が実データ由来の共有ジオメトリ(japan-geometry / world-geometry)である(フリーハンドの大陸・海岸線はFAIL)
- [ ] `@frame` 各地図ショットの表示内容(ハイライト・ルート・ズーム)が台本の行の地理的主張と一致する(主張のない「とりあえず地図」はFAIL)
- [ ] `@frame` 大小比較の図解に実差がある(等値の図形対比・抽象概念の無差図解はFAIL — 概念対比は絵で)
- [ ] `@frame` 演出内テキストに切れ・重なり・省略記号(…)がない
- [ ] `@frame` 意味→映像マッピング(危険=赤円等)がbibleと一致する
- [ ] `@frame` 台本とショットの内容が各時刻で整合する(音で言っていることと画が矛盾しない)
- [ ] `@frame` 視覚伝達検査: サンプルフレーム(各章3+全地図・図解・カスタム初出)を実際に見て、「初見が画面から受け取る内容」がintent・台本行と一致する(伝わらない画面は1枚でもFAIL)
- [ ] `@frame` クライマックスの主要イベント(勝敗・死・転回)が文字や音だけでなく絵で表現されている

## 音(bible §11)

- [ ] `@frame` 主要なボケ・衝撃にSEが付いている
- [ ] `@frame` SEの定量予算(bible音の設計): 総数≤尺(秒)÷8・同一SE≤総数の20%。各SEに機能がある
- [ ] `@frame` SE/BGMがナレーションを妨げていない
- [ ] `@frame` SEが library.json / LICENSES.md 登録済みのものである

## 表記・権利(bible §12)

- [ ] `@publish` エンディングにvoice.json の creditNotice のクレジットがある
- [ ] `@script` 宗教/政治の断定・説教的な締めがない
- [ ] `@frame` 過剰に残酷な描写がない

## 判定

**各ゲートは自分のタグの項目のみを判定する。** 他ゲートのタグが付いた項目を再検査してはならない(重複検査は手戻りの巻き戻し距離を伸ばすため禁止)。
自分の担当項目が全てPASSのときのみ、そのゲートは合格を出す。FAILがある場合は各FAILに修正提案を付けて差し戻す。
