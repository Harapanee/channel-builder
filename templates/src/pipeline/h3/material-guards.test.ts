// src/pipeline/h3/material-guards.test.ts
// 2026-09-23 積み残し: 0バイトの生成物(ep032 ④)・skipHeadFrames 後の残り尺不足(F の積み残し)
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HEAD_SKIP_MAX_STRETCH, headSkipShortfalls, zeroByteFiles, pngsIn } from "./material-guards";

test("zeroByteFiles: 0バイトのファイルだけを返す(無いファイルは別の検査の担当なので数えない)", () => {
  const d = mkdtempSync(join(tmpdir(), "zb-"));
  writeFileSync(join(d, "cL01.mp4"), "");
  writeFileSync(join(d, "cL02.mp4"), "x");
  assert.deepEqual(zeroByteFiles([join(d, "cL01.mp4"), join(d, "cL02.mp4"), join(d, "cL03.mp4")]), [join(d, "cL01.mp4")]);
});

test("pngsIn: ディレクトリ内の PNG を列挙(無いディレクトリは空)", () => {
  const d = mkdtempSync(join(tmpdir(), "zb-"));
  mkdirSync(join(d, "fig"));
  writeFileSync(join(d, "fig", "f00000.png"), "");
  writeFileSync(join(d, "fig", "note.txt"), "");
  assert.deepEqual(pngsIn(join(d, "fig")), [join(d, "fig", "f00000.png")]);
  assert.deepEqual(pngsIn(join(d, "nope")), []);
});

const seg = (clipId: string, frames: number, skipHeadFrames: number, holdSlow = false, card = false) =>
  ({ clipId, frames, skipHeadFrames, holdSlow, card });

test("headSkipShortfalls: 捨てた後の残りが区間を割るカットを返す(cL119=50 の型)。伸び率つき", () => {
  const got = headSkipShortfalls([seg("cL119", 200, 50), seg("cL120", 100, 4)], (id) => (id === "cL119" ? 212 : 125));
  assert.deepEqual(got, [{ clipId: "cL119", frames: 200, raw: 212, skip: 50, remain: 162, stretch: 200 / 162, block: true }]);
});

test("headSkipShortfalls: skipHeadFrames が 0 のカット・章カード・holdSlow(別検査が止める)は対象外", () => {
  const got = headSkipShortfalls(
    [seg("a", 200, 0), seg("b", 200, 10, false, true), seg("c", 200, 10, true)],
    () => 100,
  );
  assert.deepEqual(got, []);
});

test("headSkipShortfalls: ちょうど区間ぶん残れば通す", () => {
  assert.deepEqual(headSkipShortfalls([seg("a", 100, 8)], () => 108), []);
});

test("headSkipShortfalls: 伸び率が許容(既定 ×1.10)以下なら block しない(ep043〜045 の実測 ×1.003〜1.063 は目視合格)", () => {
  assert.equal(HEAD_SKIP_MAX_STRETCH, 1.1);
  const [a] = headSkipShortfalls([seg("cL56", 339, 26)], () => 345); // ×1.063
  assert.equal(a.block, false);
  const [b] = headSkipShortfalls([seg("cL72", 330, 22)], () => 310); // 330/288 = ×1.146(ep040 の型)
  assert.equal(b.block, true);
  const [c] = headSkipShortfalls([seg("x", 339, 26)], () => 345, { maxStretch: 1.05 });
  assert.equal(c.block, true);
});

test("assemble parseArgs: --allow-head-shortfall を受け取る(人間が見てスローを許容した場合)", async () => {
  const { parseArgs } = await import("./assemble");
  assert.equal(parseArgs(["ep001", "--allow-head-shortfall"]).allowHeadShortfall, true);
  assert.equal(parseArgs(["ep001"]).allowHeadShortfall, false);
});
