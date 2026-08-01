import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBgmCues,
  envGainAt,
  expandEnvelope,
  silentGaps,
  validateBgmPlan,
  type BgmPlan,
} from "./build-bgm-cues";

const LENGTHS = { a: 10, b: 20 };

/** 1曲・停止なしの最小計画 */
const SIMPLE: BgmPlan = {
  baseVolume: 0.2,
  tracks: { a: { src: "assets/audio/bgm/a.mp3" } },
  envelope: [[0, 25, 1]],
  assignment: [[0, 25, "a"]],
};

test("expandEnvelope: フェード宣言を階段状の区間へ展開する", () => {
  const env = expandEnvelope([{ start: 10, gain: [0.5, 0], steps: 3, stepSec: 0.4 }]);
  assert.deepEqual(env, [
    [10, 10.4, 0.5],
    [10.4, 10.8, 0.25],
    [10.8, 11.2, 0],
  ]);
});

test("envGainAt: 包絡線が覆っていない時間帯は 0(= BGM完全停止)", () => {
  const env = expandEnvelope([[0, 10, 1], [20, 30, 0.5]]);
  assert.equal(envGainAt(env, 5), 1);
  assert.equal(envGainAt(env, 15), 0, "覆われていない = 鳴らさない");
  assert.equal(envGainAt(env, 25), 0.5);
});

test("素材より長い区間はループさせ、波形が途切れないよう mediaStart を連続させる", () => {
  const cues = buildBgmCues(SIMPLE, LENGTHS);
  assert.equal(cues.length, 3, "10秒素材で25秒 = 10+10+5");
  assert.deepEqual(cues.map((c) => [c.start, c.duration, c.mediaStart]), [
    [0, 10, 0],
    [10, 10, 0],
    [20, 5, 0],
  ]);
  assert.ok(cues.every((c) => c.volume === 0.2), "baseVolume × 包絡線1.0");
});

test("停止帯は鳴らさず、明けたら曲の頭から出し直す", () => {
  const plan: BgmPlan = {
    ...SIMPLE,
    envelope: [[0, 5, 1], [15, 25, 1]], // 5–15秒は完全停止
  };
  const cues = buildBgmCues(plan, LENGTHS);
  assert.deepEqual(
    cues.map((c) => [c.start, c.duration, c.mediaStart]),
    [
      [0, 5, 0],
      [15, 10, 0], // 停止明けは頭出しへ戻る(素材内の位置を持ち越さない)
    ]
  );
});

test("曲の切り替え境界にクロスフェードを挟む(無音明けには挟まない)", () => {
  const plan: BgmPlan = {
    baseVolume: 1,
    tracks: { a: { src: "a.mp3" }, b: { src: "b.mp3" } },
    envelope: [[0, 40, 1]],
    assignment: [
      [0, 20, "a"],
      [20, 40, "b"],
    ],
  };
  const cues = buildBgmCues(plan, LENGTHS);
  /* 境界 20 秒で a が減衰しつつ b が立ち上がる = 同時刻に2曲のキューが並ぶ */
  const atBoundary = cues.filter((c) => c.start >= 20 && c.start < 20.8);
  assert.ok(atBoundary.some((c) => c.src === "a.mp3"), "旧曲がフェードアウトしながら残る");
  assert.ok(atBoundary.some((c) => c.src === "b.mp3"), "新曲がフェードインで重なる");

  /* 無音明けの切り替えでは重ねない(カット・イン) */
  const afterSilence: BgmPlan = { ...plan, envelope: [[0, 19, 1], [20, 40, 1]] };
  const cues2 = buildBgmCues(afterSilence, LENGTHS);
  assert.ok(
    !cues2.some((c) => c.src === "a.mp3" && c.start >= 20),
    "無音から復帰する境界では旧曲を重ねない"
  );
});

test("silentGaps: 包絡線が覆っていない区間を返す(検算用)", () => {
  assert.deepEqual(silentGaps(expandEnvelope([[0, 10, 1], [20, 30, 1]]), 35), [
    [10, 20],
    [30, 35],
  ]);
});

test("validateBgmPlan: 割り当ての隙間・未知の曲キー・包絡線の重なりを弾く", () => {
  assert.deepEqual(validateBgmPlan(SIMPLE, 25), []);

  const gap: BgmPlan = { ...SIMPLE, assignment: [[0, 10, "a"], [12, 25, "a"]] };
  assert.ok(validateBgmPlan(gap, 25).some((e) => e.includes("隙間")));

  const unknown: BgmPlan = { ...SIMPLE, assignment: [[0, 25, "zzz"]] };
  assert.ok(validateBgmPlan(unknown, 25).some((e) => e.includes("知らない曲キー")));

  const short: BgmPlan = { ...SIMPLE, assignment: [[0, 20, "a"]] };
  assert.ok(validateBgmPlan(short, 25).some((e) => e.includes("末尾を覆っていません")));

  const overlap: BgmPlan = { ...SIMPLE, envelope: [[0, 15, 1], [10, 25, 0.5]] };
  assert.ok(validateBgmPlan(overlap, 25).some((e) => e.includes("envelope が重複")));
});
