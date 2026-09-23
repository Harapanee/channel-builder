// src/pipeline/h3/head-scan.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { HEAD_SCAN, applySkips, frameStats, parseArgs, recommendSkip, type FrameStat } from "./head-scan";

const M = HEAD_SCAN.margin;
import type { CutsFile } from "./types";

const W = 8;
const H = 4;
/** 1コマ = W*H の灰色バイト。pattern が関数なら画素ごとに値を決める */
function frame(pattern: number | ((i: number) => number)): Buffer {
  const b = Buffer.alloc(W * H);
  for (let i = 0; i < b.length; i += 1) b[i] = typeof pattern === "number" ? pattern : pattern(i);
  return b;
}
/** 縞模様(std がおよそ amp になる絵)。phase でずらすと「別の絵」になる */
const stripes = (amp: number, phase = 0) => frame((i) => (((i + phase) % 2) === 0 ? 128 - amp : 128 + amp));

test("frameStats: コマごとの輝度std・白紙率・前コマとの差を出す", () => {
  const raw = Buffer.concat([frame(250), stripes(50), stripes(50)]);
  const s = frameStats(raw, W, H);
  assert.equal(s.length, 3);
  assert.equal(s[0].std, 0);
  assert.equal(s[0].white, 1); // 全画素 235 以上
  assert.equal(s[0].diffPrev, 0); // 1コマ目は比較相手なし
  assert.ok(Math.abs(s[1].std - 50) < 0.01);
  assert.equal(s[1].white, 0);
  assert.ok(s[1].diffPrev > 100);
  assert.equal(s[2].diffPrev, 0);
});

/** std と diffPrev だけ指定して FrameStat を作る */
const st = (std: number, diffPrev = 1, white = 0.02): FrameStat => ({ std, diffPrev, white });
const steady = (n: number, std = 55) => Array.from({ length: n }, () => st(std));

test("recommendSkip: 冒頭に何も無いクリップは 0", () => {
  const r = recommendSkip(steady(30), { window: 12 });
  assert.equal(r.skip, 0);
  assert.deepEqual(r.reasons, []);
});

test("recommendSkip: 白紙の1コマ目(std≈0・白紙率100%)を捨てる", () => {
  const s = [st(1, 0, 1), st(55, 110), ...steady(28)];
  const r = recommendSkip(s, { window: 12 });
  assert.equal(r.garbage, 1);
  assert.equal(r.skip, 1 + M);
  assert.ok(r.reasons.includes("白紙"));
});

test("recommendSkip: 白からのフェードイン(std が安定値へ上がり切るまで)を捨てる", () => {
  // ep045 cL04 の実測に近い形: 1 → 7 → 13 → … → 55 で安定
  const fade = [1, 7, 13, 21, 28, 35, 42, 49].map((v, i) => st(v, i === 0 ? 0 : 15, i === 0 ? 1 : 0.03));
  const r = recommendSkip([...fade, ...steady(24)], { window: 12 });
  // 安定値 55 の ±20% (44) に入るのは 49(index 7)から
  assert.equal(r.garbage, 7);
  assert.equal(r.skip, 7 + M);
  assert.ok(r.reasons.includes("フェード"));
});

test("recommendSkip: 別の絵からの急な切り替わり(前コマ差が大きい)の手前を全部捨てる", () => {
  // ep044 cL23 型: 冒頭4コマが std 25 の別の絵、index 4 で本編(std 62)へ切り替わる
  const s = [st(26, 0), st(25), st(25), st(25), st(61, 164), ...steady(28, 62)];
  const r = recommendSkip(s, { window: 12 });
  assert.equal(r.garbage, 4);
  assert.equal(r.skip, 4 + M);
  assert.ok(r.reasons.includes("急変"));
});

test("recommendSkip: 安定値が低い絵(std 19 の平坦な画面)は白紙扱いしない", () => {
  const r = recommendSkip(steady(30, 19), { window: 12 });
  assert.equal(r.skip, 0);
});

test("recommendSkip: 窓の端まで落ち着かないものは unsettled を立てる(目視へ回す)", () => {
  const s = Array.from({ length: 30 }, (_, i) => st(i < 13 ? 5 + i * 3 : 60, 12));
  const r = recommendSkip(s, { window: 12 });
  assert.equal(r.unsettled, true);
  assert.equal(r.garbage, 12);
  assert.equal(r.skip, 12 + M);
});

test("recommendSkip: コマ数が窓+基準に足りなくても落ちない(あるだけで測る)", () => {
  const r = recommendSkip([st(1, 0, 1), st(50, 100), st(50), st(50)], { window: 12 });
  assert.equal(r.garbage, 1);
});

test("recommendSkip: 空のクリップは 0 と measured=false", () => {
  const r = recommendSkip([], { window: 12 });
  assert.equal(r.skip, 0);
  assert.equal(r.measured, false);
});

function cutsFixture(): CutsFile {
  return {
    episodeId: "epX",
    chapters: [{ id: "ch00", title: "序章", name: "", cuts: ["cL01", "cL02", "cL03"] }],
    cuts: {
      cL01: { lineIds: ["L01"], seconds: 5.167, place: "p", subject: "s", role: "r" },
      cL02: { lineIds: ["L02"], seconds: 5.167, place: "p", subject: "s", role: "r", skipHeadFrames: 12 },
      cL03: { lineIds: ["L03"], seconds: 5.167, place: "p", subject: "s", role: "r", skipHeadFrames: 3 },
    },
  };
}

test("applySkips: 既存値を小さくしない(大きい方を採る)・0 は書かない・入力を破壊しない", () => {
  const cuts = cutsFixture();
  const { next, changes } = applySkips(cuts, { cL01: 5, cL02: 4, cL03: 8 });
  assert.equal(next.cuts.cL01.skipHeadFrames, 5); // 新規
  assert.equal(next.cuts.cL02.skipHeadFrames, 12); // 既存 12 > 推奨 4 → 据え置き
  assert.equal(next.cuts.cL03.skipHeadFrames, 8); // 既存 3 < 推奨 8 → 引き上げ
  assert.deepEqual(changes, [
    { id: "cL01", from: undefined, to: 5 },
    { id: "cL03", from: 3, to: 8 },
  ]);
  assert.equal(cuts.cuts.cL01.skipHeadFrames, undefined); // 元の object は触らない
  assert.equal(cuts.cuts.cL03.skipHeadFrames, 3);
});

test("applySkips: 推奨 0 のカットに skipHeadFrames を生やさない", () => {
  const { next, changes } = applySkips(cutsFixture(), { cL01: 0 });
  assert.equal("skipHeadFrames" in next.cuts.cL01, false);
  assert.deepEqual(changes, []);
});

test("applySkips: 台帳に無いカットIDは無視する", () => {
  const { next, changes } = applySkips(cutsFixture(), { cL99: 6 });
  assert.equal(next.cuts.cL99, undefined);
  assert.deepEqual(changes, []);
});

test("parseArgs: epId・章ID・--apply・--window", () => {
  assert.deepEqual(parseArgs(["ep045-giant-panda"]), { epId: "ep045-giant-panda", chapterId: undefined, apply: false, window: 12, dir: undefined });
  assert.deepEqual(parseArgs(["ep045-giant-panda", "ch01", "--apply", "--window", "24"]), {
    epId: "ep045-giant-panda", chapterId: "ch01", apply: true, window: 24, dir: undefined,
  });
});

test("parseArgs: 値の無い --window・不正な値・epId 無しは例外(黙って既定へ戻さない)", () => {
  assert.throws(() => parseArgs(["ep045", "--window"]));
  assert.throws(() => parseArgs(["ep045", "--window", "0"]));
  assert.throws(() => parseArgs(["ep045", "--window", "abc"]));
  assert.throws(() => parseArgs(["--apply"]));
  assert.throws(() => parseArgs(["ep045", "--bogus"]));
});

test("recommendSkip: カメラの寄りでゆっくり std が上がるだけ(白紙・急変の起点なし)はフェード扱いしない", () => {
  // ep043 cL03 型の誤検知: 22 → 28 と1コマ 0.5 ずつ上がり、本編 30 前後で落ち着く
  const drift = Array.from({ length: 12 }, (_, i) => st(22 + i * 0.6, 1));
  const r = recommendSkip([...drift, ...steady(12, 30)], { window: 12 });
  assert.equal(r.skip, 0);
});

test("recommendSkip: 最初から速く動き続ける絵(前コマ差が本編でも同じ大きさ)は急変扱いしない", () => {
  // ep044 cL84 型の誤検知: 前コマ差が 20 前後で最後まで続く
  const s = Array.from({ length: 24 }, (_, i) => st(43, i === 0 ? 0 : 22));
  assert.equal(recommendSkip(s, { window: 12 }).skip, 0);
});

test("recommendSkip: 1コマ目が大きく外れていればフェードの起点と見なす(白紙でなくても)", () => {
  // ep043 cL35 型: 白に近い 4 → 45 → 73 → … → 26 と下がって 23 で安定
  const head = [4, 45, 73, 67, 56, 41, 34, 28, 26].map((v, i) => st(v, i === 0 ? 0 : [0, 33, 74, 53, 23, 22, 5, 4, 1][i], 0.03));
  const r = recommendSkip([...head, ...steady(20, 23)], { window: 12 });
  assert.equal(r.garbage, 8); // 26 は 23 の ±20% に入る
});

test("recommendSkip: 同じコマが2枚ずつ続く速い絵(前コマ差が 0 と 20 を交互)も急変扱いしない", () => {
  // ep044 cL83 型の誤検知
  const s = Array.from({ length: 24 }, (_, i) => st(34, i === 0 ? 0 : i % 2 ? 1 : 21));
  assert.equal(recommendSkip(s, { window: 12 }).skip, 0);
});

test("recommendSkip: 推奨値 = ゴミコマ数 + 余白(HEAD_SCAN.margin)。ゴミが無ければ余白も足さない", () => {
  assert.equal(M, 2); // ep043/044/045 の既知値 45本との較正で決めた値(平均の偏り −2.4 → −0.4 コマ)
  assert.equal(recommendSkip(steady(30), { window: 12 }).skip, 0);
  assert.equal(recommendSkip([st(1, 0, 1), ...steady(29)], { window: 12 }).skip, 1 + M);
});
