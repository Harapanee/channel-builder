import assert from "node:assert/strict";
import test from "node:test";
import { chainSourceOf, findStaleChains } from "./chain-stale";
import type { Cut, CutsFile } from "./types";

const cut = (extra: Partial<Cut> = {}): Cut => ({ lineIds: ["L"], seconds: 5, place: "p", subject: "s", role: "r", ...extra });

const file: Pick<CutsFile, "chapters" | "cuts"> = {
  chapters: [
    { id: "ch00", cuts: ["cL01", "cL02", "cL03"] } as CutsFile["chapters"][number],
    { id: "ch01", cuts: ["cL10", "cL11"] } as CutsFile["chapters"][number],
  ],
  cuts: {
    cL01: cut(),
    cL02: cut({ chain: true }),
    cL03: cut({ chain: true }),
    cL10: cut({ chainFrom: "cL03" }),
    cL11: cut(),
  },
};

const mt = (m: Record<string, number>) => (id: string): number | null => m[id] ?? null;

test("下流クリップが起点より新しければ古くない", () => {
  assert.deepEqual(findStaleChains(file, mt({ cL01: 1, cL02: 2, cL03: 3, cL10: 4, cL11: 1 })), []);
});

test("起点が作り直されて下流より新しくなったら、その下流を返す", () => {
  // cL01 を作り直した(mtime 10)。cL02 は古い起点から作られている
  assert.deepEqual(findStaleChains(file, mt({ cL01: 10, cL02: 2, cL03: 3, cL10: 4 })), ["cL02"]);
});

test("章をまたぐ chainFrom も見る", () => {
  assert.deepEqual(findStaleChains(file, mt({ cL01: 1, cL02: 2, cL03: 9, cL10: 4 })), ["cL10"]);
});

test("どちらかのクリップが無ければ判定しない(未生成は古さではない)", () => {
  assert.deepEqual(findStaleChains(file, mt({ cL02: 2, cL03: 3 })), []);
  assert.deepEqual(findStaleChains(file, mt({ cL01: 10 })), []);
});

test("同じ mtime は古くない(厳密に古いものだけ)", () => {
  assert.deepEqual(findStaleChains(file, mt({ cL01: 5, cL02: 5 })), []);
});

test("章の先頭の chain: true は起点なしとして飛ばす(例外にしない)", () => {
  const f = { chapters: [{ id: "c", cuts: ["a", "b"] } as CutsFile["chapters"][number]], cuts: { a: cut({ chain: true }), b: cut({ chain: true }) } };
  assert.deepEqual(findStaleChains(f, mt({ a: 5, b: 1 })), ["b"]);
});

test("cuts の Record だけを渡したときはキー順を並びとして扱う", () => {
  assert.deepEqual(findStaleChains(file.cuts, mt({ cL01: 10, cL02: 2, cL03: 3, cL10: 4 })), ["cL02"]);
});

test("chainSourceOf: chainFrom が chain より強い / chain は直前 / どちらも無ければ null", () => {
  assert.equal(chainSourceOf(cut({ chain: true, chainFrom: "x" }), "prev"), "x");
  assert.equal(chainSourceOf(cut({ chain: true }), "prev"), "prev");
  assert.equal(chainSourceOf(cut({ chain: true }), null), null);
  assert.equal(chainSourceOf(cut(), "prev"), null);
});
