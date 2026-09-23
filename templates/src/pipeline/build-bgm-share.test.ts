// src/pipeline/build-bgm-share.test.ts
// 2026-09-23 積み残し: bgm-policy の trackShareMin(曲の配分の下限)
import assert from "node:assert/strict";
import test from "node:test";
import { trackShares, validateBgmPolicy, type BgmPlan } from "./build-bgm-cues";

const plan = (assignment: Array<[number, number, string]>): BgmPlan => ({
  baseVolume: 0.14,
  tracks: { wafu: { src: "a.mp3" }, tense: { src: "b.mp3" } },
  envelope: [[0, 100, 0.8]],
  assignment,
} as unknown as BgmPlan);

test("trackShares: assignment の尺比を曲ごとに返す", () => {
  const s = trackShares(plan([[0, 25, "wafu"], [25, 100, "tense"]]));
  assert.equal(s.wafu, 0.25);
  assert.equal(s.tense, 0.75);
});

test("trackShareMin: wafu が下限未満なら BLOCK(ep041: tense 75% で「ほぼピアノ」)", () => {
  const errs = validateBgmPolicy(plan([[0, 25, "wafu"], [25, 100, "tense"]]), { trackShareMin: { wafu: 0.4 } });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /wafu/);
  assert.match(errs[0], /25%/);
  assert.match(errs[0], /40%/);
});

test("trackShareMin: wafu 54% は通る(ep045)", () => {
  assert.deepEqual(validateBgmPolicy(plan([[0, 54, "wafu"], [54, 100, "tense"]]), { trackShareMin: { wafu: 0.4 } }), []);
});

test("trackShareMin: 曲が一度も割り当てられていなければ 0% として止める", () => {
  const errs = validateBgmPolicy(plan([[0, 100, "tense"]]), { trackShareMin: { wafu: 0.4 } });
  assert.match(errs[0], /wafu.*0%/);
});
