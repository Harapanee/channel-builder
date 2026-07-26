import assert from "node:assert/strict";
import test from "node:test";
import { kenBurns, wipeIn } from "./index";

test("wipeInは指定方向から0→100%で開く", () => {
  assert.equal(wipeIn(0, 30, { direction: "left", durationFrames: 10 }).opacity, 0);
  assert.deepEqual(wipeIn(10, 30, { direction: "right", durationFrames: 10 }), {
    clipPath: "inset(0 0 0 0%)",
    opacity: 1,
  });
});

test("kenBurnsはショット尺内で補間し縮退入力を安全化する", () => {
  assert.equal(kenBurns(0, 30, { durationSec: 2 }).scale, 1);
  assert.equal(kenBurns(30, 30, { durationSec: 2, from: 1, to: 1.1 }).scale, 1.05);
  assert.equal(kenBurns(90, 30, { durationSec: 2, from: 1, to: 1.1 }).scale, 1.1);
  assert.equal(kenBurns(0, 30, { durationSec: 0, to: 1.08 }).scale, 1.08);
});
