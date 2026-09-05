import assert from "node:assert/strict";
import test from "node:test";
import { carryHoldSlow, mergedCutIds } from "./build-cuts";
import type { Cut } from "./types";

const cut = (over: Partial<Cut> = {}): Cut => ({
  lineIds: ["L01"],
  seconds: 5.2,
  place: "",
  subject: "",
  role: "",
  ...over,
});

test("既存で holdSlow が true のカットは引き継がれる", () => {
  const cuts = { cL01: cut() };
  const existing = { cL01: cut({ holdSlow: true }) };
  const { cuts: merged, carried } = carryHoldSlow(cuts, existing);
  assert.equal(merged.cL01.holdSlow, true);
  assert.equal(carried, 1);
});

test("既存で holdSlow が無い/false のカットは引き継がれない", () => {
  const cuts = { cL01: cut(), cL02: cut() };
  const existing = { cL01: cut(), cL02: cut({ holdSlow: false }) };
  const { cuts: merged, carried } = carryHoldSlow(cuts, existing);
  assert.equal(merged.cL01.holdSlow, undefined);
  assert.equal(merged.cL02.holdSlow, undefined);
  assert.equal(carried, 0);
});

test("既存に無いカットID(新設カット)は holdSlow を持たない", () => {
  const cuts = { cL01: cut(), cL02: cut() };
  const existing = { cL01: cut({ holdSlow: true }) };
  const { cuts: merged, carried } = carryHoldSlow(cuts, existing);
  assert.equal(merged.cL01.holdSlow, true);
  assert.equal(merged.cL02.holdSlow, undefined);
  assert.equal(carried, 1);
});

test("既存が undefined(初回生成・読み込み失敗)なら引き継がず0件で続行する", () => {
  const cuts = { cL01: cut() };
  const { cuts: merged, carried } = carryHoldSlow(cuts, undefined);
  assert.equal(merged.cL01.holdSlow, undefined);
  assert.equal(carried, 0);
});

test("引き継ぎは新しい cuts の値(seconds等)を上書きしない。holdSlow だけを足す", () => {
  const cuts = { cL01: cut({ seconds: 9.9 }) };
  const existing = { cL01: cut({ seconds: 5.2, holdSlow: true }) };
  const { cuts: merged } = carryHoldSlow(cuts, existing);
  assert.equal(merged.cL01.seconds, 9.9);
  assert.equal(merged.cL01.holdSlow, true);
});

test("元の cuts オブジェクトは書き換えない(呼び出し側の入力を破壊しない)", () => {
  const cuts = { cL01: cut() };
  const existing = { cL01: cut({ holdSlow: true }) };
  carryHoldSlow(cuts, existing);
  assert.equal(cuts.cL01.holdSlow, undefined);
});

test("lineIds が2つ以上のカットIDだけを束ね済みとして返す", () => {
  const cuts = {
    cL01: cut({ lineIds: ["L01", "L02"] }),
    cL03: cut({ lineIds: ["L03"] }),
    cL04: cut({ lineIds: ["L04", "L05", "L06"] }),
  };
  const merged = mergedCutIds(cuts);
  assert.deepEqual(merged, ["cL01", "cL04"]);
});

test("束ねが1件も無ければ空配列(build-cuts が正当に扱える形)", () => {
  const cuts = { cL01: cut({ lineIds: ["L01"] }), cL02: cut({ lineIds: ["L02"] }) };
  assert.deepEqual(mergedCutIds(cuts), []);
});
