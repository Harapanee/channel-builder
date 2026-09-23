import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AMBIENT, ambientClipIds, ambientPieceArgs, ambientPlan, resolveAmbientConfig, unknownAmbientKeys } from "./ambient";
import type { Segment } from "./assemble";

const seg = (clipId: string, frames: number, offsetFrames: number): Segment =>
  ({ clipId, lineIds: [], startSec: offsetFrames / 24, frames, offsetFrames, holdSlow: false, skipHeadFrames: 0, noSub: false });

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

/* ---- noise floor による検出と自動除外(2026-09-18 channel-refine) ---- */

import { applyNoiseExclusion, flagNoisyClips, parseNoiseFloorDb } from "./ambient";

const ASTATS = [
  "[Parsed_astats_0 @ 0x7f] Overall",
  "[Parsed_astats_0 @ 0x7f] DC offset: 0.000001",
  "[Parsed_astats_0 @ 0x7f] Peak level dB: -25.815321",
  "[Parsed_astats_0 @ 0x7f] RMS level dB: -40.395602",
  "[Parsed_astats_0 @ 0x7f] Noise floor dB: -33.601739",
  "[Parsed_astats_0 @ 0x7f] Flat factor: 0.000000",
].join("\n");

test("parseNoiseFloorDb: ffmpeg astats の Overall から Noise floor を読む", () => {
  assert.equal(parseNoiseFloorDb(ASTATS), -33.601739);
});

test("parseNoiseFloorDb: 見つからなければ null(黙って 0 にしない)", () => {
  assert.equal(parseNoiseFloorDb("no stats here"), null);
});

test("flagNoisyClips: 閾値を超えたクリップだけを、うるさい順に返す", () => {
  const flagged = flagNoisyClips({ cL23: -33.6, cL95: -58.2, cL86: -41.6, cL01: -60.1 }, -40);
  assert.deepEqual(flagged, [{ clipId: "cL23", noiseFloorDb: -33.6 }]);
  const wider = flagNoisyClips({ cL23: -33.6, cL95: -58.2, cL86: -41.6 }, -45);
  assert.deepEqual(wider.map((f) => f.clipId), ["cL23", "cL86"]);
});

test("flagNoisyClips: 閾値ちょうどは超えていない", () => {
  assert.deepEqual(flagNoisyClips({ cL01: -40 }, -40), []);
});

test("applyNoiseExclusion: autoExclude が真なら exclude に足す(元の exclude は残す)", () => {
  const c = resolveAmbientConfig({ exclude: ["cL10"], noiseFloorMaxDb: -40, autoExclude: true });
  const next = applyNoiseExclusion(c, [{ clipId: "cL23", noiseFloorDb: -33.6 }]);
  assert.ok(next.exclude.has("cL10"));
  assert.ok(next.exclude.has("cL23"));
  assert.ok(!c.exclude.has("cL23"), "元の設定は書き換えない");
});

test("applyNoiseExclusion: autoExclude が偽(既定)なら何も足さない=報告のみ", () => {
  const c = resolveAmbientConfig({ noiseFloorMaxDb: -40 });
  assert.equal(c.autoExclude, false);
  const next = applyNoiseExclusion(c, [{ clipId: "cL23", noiseFloorDb: -33.6 }]);
  assert.equal(next.exclude.size, 0);
});

test("resolveAmbientConfig: noiseFloorMaxDb の既定は -40、null で検査を切る", () => {
  assert.equal(resolveAmbientConfig(undefined).noiseFloorMaxDb, -40);
  assert.equal(resolveAmbientConfig({ noiseFloorMaxDb: null }).noiseFloorMaxDb, null);
});

/* ---- 2026-09-23 レビュー指摘 C3/C4 ---- */

const cardSeg = (clipId: string, frames: number, offsetFrames: number): Segment => ({ ...seg(clipId, frames, offsetFrames), card: true });

test("章カード(card)の区間は exclude に書かなくても無音になる", () => {
  const plan = ambientPlan([seg("cL01", 48, 0), cardSeg("cL02", 72, 48)], resolveAmbientConfig(undefined));
  assert.deepEqual(plan.map((p) => p.clipId), ["cL01", null]);
  assert.deepEqual(plan.map((p) => p.frames), [48, 72]);
});

test("既存の exclude(章カードと同じ集合を手書きしたもの)もそのまま有効", () => {
  const plan = ambientPlan([seg("cL01", 48, 0), cardSeg("cL02", 72, 48)], resolveAmbientConfig({ exclude: ["cL01", "cL02"] }));
  assert.deepEqual(plan.map((p) => p.clipId), [null, null]);
});

test("ambientClipIds: 音を使うクリップは章カードと exclude を除いたもの", () => {
  const ids = ambientClipIds([seg("cL01", 48, 0), cardSeg("cL02", 72, 48), seg("cL03", 24, 120)], resolveAmbientConfig({ exclude: ["cL03"] }));
  assert.deepEqual(ids, ["cL01"]);
});

test("断片は skipHeadFrames を持つ(映像で捨てた冒頭の音も捨てる)", () => {
  const plan = ambientPlan([{ ...seg("cL01", 48, 0), skipHeadFrames: 6 }], resolveAmbientConfig(undefined));
  assert.equal(plan[0].skipHeadFrames, 6);
});

test("ambientPieceArgs: skipHeadFrames があれば -ss k/fps で頭を捨ててから区間ぶん切る", () => {
  const args = ambientPieceArgs({ clipId: "cL01", frames: 48, gainDb: -18, skipHeadFrames: 6 }, "/c/cL01.mp4", "/w/0000.wav", 24, 48000);
  const ss = args.indexOf("-ss");
  assert.ok(ss >= 0 && ss < args.indexOf("-i"), args.join(" "));
  assert.equal(args[ss + 1], "0.250000");
  assert.equal(args[args.indexOf("-t") + 1], "2.000000");
  assert.equal(args[args.length - 1], "/w/0000.wav");
});

test("ambientPieceArgs: skipHeadFrames が 0 なら -ss を付けない(従来と同じ引数)", () => {
  const args = ambientPieceArgs({ clipId: "cL01", frames: 48, gainDb: -18, skipHeadFrames: 0 }, "/c/cL01.mp4", "/w/0000.wav", 24, 48000);
  assert.deepEqual(args, ["-y", "-i", "/c/cL01.mp4", "-vn",
    "-af", "aresample=48000,apad,volume=-18dB", "-ac", "2", "-t", "2.000000", "-c:a", "pcm_s16le", "/w/0000.wav"]);
});

test("ambientPieceArgs: 無音の断片は anullsrc", () => {
  const args = ambientPieceArgs({ clipId: null, frames: 24, gainDb: -18, skipHeadFrames: 0 }, "", "/w/0001.wav", 24, 48000);
  assert.deepEqual(args, ["-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "1.000000", "-c:a", "pcm_s16le", "/w/0001.wav"]);
});
