import assert from "node:assert/strict";
import test from "node:test";
import {
  STRIP,
  contractIssues,
  parseLumaSamples,
  parseSignalstats,
  stripFrameIndices,
  stripTimes,
  type ClipMetrics,
} from "./clip-metrics";

/**
 * Step 1 で実測した ffmpeg の実出力(scratchpad_gen/.../clips/cL01.mp4 に
 * `format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG`
 * を通した stderr の先頭3行)をそのまま貼る。連結なしは0行・連結ありは123行だった。
 */
const REAL = [
  "[Parsed_metadata_3 @ 0x7f88230114c0] lavfi.signalstats.YAVG=2.06403",
  "[Parsed_metadata_3 @ 0x7f88230114c0] lavfi.signalstats.YAVG=1.7372",
  "[Parsed_metadata_3 @ 0x7f88230114c0] lavfi.signalstats.YAVG=2.61892",
].join("\n");

test("metadata=print の実出力からフレーム間差分の平均と最大を取る", () => {
  const r = parseSignalstats(REAL);
  assert.equal(r.samples, 3);
  assert.ok(Math.abs(r.frameDiffMean - (2.06403 + 1.7372 + 2.61892) / 3) < 1e-6);
  assert.equal(r.frameDiffMax, 2.61892);
});

test("metadata=print を付けない素の signalstats 出力からは1件も取れない", () => {
  // これが取れてしまうと、フィルタの誤りに気づけない
  const bare = "[Parsed_signalstats_1 @ 0x1] n:0 pts:0 pts_time:0";
  assert.equal(parseSignalstats(bare).samples, 0);
});

test("1件も取れなければ samples 0 を返す(呼び出し側が失敗を検知できる)", () => {
  assert.deepEqual(parseSignalstats("no stats here"), { frameDiffMean: 0, frameDiffMax: 0, samples: 0 });
});

test("グレースケールの生バッファからフレームごとの輝度stdを出す", () => {
  const raw = Buffer.from([10, 10, 10, 10, 0, 0, 255, 255]); // 2x2 の2フレーム
  const out = parseLumaSamples(raw, 2, 2);
  assert.equal(out.length, 2);
  assert.equal(out[0], 0);
  assert.ok(out[1] > 100);
});

test("ストリップの抜き出し時刻は先頭から末尾まで等間隔の5点", () => {
  const t = stripTimes(8);
  assert.equal(t.length, 5);
  assert.equal(t[0], 0);
  assert.ok(t[2] > 3.9 && t[2] < 4, "3点目はほぼ中間");
  assert.ok(t[4] < 8 && t[4] > 7.5, "末尾はクリップ内に収める");
  for (let i = 1; i < t.length; i += 1) assert.ok(t[i] > t[i - 1], "単調増加");
});

test("枚数を指定できる", () => {
  assert.equal(stripTimes(8, 3).length, 3);
});


/** 契約検査とストリップ割り付けの雛形(実測に合わせた既定値) */
const M = (over: Partial<ClipMetrics> = {}): ClipMetrics => ({
  frames: 124, decodedFrames: 124, durationSec: 5.167, width: 1152, height: 640,
  frameDiffMean: 4.0, frameDiffMax: 6.0, diffSamples: 123, lumaStd: [30, 31, 30, 29], ...over,
});

test("申告どおりのフレーム数・解像度なら契約違反ゼロ", () => {
  assert.deepEqual(contractIssues(M(), { frames: 124, width: 1152 }), []);
});

test("フレーム数が申告と違えば契約違反", () => {
  const r = contractIssues(M({ frames: 90 }), { frames: 124, width: 1152 });
  assert.equal(r.length, 1);
  assert.ok(r[0].includes("フレーム"));
});

test("解像度が申告と違えば契約違反(hi 宣言と実物の食い違い)", () => {
  const r = contractIssues(M({ width: 1152 }), { frames: 124, width: 1344 });
  assert.equal(r.length, 1);
  assert.ok(r[0].includes("解像度"));
});

test("計測できていないクリップは契約違反にする(黙って緑にしない)", () => {
  const r = contractIssues(M({ diffSamples: 0 }), { frames: 124, width: 1152 });
  assert.ok(r.some((x) => x.includes("計測")));
});

/**
 * ダウンロード切れの mp4 はコンテナのヘッダを完全なまま持つので nb_frames は申告どおりを返す。
 * 実測(12%へ切り詰めた cL01)では nb_frames=124 のまま実デコードは7コマだった。
 * 申告値だけを突き合わせる検査はこれを緑で通す = 「壊れているのに緑」になる。
 */
test("実デコードのフレーム数が申告と違えば契約違反(ダウンロード切れ)", () => {
  const r = contractIssues(M({ frames: 13, decodedFrames: 13 }), { frames: 124, width: 1152 });
  assert.equal(r.length, 1);
  assert.ok(r[0].includes("実デコード"));
});

test("コンテナ申告どおりでも実デコードが足りなければ緑にしない", () => {
  // 切り詰めファイルの実物の形: nb_frames は申告どおり、読めるのは13コマだけ
  const r = contractIssues(M({ frames: 124, decodedFrames: 13 }), { frames: 124, width: 1152 });
  assert.ok(r.length > 0, "壊れているのに契約違反ゼロになっている");
  assert.ok(r.some((x) => x.includes("実デコード")));
});

test("nb_frames と実デコード数が食い違えばそれ自体が契約違反", () => {
  const r = contractIssues(M({ frames: 200, decodedFrames: 124 }), { frames: 124, width: 1152 });
  assert.equal(r.length, 1);
  assert.ok(r[0].includes("食い違う"));
});

test("ストリップは6コマ・単調増加・重複なし・範囲内", () => {
  const idx = stripFrameIndices(124);
  assert.equal(idx.length, STRIP.frames);
  assert.equal(STRIP.frames, 6);
  assert.equal(idx[0], 0);
  assert.equal(idx.at(-1), 123);
  for (let i = 1; i < idx.length; i += 1) assert.ok(idx[i] > idx[i - 1], "単調増加でない");
});

test("フレーム数が少なくても重複した番号を返さない", () => {
  for (const n of [1, 2, 3, 5, 6, 7]) {
    const idx = stripFrameIndices(n);
    assert.equal(new Set(idx).size, idx.length, n + "フレームで重複が出た");
    assert.ok(idx.every((x) => x >= 0 && x < n), n + "フレームで範囲外");
  }
});

test("ストリップの体裁は3x2・1コマ512px(較正で判読可能と確認した値)", () => {
  assert.equal(STRIP.cols, 3);
  assert.equal(STRIP.rows, 2);
  assert.equal(STRIP.cell, 512);
});

test("ストリップのコマ数は尺で決める: 7秒以下 6コマ 3x2 / 7秒超 9コマ 3x3", async () => {
  const { stripLayout, stripFrameIndices } = await import("./clip-metrics");
  assert.deepEqual(stripLayout(5.2), { frames: 6, cols: 3, rows: 2 });
  assert.deepEqual(stripLayout(7), { frames: 6, cols: 3, rows: 2 });
  assert.deepEqual(stripLayout(7.5), { frames: 9, cols: 3, rows: 3 });
  assert.equal(stripFrameIndices(240, 9).length, 9);
});
