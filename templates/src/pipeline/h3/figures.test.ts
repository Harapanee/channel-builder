import assert from "node:assert/strict";
import test from "node:test";
import { figureOverlaysForChunk, figureReveals, figureWindow, typeRuns, validateFigure } from "./figures";
import type { Figure, FigureIndexEntry } from "./figures";
import type { FigureLine } from "./figures";
import type { Cut } from "./types";

const LINES: FigureLine[] = [
  { lineId: "L01", text: "a", startSec: 0, endSec: 3 },
  {
    lineId: "L16", text: "b", startSec: 91.8, endSec: 99.55,
    phrases: [
      { text: "p0", startSec: 91.9, endSec: 92.5 },
      { text: "p1", startSec: 92.7, endSec: 95.1 },
      { text: "p2", startSec: 95.3, endSec: 98.1 },
      { text: "p3", startSec: 98.2, endSec: 99.45 },
    ],
  },
  { lineId: "L17", text: "c", startSec: 100.1, endSec: 104 },
];
const lineById = new Map(LINES.map((l) => [l.lineId, l]));
const bars: Figure = {
  id: "fig-L16", lineId: "L16", type: "bars", title: "t",
  items: [{ label: "a", value: 1, display: "1" }, { label: "b", value: 2.9, display: "2.9倍" }],
};
const cut = (extra: Partial<Cut> = {}): Cut => ({ lineIds: ["L16"], seconds: 9, place: "", subject: "", role: "", ...extra });

test("表示窓は行頭〜行末+hold が既定", () => {
  const w = figureWindow(bars, lineById);
  assert.equal(w.fromSec, 91.8);
  assert.equal(w.toSec, 99.55 + 0.3);
});

test("句の番号で窓の頭と尻を切り詰められる", () => {
  const w = figureWindow({ ...bars, fromPhrase: 2, toPhrase: 2, holdSec: 0 }, lineById);
  assert.equal(w.fromSec, 95.3);
  assert.equal(w.toSec, 98.1);
});

test("toLineId で複数行にまたがれる", () => {
  const w = figureWindow({ ...bars, fromPhrase: 3, toLineId: "L17", holdSec: 0 }, lineById);
  assert.equal(w.fromSec, 98.2);
  assert.equal(w.toSec, 104);
});

test("窓は次の行頭を越えない(hold が次の行へ食い込まない)", () => {
  const w = figureWindow({ ...bars, holdSec: 5 }, lineById, 200);
  assert.equal(w.toSec, 100.1);
});

test("検査: 45秒以内・カード/画面文字/noSub のカット・実在しない句は不合格", () => {
  const cuts: Record<string, Cut> = { cL16: cut() };
  const anchored: Figure = { ...bars, items: [bars.items[0], { ...bars.items[1], atPhrase: 3 }] };
  assert.deepEqual(validateFigure(anchored, lineById, cuts), []);
  assert.ok(validateFigure({ ...bars, lineId: "L01" }, lineById, { cL01: cut({ lineIds: ["L01"] }) }).some((m) => /45/.test(m)));
  assert.ok(validateFigure(bars, lineById, { cL16: cut({ card: ["第一章", "x"] }) }).length > 0);
  assert.ok(validateFigure(bars, lineById, { cL16: cut({ text: true }) }).length > 0);
  assert.ok(validateFigure(bars, lineById, { cL16: cut({ noSub: true }) }).length > 0);
  assert.ok(validateFigure({ ...bars, fromPhrase: 9 }, lineById, cuts).length > 0);
  assert.ok(validateFigure({ ...bars, lineId: "L99" }, lineById, cuts).length > 0);
});

test("区間への切り出し: 連番の必要範囲と区間内の時刻を返す", () => {
  const fps = 24;
  // 絶対 2400F から 100F(4.17秒)。区間は 2352F 起点・120F(= 2352..2472)
  const e: FigureIndexEntry = { id: "f", dir: "d", startFrame: 2400, frames: 100, hash: "h" };
  const [o] = figureOverlaysForChunk([e], 2352, 120, fps);
  assert.equal(o.startNumber, 0);
  assert.equal(o.frames, 72); // 2400..2472
  assert.equal(o.atSec, (48 / fps).toFixed(3));
  // 次の区間 2472F 起点・200F → 残り 28F を 28 番から
  const [o2] = figureOverlaysForChunk([e], 2472, 200, fps);
  assert.equal(o2.startNumber, 72);
  assert.equal(o2.frames, 28);
  assert.equal(o2.atSec, "0.000");
  // 重ならない区間には出ない
  assert.deepEqual(figureOverlaysForChunk([e], 0, 2400, fps), []);
  assert.deepEqual(figureOverlaysForChunk([e], 2500, 100, fps), []);
});

test("recap は章カードの直後の行にだけ置ける / scale・timeline は2つ以上", () => {
  const cuts: Record<string, Cut> = { cL15: cut({ lineIds: ["L15"], card: ["第一章", "x"] }), cL16: cut() };
  const lines = new Map(LINES.map((l) => [l.lineId, l]));
  lines.set("L15", { lineId: "L15", text: "card", startSec: 88, endSec: 91 });
  const recap: Figure = { id: "r", lineId: "L16", type: "recap", title: "ここまでの請求書", items: [{ label: "1回目", text: "食べ続ける", now: true }] };
  assert.deepEqual(validateFigure(recap, lines, cuts), []);
  assert.ok(validateFigure({ ...recap, lineId: "L17" }, lines, { ...cuts, cL17: cut({ lineIds: ["L17"] }) }).some((m) => /章カードの直後/.test(m)));
  const scale: Figure = { id: "s", lineId: "L16", type: "scale", title: "t", items: [{ label: "a", size: 1, display: "1" }] };
  assert.ok(validateFigure(scale, lines, cuts).length > 0);
  const tl: Figure = { id: "t", lineId: "L16", type: "timeline", title: "t", events: [{ at: "0", label: "a" }] };
  assert.ok(validateFigure(tl, lines, cuts).length > 0);
});

test("留め(atPhrase): 項目はその句の頭に出る。無い項目は前の直後、先頭は 0", () => {
  const fig: Figure = {
    ...bars, fromPhrase: 1, holdSec: 0,
    items: [{ label: "a", value: 1, display: "1" }, { label: "b", value: 2.9, display: "2.9倍", atPhrase: 3 }],
    caption: "c", captionAtPhrase: 3,
  };
  const w = figureWindow(fig, lineById);
  const r = figureReveals(fig, lineById, w);
  assert.deepEqual(r.items.map((x) => +x.toFixed(2)), [0, +(98.2 - 92.7).toFixed(2)]);
  assert.equal(+(r.caption ?? 0).toFixed(2), +(98.2 - 92.7).toFixed(2));
  // 別の行の句にも留められる
  const r2 = figureReveals({ ...fig, toLineId: "L17", items: [fig.items[0], { ...fig.items[1], atLineId: "L17", atPhrase: 0 }] },
    new Map([...lineById, ["L17", { ...lineById.get("L17")!, phrases: [{ text: "q", startSec: 100.5, endSec: 103 }] }]]), { fromSec: 92.7, toSec: 104 });
  assert.equal(+r2.items[1].toFixed(2), +(100.5 - 92.7).toFixed(2));
  // 留めの無い2本目は前の直後(bars は 0.45)
  assert.deepEqual(figureReveals(bars, lineById, figureWindow(bars, lineById)).items, [0, 0.45]);
});

test("検査: bars/scale/timeline/grid segments の2つ目以降は留め必須。窓の外・逆順は不合格", () => {
  const cuts: Record<string, Cut> = { cL16: cut() };
  assert.ok(validateFigure(bars, lineById, cuts).some((m) => /atPhrase が無い/.test(m)), "2本目に留めが無い bars は不合格");
  const ok: Figure = { ...bars, fromPhrase: 2, items: [bars.items[0], { ...bars.items[1], atPhrase: 3 }] };
  assert.deepEqual(validateFigure(ok, lineById, cuts), []);
  // 窓の頭より前の句
  assert.ok(validateFigure({ ...ok, items: [ok.items[0], { ...ok.items[1], atPhrase: 1 }] }, lineById, cuts).some((m) => /より前/.test(m)));
  // 窓の尻に食い込む(toPhrase 2 で窓を閉じ、3 に留める)
  assert.ok(validateFigure({ ...ok, toPhrase: 2, holdSec: 0 }, lineById, cuts).some((m) => /食い込む/.test(m)));
  // 逆順
  const rev: Figure = { ...ok, fromPhrase: 1, items: [{ ...ok.items[0], atPhrase: 3 }, { ...ok.items[1], atPhrase: 2 }] };
  assert.ok(validateFigure(rev, lineById, cuts).some((m) => /先に出る/.test(m)));
  // recap・highlight だけの grid は留め無しでよい
  const grid: Figure = { id: "g", lineId: "L16", type: "grid", title: "t", highlight: 56 };
  assert.deepEqual(validateFigure(grid, lineById, cuts), []);
  const segs: Figure = { ...grid, segments: [{ label: "a", count: 60 }, { label: "b", count: 20 }] };
  assert.ok(validateFigure(segs, lineById, cuts).some((m) => /atPhrase が無い/.test(m)));
  assert.deepEqual(validateFigure({ ...segs, segments: [{ label: "a", count: 60 }, { label: "b", count: 20, atPhrase: 2 }] }, lineById, cuts), []);
});

test("同じ型の連続(typeRuns)を窓順の型列から拾う", () => {
  assert.deepEqual(typeRuns(["bars", "bars", "bars", "grid", "scale", "scale"]), [
    { type: "bars", from: 0, count: 3 }, { type: "scale", from: 4, count: 2 },
  ]);
  assert.deepEqual(typeRuns(["bars", "grid"]), []);
});
