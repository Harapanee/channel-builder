import assert from "node:assert/strict";
import test from "node:test";
import {
  BLANK_STD_THRESHOLD,
  findBlankClips,
  lumaStdOfFrame,
  parseClipSpans,
  type ClipSpan,
  type FrameSample,
} from "./qa-flat-frames";

test("lumaStdOfFrame: 完全な単色は 0", () => {
  assert.equal(lumaStdOfFrame(new Uint8Array(100).fill(240)), 0);
});

test("lumaStdOfFrame: 空フレームは 0(0除算しない)", () => {
  assert.equal(lumaStdOfFrame(new Uint8Array(0)), 0);
});

test("lumaStdOfFrame: 半々に分かれた画は振れ幅の半分になる", () => {
  const g = new Uint8Array(100);
  g.fill(240, 0, 50);
  g.fill(200, 50, 100);
  assert.equal(lumaStdOfFrame(g), 20);
});

/**
 * ep012 の実測値(直接レンダーしたフレームを 128x59 gray で測ったもの)。
 * この境界が壊れると「白画面を見逃す」か「図解カットを誤爆する」かのどちらかになる。
 */
test("BLANK_STD_THRESHOLD: 壊れた白画面(0.7)は下、意図的な最小構成カット(2.8)は上", () => {
  assert.ok(0.7 < BLANK_STD_THRESHOLD, "壊れた cL53 は空と判定されること");
  assert.ok(2.8 > BLANK_STD_THRESHOLD, "紙地に記号だけの図解カットは通ること");
});

const CLIPS: ClipSpan[] = [
  { id: "cL52", startSec: 160.967, durationSec: 1.95 },
  { id: "cL53", startSec: 162.917, durationSec: 3.621 },
  { id: "cL54", startSec: 166.538, durationSec: 3.735 },
];

function samples(stdAt: (t: number) => number): FrameSample[] {
  const out: FrameSample[] = [];
  for (let t = 160; t < 171; t += 0.5) out.push({ timeSec: Number(t.toFixed(1)), lumaStd: stdAt(t) });
  return out;
}

test("findBlankClips: 空が続くclipだけを指摘する(ep012 cL53 の再現)", () => {
  const found = findBlankClips(CLIPS, samples((t) => (t >= 162.917 && t < 166.538 ? 0.7 : 23.3)));
  assert.deepEqual(found.map((f) => f.clipId), ["cL53"]);
  assert.equal(found[0].blankSamples, found[0].totalSamples);
  assert.ok(found[0].bestLumaStd < BLANK_STD_THRESHOLD);
});

test("findBlankClips: 紙地に記号だけの図解カットは指摘しない(誤爆しない)", () => {
  assert.deepEqual(findBlankClips(CLIPS, samples(() => 2.8)), []);
});

test("findBlankClips: 絵のあるclipは指摘しない", () => {
  assert.deepEqual(findBlankClips(CLIPS, samples(() => 23.3)), []);
});

test("findBlankClips: 空が一瞬(カバレッジ未満)なら指摘しない — 意図的な暗転・白飛ばしを殺さない", () => {
  const found = findBlankClips(CLIPS, samples((t) => (t >= 163.0 && t < 163.4 ? 0.7 : 23.3)));
  assert.deepEqual(found, []);
});

test("findBlankClips: 標本の無いclip(尺が間隔より短い)は判定しない", () => {
  const tiny: ClipSpan[] = [{ id: "cX", startSec: 500.1, durationSec: 0.2 }];
  assert.deepEqual(findBlankClips(tiny, samples(() => 0)), []);
});

test("parseClipSpans: composition.html の clip 行を開始秒順に読む", () => {
  const html = `
    <section data-hf-id="a" class="clip scene" id="cL02" data-start="5.133" data-duration="3.162" data-track-index="1"></section>
    <section data-hf-id="b" class="clip scene" id="cL01" data-start="0.000" data-duration="5.133" data-track-index="1"></section>
    <div class="not-a-clip" id="x"></div>`;
  assert.deepEqual(parseClipSpans(html), [
    { id: "cL01", startSec: 0, durationSec: 5.133 },
    { id: "cL02", startSec: 5.133, durationSec: 3.162 },
  ]);
});
