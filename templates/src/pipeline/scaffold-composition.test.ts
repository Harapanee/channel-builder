import assert from "node:assert/strict";
import test from "node:test";
import { parseGroups, splitStoryboard } from "./scaffold-composition";

const CLIPS = ["cL01", "cL02", "cL03", "cL04", "cL05", "cL06"];

test("章グループ: 個数指定は全clipを均等に割る", () => {
  const groups = parseGroups("3", CLIPS);
  assert.deepEqual(groups, [
    { label: "G1", from: "cL01", to: "cL02" },
    { label: "G2", from: "cL03", to: "cL04" },
    { label: "G3", from: "cL05", to: "cL06" },
  ]);
});

test("章グループ: 明示範囲が全clipを覆っていれば通る", () => {
  const groups = parseGroups("cL01-cL02,cL03-cL06", CLIPS);
  assert.equal(groups.length, 2);
  assert.equal(groups[1].to, "cL06");
});

test("章グループ: 覆われないclipがあれば止める(実装漏れの入口)", () => {
  // cL05・cL06 がどのグループにも入っていない。これを通すと、誰も実装しないまま
  // fallback 表示のclipがレンダーされる。
  assert.throws(() => parseGroups("cL01-cL02,cL03-cL04", CLIPS), /cL05, cL06/);
});

test("章グループ: 範囲が重なっていれば止める(同じclipを2グループが実装する)", () => {
  assert.throws(() => parseGroups("cL01-cL04,cL03-cL06", CLIPS), /cL03, cL04/);
});

test("章グループ: 存在しないclipIdを指定したら止める", () => {
  assert.throws(() => parseGroups("cL01-cL99", CLIPS), /cL99/);
});

test("章グループ: from が to より後ろなら止める", () => {
  assert.throws(() => parseGroups("cL04-cL02,cL05-cL06", CLIPS), /cL04/);
});

test("splitStoryboard: clip表の行と設計の散文を分ける(実装ブリーフの材料)", () => {
  const md = `# ep013 ストーリーボード

## 2. 視覚モチーフ

スパインは「におい」。

| clipId | 開始秒 | 尺 | lineIds | role | 演出記述 | 使用素材 | SE |
|---|---|---|---|---|---|---|---|
| cL01 | 0.00 | 3.20 | L01 | setup | 宣告 | \`char_ant\` | don |
| cL02 | 3.20 | 2.10 | L02 | show | 巣の断面 | — | — |

## 3. 音
BGMは和風コミカル。`;
  const s = splitStoryboard(md);
  assert.equal(s.rows.size, 2);
  assert.match(s.rows.get("cL01")!, /宣告/);
  assert.match(s.design, /スパインは「におい」/);
  assert.match(s.design, /BGMは和風コミカル/);
  assert.ok(!s.design.includes("cL01"), "設計の散文に clip行を混ぜない(担当範囲だけを別に配る)");
  assert.match(s.header, /clipId/);
});
