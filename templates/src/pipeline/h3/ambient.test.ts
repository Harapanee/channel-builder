import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AMBIENT, ambientPlan, resolveAmbientConfig, unknownAmbientKeys } from "./ambient";
import type { Segment } from "./assemble";

const seg = (clipId: string, frames: number, offsetFrames: number): Segment =>
  ({ clipId, lineIds: [], startSec: offsetFrames / 24, frames, offsetFrames, holdSlow: false, noSub: false });

const SEGS: Segment[] = [seg("cL01", 48, 0), seg("cL02", 72, 48), seg("cL03", 24, 120)];

test("設定が無ければ既定(-18dB・除外なし)", () => {
  const c = resolveAmbientConfig(undefined);
  assert.equal(c.gainDb, DEFAULT_AMBIENT.gainDb);
  assert.equal(c.gainDb, -18);
  assert.equal(c.exclude.size, 0);
});

test("除外は集合になる", () => {
  const c = resolveAmbientConfig({ gainDb: -20, exclude: ["cL02"] });
  assert.equal(c.gainDb, -20);
  assert.ok(c.exclude.has("cL02"));
});

test("区間はそのままの順・そのままのフレーム数で並ぶ", () => {
  const plan = ambientPlan(SEGS, resolveAmbientConfig(undefined));
  assert.deepEqual(plan.map((p) => p.frames), [48, 72, 24]);
  assert.deepEqual(plan.map((p) => p.clipId), ["cL01", "cL02", "cL03"]);
});

test("除外したカットは無音になる(尺は保つ)", () => {
  const plan = ambientPlan(SEGS, resolveAmbientConfig({ exclude: ["cL02"] }));
  assert.equal(plan[1].clipId, null);
  assert.equal(plan[1].frames, 72);
});

test("perClip の指定は全体の gainDb より強い", () => {
  const plan = ambientPlan(SEGS, resolveAmbientConfig({ gainDb: -18, perClip: { cL03: { gainDb: -30 } } }));
  assert.equal(plan[0].gainDb, -18);
  assert.equal(plan[2].gainDb, -30);
});

test("フレーム数の合計は区間の合計に一致する(取りこぼしゼロ)", () => {
  const plan = ambientPlan(SEGS, resolveAmbientConfig(undefined));
  assert.equal(plan.reduce((s, p) => s + p.frames, 0), SEGS.reduce((s, x) => s + x.frames, 0));
});

/* ---- exclude / perClip の打ち間違いを検出する(指摘3) ---- */

const CUT_IDS = new Set(["cL01", "cL02", "cL03"]);

test("exclude/perClip が全部 cuts.json に実在すれば何も出ない", () => {
  const config = resolveAmbientConfig({ exclude: ["cL01"], perClip: { cL02: { gainDb: -30 } } });
  assert.deepEqual(unknownAmbientKeys(config, CUT_IDS), []);
});

test("exclude のIDが cuts.json に無ければ検出する(1文字違いは集合演算では素通りする)", () => {
  const config = resolveAmbientConfig({ exclude: ["cL25"] }); // 実在は cL03 系。打ち間違いの想定
  assert.deepEqual(unknownAmbientKeys(config, CUT_IDS), ["cL25"]);
});

test("perClip のキーが cuts.json に無ければ検出する", () => {
  const config = resolveAmbientConfig({ perClip: { cL99: { gainDb: -30 } } });
  assert.deepEqual(unknownAmbientKeys(config, CUT_IDS), ["cL99"]);
});

test("exclude と perClip の両方に無いIDがあれば、重複なく両方とも出す", () => {
  const config = resolveAmbientConfig({ exclude: ["cL25", "cL99"], perClip: { cL99: { gainDb: -30 } } });
  assert.deepEqual(unknownAmbientKeys(config, CUT_IDS), ["cL25", "cL99"]);
});
