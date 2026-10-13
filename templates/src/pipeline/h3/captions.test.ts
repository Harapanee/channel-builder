// src/pipeline/h3/captions.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildJaVtt, captionCues, type CaptionLine } from "./captions";

const L105: CaptionLine = {
  lineId: "L105",
  text: "穴を土でふさいで、あなたは去ります。二十センチ、下に、子どもたちを残して。",
  displayText: "穴を土でふさいで、あなたは去ります。20センチ下に、子どもたちを残して。",
  startSec: 605.1,
  endSec: 610.5,
  phrases: [
    { text: "穴を土でふさいで", startSec: 605.2, endSec: 606.3 },
    { text: "あなたは去ります", startSec: 606.5, endSec: 607.5 },
    { text: "二十センチ", startSec: 607.7, endSec: 608.4 },
    { text: "下に", startSec: 608.6, endSec: 609.1 },
    { text: "子どもたちを残して", startSec: 609.2, endSec: 610.4 },
  ],
};

test("行の displayText を文ごとに切り、時刻は読み表記の句から取る(ep065 L105 型)", () => {
  const cues = captionCues([L105], new Set());
  assert.deepEqual(cues.map((c) => c.text), ["穴を土でふさいで、あなたは去ります。", "20センチ下に、子どもたちを残して。"]);
  assert.deepEqual(cues.map((c) => [c.start, c.end]), [[605.1, 607.7], [607.7, 610.5]]);
});

test("1文の行は1 cue。句の displayText は句読点を拾い直して連結する", () => {
  const line: CaptionLine = {
    lineId: "L01", text: "三びき、生まれます。", startSec: 1, endSec: 3,
    phrases: [{ text: "三びき", displayText: "3匹", startSec: 1, endSec: 2 }, { text: "生まれます", displayText: "生まれます", startSec: 2, endSec: 3 }],
  };
  assert.deepEqual(captionCues([line], new Set()), [{ text: "3匹、生まれます。", start: 1, end: 3 }]);
});

test("noSubtitle の行と skip の行は出さない", () => {
  const a: CaptionLine = { lineId: "L01", text: "あ。", startSec: 0, endSec: 1, noSubtitle: true };
  const b: CaptionLine = { lineId: "L02", text: "い。", startSec: 1, endSec: 2 };
  const c: CaptionLine = { lineId: "L03", text: "う。", startSec: 2, endSec: 3 };
  assert.deepEqual(captionCues([a, b, c], new Set(["L03"])).map((x) => x.text), ["い。"]);
});

test("42字を超える文は中央に近い読点で割り、時間は字数で按分する", () => {
  const text = "あ".repeat(20) + "、" + "い".repeat(29) + "。";
  const cues = captionCues([{ lineId: "L01", text, startSec: 0, endSec: 10 }], new Set());
  assert.deepEqual(cues.map((c) => c.text), ["あ".repeat(20) + "、", "い".repeat(29) + "。"]);
  assert.equal(cues[0].start, 0);
  assert.equal(cues[1].end, 10);
  assert.ok(Math.abs(cues[1].start - 10 * 21 / 51) < 1e-9);
});

test("文の数が読みと表示で合わなければ行全体を1 cue", () => {
  const line: CaptionLine = { lineId: "L01", text: "あ。い。", displayText: "あい。", startSec: 0, endSec: 2, phrases: [{ text: "あ", startSec: 0, endSec: 1 }, { text: "い", startSec: 1, endSec: 2 }] };
  assert.deepEqual(captionCues([line], new Set()), [{ text: "あい。", start: 0, end: 2 }]);
});

test("VTT は位置指定なし(画面下)・時刻は hh:mm:ss.mmm", () => {
  const vtt = buildJaVtt([{ lineId: "L01", text: "あ。", startSec: 3725.5, endSec: 3726 }], new Set());
  assert.equal(vtt, "WEBVTT\n\n01:02:05.500 --> 01:02:06.000\nあ。\n");
});

test("句を持たない文(「……。」)は長さ0の cue にせず次の文へ寄せる", () => {
  const line: CaptionLine = { lineId: "L01", text: "……。あ。", startSec: 0, endSec: 2, phrases: [{ text: "あ", startSec: 0, endSec: 2 }] };
  assert.deepEqual(captionCues([line], new Set()), [{ text: "……。あ。", start: 0, end: 2 }]);
});

test("VTT の本文は & と < をエスケープする", () => {
  const vtt = buildJaVtt([{ lineId: "L01", text: "A&B<C。", startSec: 0, endSec: 1 }], new Set());
  assert.ok(vtt.includes("A&amp;B&lt;C。"));
});
