import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MERGE, MIN_CLIP_SEC, SPEEDUP_ADVISE, planMergeCandidates, spanSeconds, speedupRatios, type TimingLine,
} from "./plan";
import type { Cut } from "./types";

/** 行間に無音がある実データの形に合わせる(ep015 は302箇所すべてに 0.35〜0.70秒ある) */
const line = (id: string, start: number, end: number, text = "x"): TimingLine => ({
  lineId: id, text, startSec: start, endSec: end,
});
const LINES: TimingLine[] = [
  line("L01", 0, 1.6), // 次行まで 2.0
  line("L02", 2.0, 4.6), // 次行まで 3.0
  line("L03", 5.0, 10.6), // 総尺まで 6.0
];
const TOTAL = 11.0;

test("下限は124フレーム相当の 5.167秒", () => {
  assert.ok(Math.abs(MIN_CLIP_SEC - 124 / 24) < 1e-9);
});

test("区間は「次の行の開始」まで。発話区間ではない", () => {
  assert.equal(spanSeconds(LINES, 0, 0, TOTAL), 2.0); // 発話は 1.6
  assert.equal(spanSeconds(LINES, 1, 1, TOTAL), 3.0); // 発話は 2.6
  assert.equal(spanSeconds(LINES, 2, 2, TOTAL), 6.0); // 最終行は総尺まで
});

test("束ねた区間は先頭行の開始から最終行の次の行の開始まで", () => {
  assert.equal(spanSeconds(LINES, 0, 1, TOTAL), 5.0);
});

test("区間の合計は総尺に一致する(取りこぼしゼロ)", () => {
  const total = planMergeCandidates(LINES, TOTAL).reduce((s, c) => s + c.spanSeconds, 0);
  assert.ok(Math.abs(total - TOTAL) < 1e-9, `合計 ${total} が総尺 ${TOTAL} と違う`);
});

test("下限を超える区間の行は単独のカットになる", () => {
  const out = planMergeCandidates(LINES, TOTAL);
  assert.deepEqual(out.at(-1)?.lineIds, ["L03"]);
  assert.equal(out.at(-1)?.spanSeconds, 6.0);
});

test("短い行は下限を超えるまで隣とまとめる", () => {
  const out = planMergeCandidates(LINES, TOTAL);
  assert.deepEqual(out[0].lineIds, ["L01", "L02"]);
  assert.equal(out[0].spanSeconds, 5.0);
});

test("生成尺は区間以上・下限以上で、グリッドに乗る", () => {
  const out = planMergeCandidates(LINES, TOTAL);
  for (const c of out) {
    assert.ok(c.seconds >= c.spanSeconds, "生成尺が区間より短い(スロー再生になる)");
    assert.ok(c.seconds >= MIN_CLIP_SEC);
    assert.ok(c.frames >= 124 && c.frames <= 362);
  }
});

test("MAX_MERGE を超えて束ねない(1カット1被写体が破れるため)", () => {
  assert.equal(MAX_MERGE, 3);
  const many = [line("L01", 0, 0.8), line("L02", 1, 1.8), line("L03", 2, 2.8), line("L04", 3, 3.8)];
  const out = planMergeCandidates(many, 5);
  assert.ok(out.every((c) => c.lineIds.length <= MAX_MERGE), "4行以上の束ねが出た");
});

test("章境界の行は必ず新しいカットを始める", () => {
  const out = planMergeCandidates(LINES, TOTAL, { boundaries: ["L02"] });
  assert.deepEqual(out.map((c) => c.lineIds), [["L01"], ["L02"], ["L03"]]);
});

test("束ねた候補は元の行本文をすべて持つ(planner が意味で判断できるように)", () => {
  const out = planMergeCandidates([line("L01", 0, 1, "あ"), line("L02", 1.5, 2.5, "い")], 3);
  assert.deepEqual(out[0].texts, ["あ", "い"]);
});

test("上限を超える区間は例外にせず frames: -1 で返して呼び出し側に判断させる", () => {
  const out = planMergeCandidates([line("L01", 0, 19)], 20);
  assert.equal(out[0].spanSeconds, 20);
  assert.equal(out[0].frames, -1);
});

const cut = (lineIds: string[], seconds: number): Cut =>
  ({ lineIds, seconds, place: "", subject: "", role: "" });

test("早回し倍率は 生成尺(グリッド後) ÷ タイムライン区間", () => {
  // L01 の区間は 2.0 秒。下限 5.167 秒で焼くので 124F / 24 ÷ 2.0
  const rows = speedupRatios({ cL01: cut(["L01"], 5.167) }, LINES, TOTAL);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cutId, "cL01");
  assert.equal(rows[0].spanSeconds, 2.0);
  assert.ok(Math.abs(rows[0].generatedSeconds - 124 / 24) < 1e-9);
  assert.ok(Math.abs(rows[0].ratio - (124 / 24) / 2.0) < 1e-9);
});

test("宣言した seconds ではなくグリッドに乗せたあとのフレーム数で測る", () => {
  // 5.0 秒と宣言しても実際に焼かれるのは 124F(5.167秒)
  const rows = speedupRatios({ cL02: cut(["L02"], 5.0) }, LINES, TOTAL);
  assert.ok(Math.abs(rows[0].generatedSeconds - 124 / 24) < 1e-9);
});

test("束ねたカットは先頭行の開始から最終行の次の行の開始まで", () => {
  const rows = speedupRatios({ cL01: cut(["L01", "L02"], 5.167) }, LINES, TOTAL);
  assert.equal(rows[0].spanSeconds, 5.0);
  assert.ok(rows[0].ratio < 1.05);
});

test("区間のほうが長ければ倍率は1未満になる(早回しではない)", () => {
  const rows = speedupRatios({ cL03: cut(["L03"], 5.167) }, LINES, TOTAL);
  assert.equal(rows[0].spanSeconds, 6.0);
  assert.ok(rows[0].ratio < 1);
});

test("台本に無い行を指すカットは黙って飛ばさず例外にする", () => {
  assert.throws(() => speedupRatios({ cL99: cut(["L99"], 5.167) }, LINES, TOTAL), /L99/);
});

// build-cuts.ts / check.ts はどちらも `ratio > SPEEDUP_ADVISE` で早回しの超過を判定する
// (呼び出し側の境界の意味を実測ベースの ratio で確かめる。定数の同語反復にしない)
test("下限で焼くと本来の閾値(×1.4)を明確に超える(cL01 は span 2.0秒・下限5.167秒で焼く)", () => {
  const rows = speedupRatios({ cL01: cut(["L01"], 5.167) }, LINES, TOTAL);
  assert.ok(rows[0].ratio > SPEEDUP_ADVISE, `ratio ${rows[0].ratio} が閾値 ${SPEEDUP_ADVISE} を超えていない`);
});

test("区間のほうが長いカット(cL03)は閾値を超えない", () => {
  const rows = speedupRatios({ cL03: cut(["L03"], 5.167) }, LINES, TOTAL);
  assert.ok(rows[0].ratio < SPEEDUP_ADVISE);
});
