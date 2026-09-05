import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staleSheets } from "./inspect-clips";

// --- 最終レビュー: 古いコンタクトシートを残さない -----------------------------
// 章の本数が 33本以上→32本以下 へ減る(=差し戻しで隔離した直後)と、書き直されるのは
// <章>-sheet.png だけになり、<章>-sheet-1.png / -2.png が古い絵のまま残る。

const dirWith = (names: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "h3-sheets-"));
  for (const n of names) writeFileSync(join(dir, n), "x");
  return dir;
};

test("分割シートと単票シートの両方を拾う", () => {
  const dir = dirWith(["ch08-sheet.png", "ch08-sheet-1.png", "ch08-sheet-2.png"]);
  assert.deepEqual(staleSheets(dir, "ch08"), ["ch08-sheet-1.png", "ch08-sheet-2.png", "ch08-sheet.png"]);
});

test("他章のシートを巻き込まない(同じ review/<epId>/ に同居している)", () => {
  const dir = dirWith(["ch08-sheet.png", "ch09-sheet.png", "ch09-sheet-1.png"]);
  assert.deepEqual(staleSheets(dir, "ch08"), ["ch08-sheet.png"]);
});

test("ストリップと metrics は消さない(シートだけが対象)", () => {
  const dir = dirWith(["ch08-sheet.png", "strip-cL148.png", "ch08-metrics.tsv"]);
  assert.deepEqual(staleSheets(dir, "ch08"), ["ch08-sheet.png"]);
});

test("章IDが接頭辞になっている別章を拾わない", () => {
  const dir = dirWith(["ch06a-sheet.png", "ch06-sheet.png"]);
  assert.deepEqual(staleSheets(dir, "ch06"), ["ch06-sheet.png"]);
});

test("出力先がまだ無ければ空(初回実行)", () => {
  assert.deepEqual(staleSheets(join(tmpdir(), "h3-sheets-does-not-exist-" + Date.now()), "ch00"), []);
});
