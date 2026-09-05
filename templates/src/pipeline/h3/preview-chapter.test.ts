import assert from "node:assert/strict";
import test from "node:test";
import { buildSegments, type Segment } from "./assemble";
import { audioTrimFilter, chapterSlice, findChapter, missingMaterials, parseArgs } from "./preview-chapter";
import type { Chapter, Cut } from "./types";
import type { TimingLine } from "./plan";

/** 行間に無音がある実データの形(assemble.test.ts と同じ作り) */
const LINES: TimingLine[] = [
  { lineId: "L01", text: "a", startSec: 0, endSec: 1.6 },
  { lineId: "L02", text: "b", startSec: 2.0, endSec: 4.6 },
  { lineId: "L03", text: "c", startSec: 5.0, endSec: 7.6 },
  { lineId: "L04", text: "d", startSec: 8.0, endSec: 10.6 },
  { lineId: "L05", text: "e", startSec: 11.0, endSec: 13.6 },
  { lineId: "L06", text: "f", startSec: 14.0, endSec: 16.6 },
];
const TOTAL = 17.0;
const FPS = 24;
const cut = (lineIds: string[]): Cut => ({ lineIds, seconds: 0, place: "", subject: "", role: "" });
const CUTS: Record<string, Cut> = {
  cL01: cut(["L01"]), cL02: cut(["L02"]), cL03: cut(["L03"]),
  cL04: cut(["L04"]), cL05: cut(["L05"]), cL06: cut(["L06"]),
};
const chapter = (id: string, cuts: string[]): Chapter => ({ id, title: id, name: id, cuts });
const SEGMENTS = buildSegments(CUTS, LINES, TOTAL, FPS);

/* ───────────────────────── 引数 ───────────────────────── */

test("epId と章ID を位置引数で取る", () => {
  const o = parseArgs(["ep015-salmon", "ch00"]);
  assert.equal(o.epId, "ep015-salmon");
  assert.equal(o.chapterId, "ch00");
});

test("出力名の既定は <章ID>-preview.mp4(final.mp4 を既定にしない)", () => {
  assert.equal(parseArgs(["ep015-salmon", "ch03"]).outName, "ch03-preview.mp4");
});

test("--out で名前を変えられる", () => {
  assert.equal(parseArgs(["ep015-salmon", "ch00", "--out", "ch00-fix2.mp4"]).outName, "ch00-fix2.mp4");
});

test("章IDが無ければ例外(epId だけで全編を焼き始めない)", () => {
  assert.throws(() => parseArgs(["ep015-salmon"]), /使い方/);
});

test("--out にパス区切りが入っていたら例外(review/<epId>/ の外へは書かない)", () => {
  assert.throws(() => parseArgs(["ep015-salmon", "ch00", "--out", "../../episodes/ep015-salmon/out/final.mp4"]), /--out/);
  assert.throws(() => parseArgs(["ep015-salmon", "ch00", "--out", ".hidden.mp4"]), /--out/);
});

test("知らない引数は黙って無視せず例外", () => {
  assert.throws(() => parseArgs(["ep015-salmon", "ch00", "--force"]), /--force/);
});

test("位置引数が3つ以上なら例外(章を複数渡した取り違えを通さない)", () => {
  assert.throws(() => parseArgs(["ep015-salmon", "ch00", "ch01"]), /ch01/);
});

/* ───────────────────────── 章の特定 ───────────────────────── */

test("章IDから章を引ける", () => {
  const chapters = [chapter("ch00", ["cL01"]), chapter("ch01", ["cL02"])];
  assert.equal(findChapter(chapters, "ch01").cuts[0], "cL02");
});

test("無い章IDなら候補を並べて例外(打ち間違いを黙って0本にしない)", () => {
  const chapters = [chapter("ch00", ["cL01"]), chapter("ch06a", ["cL02"])];
  assert.throws(() => findChapter(chapters, "ch06"), /ch00, ch06a/);
});

/* ───────────────────────── 章の切り出し ───────────────────────── */

test("base は章の先頭 segment の offsetFrames、frames は章の合計", () => {
  const s = chapterSlice(SEGMENTS, chapter("chB", ["cL03", "cL04"]));
  assert.equal(s.base, 120);
  assert.equal(s.frames, 144);
  assert.deepEqual(s.segments.map((x) => x.clipId), ["cL03", "cL04"]);
});

test("base は絶対時刻と一致する(全カットで恒等式を保ってから絞るため)", () => {
  for (const ch of [chapter("a", ["cL01", "cL02"]), chapter("b", ["cL03", "cL04"]), chapter("c", ["cL05", "cL06"])]) {
    const s = chapterSlice(SEGMENTS, ch);
    assert.equal(s.base, Math.round(s.segments[0].startSec * FPS), ch.id + " の base が絶対時刻とずれている");
  }
});

test("章の全区間を足すと総尺になる(章ごとの切り出しに取りこぼしがない)", () => {
  const all = [chapter("a", ["cL01", "cL02"]), chapter("b", ["cL03", "cL04"]), chapter("c", ["cL05", "cL06"])]
    .map((ch) => chapterSlice(SEGMENTS, ch));
  assert.equal(all.reduce((n, s) => n + s.frames, 0), Math.round(TOTAL * FPS));
});

test("章に cuts.json に無いカットIDがあれば例外", () => {
  assert.throws(() => chapterSlice(SEGMENTS, chapter("chX", ["cL01", "cZZ"])), /cZZ/);
});

test("章のカットが時間軸で連続していなければ例外(飛んだぶんだけ音と絵がずれる)", () => {
  assert.throws(() => chapterSlice(SEGMENTS, chapter("chBad", ["cL01", "cL03"])), /cL03/);
});

test("章の宣言順が時刻順と違っても時刻順に並べ直す", () => {
  const s = chapterSlice(SEGMENTS, chapter("chB", ["cL04", "cL03"]));
  assert.deepEqual(s.segments.map((x) => x.clipId), ["cL03", "cL04"]);
  assert.equal(s.base, 120);
});

/* ───────────────────────── 音の切り出し ───────────────────────── */

test("音は章の区間だけ切って先頭へ寄せる", () => {
  assert.equal(audioTrimFilter(120, 144, FPS), "atrim=start=5.000000:end=11.000000,asetpts=N/SR/TB");
});

test("フレーム数を fps で割り切れなくても秒に直す(24分の1は循環小数)", () => {
  assert.equal(audioTrimFilter(1, 1, FPS), "atrim=start=0.041667:end=0.083333,asetpts=N/SR/TB");
});

/* ───────────────────────── 素材の欠け ───────────────────────── */

test("素材の実在検査は章のぶんだけ(章外の欠けは止める理由にしない)", () => {
  const s = chapterSlice(SEGMENTS, chapter("chA", ["cL01", "cL02"]));
  const found = missingMaterials(s.segments, (id) => id !== "cL05", () => true);
  assert.deepEqual(found.clips, []);
  assert.deepEqual(found.subs, []);
});

test("章の中で欠けていれば、生成されていないカットIDを列挙する", () => {
  const s = chapterSlice(SEGMENTS, chapter("chA", ["cL01", "cL02"]));
  const found = missingMaterials(s.segments, (id) => id !== "cL02", (id) => id !== "L01");
  assert.deepEqual(found.clips, ["cL02"]);
  assert.deepEqual(found.subs, ["L01"]);
});

test("束ねたカットは行ぶんだけ字幕を見る", () => {
  const segs = buildSegments({ cL01: cut(["L01", "L02"]), cL03: cut(["L03", "L04", "L05", "L06"]) }, LINES, TOTAL, FPS);
  const s = chapterSlice(segs, chapter("chA", ["cL01"]));
  assert.deepEqual(missingMaterials(s.segments, () => true, (id) => id === "L01").subs, ["L02"]);
});

test("missingMaterials は noSub のカットの字幕を要求しない", () => {
  const seg = (clipId: string, lineIds: string[], noSub: boolean): Segment =>
    ({ clipId, lineIds, startSec: 0, frames: 120, offsetFrames: 0, holdSlow: false, noSub });
  const segments = [seg("cL01", ["L01"], true), seg("cL02", ["L02"], false)];
  const m = missingMaterials(segments, () => true, () => false);
  assert.deepEqual(m.subs, ["L02"]);
});
