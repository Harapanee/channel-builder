import assert from "node:assert/strict";
import test from "node:test";
import { OVER_TOLERANCE_SEC, buildCues, type BgmPlan } from "./build-audio-cues-h3";
import { buildBgmCues } from "../build-bgm-cues";
import type { TimingLine } from "./plan";

const LINES: TimingLine[] = [
  { lineId: "L01", text: "a", startSec: 0, endSec: 1.6 },
  { lineId: "L02", text: "b", startSec: 2.0, endSec: 4.6 },
];
/* bgm-plan.json の契約は build-bgm-cues.ts の BgmPlan(envelope × assignment)。
   ブリーフの `bands` という形は既存実装に存在しないため、正本の形へ直した */
const PLAN: BgmPlan = {
  baseVolume: 0.18,
  tracks: { wafu: { src: "assets/audio/bgm/bgm-wafu-x.mp3" } },
  envelope: [[0, 5, 1.0]],
  assignment: [[0, 5, "wafu"]],
};
const LENGTHS = { wafu: 49.56 };

test("SE は空になる(生成音は SE ではなく h3:ambient が別トラックへまとめる)", () => {
  assert.deepEqual(buildCues("ep015-salmon", LINES, 5, PLAN, LENGTHS).se, []);
});

test("総尺は timing の totalDurationSec を使う", () => {
  assert.equal(buildCues("ep015-salmon", LINES, 5, PLAN, LENGTHS).total, 5);
});

test("ナレーションのパスがエピソード相対で入る", () => {
  const cues = buildCues("ep015-salmon", LINES, 5, PLAN, LENGTHS);
  assert.equal(cues.narration, "episodes/ep015-salmon/narration/narration.wav");
});

test("BGM の帯が bgm-plan から起きる", () => {
  const bgm = buildCues("ep015-salmon", LINES, 5, PLAN, LENGTHS).bgm;
  assert.equal(bgm.length, 1);
  assert.equal(bgm[0].src, "assets/audio/bgm/bgm-wafu-x.mp3");
  assert.equal(bgm[0].start, 0);
});

test("BGM の計算は既存の buildBgmCues と同一である(HF経路と同じ音になる)", () => {
  const bgm = buildCues("ep015-salmon", LINES, 5, PLAN, LENGTHS).bgm;
  assert.deepEqual(bgm, buildBgmCues(PLAN, LENGTHS));
});

test("SE台帳のハッシュは書かない(SEが無いのにハッシュを書くのは嘘になる)", () => {
  assert.equal("seLedgerHash" in buildCues("ep015-salmon", LINES, 5, PLAN, LENGTHS), false);
});

test("bgm-plan に無いトラックを帯が指したら例外", () => {
  const bad = { ...PLAN, assignment: [[0, 5, "nope"]] } as BgmPlan;
  assert.throws(() => buildCues("ep015-salmon", LINES, 5, bad, LENGTHS), /nope/);
});

test("帯が総尺を超えたら例外(無音の尻切れを黙って作らない)", () => {
  const over = { ...PLAN, assignment: [[0, 99, "wafu"]] } as BgmPlan;
  assert.throws(() => buildCues("ep015-salmon", LINES, 5, over, LENGTHS), /総尺/);
});

test("総尺の丸め(小数3桁)の範囲内なら超過とみなさない", () => {
  /* ep015-salmon の実データ: assignment は 974.94 まで・timing の総尺は 974.935 */
  const plan: BgmPlan = {
    ...PLAN,
    envelope: [[0, 5.005, 1.0]],
    assignment: [[0, 5.005, "wafu"]],
  };
  assert.equal(buildCues("ep015-salmon", LINES, 5, plan, LENGTHS).bgm.length, 1);
});

test("猶予は丸めぶんだけ(0.05秒)で、それを超えたら例外", () => {
  assert.equal(OVER_TOLERANCE_SEC, 0.05);
  const plan: BgmPlan = {
    ...PLAN,
    envelope: [[0, 5.06, 1.0]],
    assignment: [[0, 5.06, "wafu"]],
  };
  assert.throws(() => buildCues("ep015-salmon", LINES, 5, plan, LENGTHS), /総尺/);
});

test("ナレーションが総尺を超えていたら例外(尻切れを黙って作らない)", () => {
  const lines: TimingLine[] = [{ lineId: "L01", text: "a", startSec: 0, endSec: 9 }];
  assert.throws(() => buildCues("ep015-salmon", lines, 5, PLAN, LENGTHS), /ナレーション/);
});

test("台本行が空なら例外", () => {
  assert.throws(() => buildCues("ep015-salmon", [], 5, PLAN, LENGTHS), /台本行/);
});
