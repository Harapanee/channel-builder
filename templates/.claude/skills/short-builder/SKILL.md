---
name: short-builder
description: このチャンネルのショート動画フォーマット(構造の型)をヒアリングで登録・改修する。「/short-builder」で起動。契約(channel/short-formats/<formatId>.json)と教義(同名.md)を生成し、以後のショート生成は /short-create が担う。
---

# /short-builder — ショートフォーマット構築

このスキルはショートを直接作らない。**ヒアリングを通じてフォーマット(契約+教義)を登録する**。
「契約と教義の分離」原則: コードが読むJSON(スキーマ検証必須)に機械が執行できない値を書かない。語り口・選定基準は教義(.md)へ。

## 起動時

- `channel/short-formats/*.json` を一覧提示(name / targetDurationSec / セグメント構成)。無ければ「新規登録」のみ
- ユーザーの意図を確認: 新規登録 / 既存フォーマットの改修

## ヒアリング(1問ずつ・AskUserQuestion推奨)

1. **型の名前と一言コンセプト**(例: ランキング逆順で最悪ポイントを積み上げる)
2. **構造**: セグメントの数・各段の役割(hook / body / climax / cta)・尺配分。ランキング型なら「第3位→第2位→第1位」の逆順が原則(期待値を積み上げる)
3. **全体尺**: 60秒以内を推奨(YouTube Shortsは最大3分だが、短いほど完走率が高い)
4. **ネタ選定基準**: エピソードのどの成果物から採るか(research.md のフック候補ランキング / 本編 script.md の名場面 等)と順位付けの基準
5. **語り口**: 本編との違い(テンポ・決め台詞の扱い・一人称)
6. **本編への誘導(cta)の型**: 決まり文句、言ってはいけないこと
7. **禁止事項**: このフォーマットでやらないこと

## 生成

- **契約**: `channel/short-formats/<formatId>.json`(short-format.schema.json 準拠。formatId は英小文字ケバブケースでファイル名と一致させる)。必要ならトップレベルに `"speech": { "speedScale": 1.15, "pauseLengthScale": 0.33 }` を追加して、本編と別の話速・句読点ポーズを指定できる(未指定は channel/voice.json 準拠)
- **教義**: `channel/short-formats/<formatId>.md`。章立て:
  1. 概要(型のコンセプト)
  2. 各セグメントの意図(segments の id ごとに)
  3. 語り口
  4. ネタ選定基準(どの成果物のどこから・順位付けの基準)
  5. 本編への誘導
  6. 禁止事項

## 検証と人間ゲート

1. `npm run validate:short-format channel/short-formats/<formatId>.json` が通ること(hookでも自動検証される)
2. **両ファイル全文をユーザーに提示して承認を得る**(人間ゲート)。改修時は変更点の要約+全文
3. 承認後にコミットし、`/short-create <epId> <formatId>` の使い方を案内する

## 改修時の注意

- 既存フォーマットの構造(segments)を変えると、過去のショートとの一貫性が崩れる。変更理由を教義の末尾に日付つきで追記する
