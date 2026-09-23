import { test } from "node:test";
import assert from "node:assert/strict";
import { findKanjiNumerals, lintScript } from "./lint-script";
import type { ParsedScriptLine } from "./parse-script";

const line = (lineId: string, text: string, display?: string): ParsedScriptLine => ({
  lineId, beat: "b", text, ...(display ? { hints: { display } } : {}),
});

test("findKanjiNumerals: 数量の漢数字を拾う", () => {
  assert.deepEqual(findKanjiNumerals("体重は百キロを超えます"), ["百キロ"]);
  assert.deepEqual(findKanjiNumerals("三匹のうち二匹が死にます"), ["三匹", "二匹"]);
  assert.deepEqual(findKanjiNumerals("九百倍あります"), ["九百倍"]);
  assert.deepEqual(findKanjiNumerals("二十年生きます"), ["二十年"]);
});

test("findKanjiNumerals: 慣用句と「万」の単位は拾わない", () => {
  assert.deepEqual(findKanjiNumerals("一生を終えます"), []);
  assert.deepEqual(findKanjiNumerals("一人前になるまで"), []);
  assert.deepEqual(findKanjiNumerals("一方で、一部の子は"), []);
  assert.deepEqual(findKanjiNumerals("一度も休めません"), []);
  assert.deepEqual(findKanjiNumerals("一匹残らず"), []);
  assert.deepEqual(findKanjiNumerals("1万5000組"), []);
  assert.deepEqual(findKanjiNumerals("一番ましな日"), []);
});

test("L7: 字幕(display があれば display)に漢数字の数量があれば FAIL", () => {
  const base = [line("L01", "あなたは転生しました")];
  const ok = lintScript([...base, line("L02", "体重はひゃっキロ", "体重は100キロ")], 1, 1.05, { maxSec: 9999 });
  assert.equal(ok.violations.filter((v) => v.check === "L7").length, 0);
  const ng = lintScript([...base, line("L03", "三匹のうち二匹が死にます")], 1, 1.05, { maxSec: 9999 });
  const l7 = ng.violations.filter((v) => v.check === "L7");
  assert.equal(l7.length, 1);
  assert.equal(l7[0].lineId, "L03");
  assert.match(l7[0].detail, /三匹/);
  // 読み上げ本文が漢数字でも display が算用数字なら通る
  const disp = lintScript([line("L04", "三匹のうち二匹", "3匹のうち2匹")], 1, 1.05, { maxSec: 9999 });
  assert.equal(disp.violations.filter((v) => v.check === "L7").length, 0);
});

test("L7: 「一」+助数詞は WARN(慣用が多い)", () => {
  const r = lintScript([line("L05", "一度だけ、一匹のメスが")], 1, 1.05, { maxSec: 9999 });
  assert.equal(r.violations.filter((v) => v.check === "L7").length, 0);
  assert.equal(r.warnings.filter((v) => v.check === "L7").length, 1);
});
