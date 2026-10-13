import assert from "node:assert/strict";
import test from "node:test";
import { buildVtt, vttTime } from "./en-subs";

test("時刻は hh:mm:ss.mmm", () => {
  assert.equal(vttTime(0), "00:00:00.000");
  assert.equal(vttTime(3723.4567), "01:02:03.457");
});

test("各行を英語音声の実測尺で出し、上部指定を付ける", () => {
  const v = buildVtt(
    [{ lineId: "L01", startSec: 0 }, { lineId: "L02", startSec: 4.144 }],
    { L01: "Congratulations.", L02: "A shell." },
    { L01: 3.7, L02: 2.0 },
    { top: true },
  );
  assert.ok(v.startsWith("WEBVTT\n\n"));
  assert.match(v, /00:00:00\.000 --> 00:00:03\.700 line:5%\nCongratulations\./);
  assert.match(v, /00:00:04\.144 --> 00:00:06\.144 line:5%\nA shell\./);
});

test("上部指定なしなら位置指定を付けない", () => {
  const v = buildVtt([{ lineId: "L01", startSec: 1 }], { L01: "x" }, { L01: 1 }, { top: false });
  assert.match(v, /00:00:01\.000 --> 00:00:02\.000\nx/);
});

test("音声の尺が無い行は止める", () => {
  assert.throws(() => buildVtt([{ lineId: "L01", startSec: 0 }], { L01: "x" }, {}, { top: true }), /L01/);
});
