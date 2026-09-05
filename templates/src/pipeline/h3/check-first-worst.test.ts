import assert from "node:assert/strict";
import test from "node:test";
import { checkFirstWorst } from "./check";
import type { Cut } from "./types";

const cut = (lineIds: string[], extra: Partial<Cut> = {}): Cut => ({ lineIds, seconds: 6, place: "", subject: "", role: "", ...extra });
const LINES = [
  { lineId: "L01", startSec: 0 }, { lineId: "L02", startSec: 12 }, { lineId: "L03", startSec: 30 }, { lineId: "L04", startSec: 50 },
];
const cuts = { cL01: cut(["L01"]), cL02: cut(["L02"], { card: ["序章", "x"] }), cL03: cut(["L03"]), cL04: cut(["L04"]) };

test("B14: firstWorstLineId が無ければ BLOCK", () => {
  assert.equal(checkFirstWorst({ cuts }, LINES)[0].rule, "B14");
});
test("B14: 45秒以内・章カードでない行なら合格", () => {
  assert.deepEqual(checkFirstWorst({ cuts, firstWorstLineId: "L03" }, LINES), []);
});
test("B14: 45秒より後・章カードのカット・timing に無い行は BLOCK", () => {
  assert.ok(checkFirstWorst({ cuts, firstWorstLineId: "L04" }, LINES).some((f) => /45/.test(f.message)));
  assert.ok(checkFirstWorst({ cuts, firstWorstLineId: "L02" }, LINES).some((f) => /章カード/.test(f.message)));
  assert.ok(checkFirstWorst({ cuts, firstWorstLineId: "L99" }, LINES).length > 0);
});
