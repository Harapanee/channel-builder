import assert from "node:assert/strict";
import test from "node:test";
import { buildFigureHtml } from "./render-figures";
import type { Figure } from "./figures";

const assets = { fontUrl: "file:///font.ttf", gsapUrl: "file:///gsap.js" };

test("bars: 数値の文字数ぶん棒を短くして板の内側(1316px)に収める", () => {
  const fig: Figure = {
    id: "f", lineId: "L1", type: "bars", title: "世界のラッコの数",
    items: [{ label: "前", value: 300000, display: "15〜30万頭" }, { label: "後", value: 2000, display: "1000〜2000頭", accent: true }],
  };
  const html = buildFigureHtml(fig, 5, assets);
  const widths = [...html.matchAll(/data-w="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(widths.length, 2);
  const longest = Math.max(...fig.items.map((i) => i.display.length));
  assert.ok(widths[0] + 440 + 30 + longest * 62 <= 1316, "最長の棒+ラベル+数値が板に収まる: " + widths[0]);
  assert.ok(widths[1] >= 10, "小さい値でも見える最小幅");
  assert.ok(html.includes("15〜30万頭") && html.includes("世界のラッコの数"));
});

test("grid: 一言(caption)は右の列に置く(字幕帯と離す)", () => {
  const fig: Figure = { id: "g", lineId: "L1", type: "grid", title: "t", highlight: 76, mode: "remove", caption: "4年で 76% 減" };
  const html = buildFigureHtml(fig, 5, assets);
  assert.ok(/class="caption side"/.test(html));
  assert.equal((html.match(/class="cell on gone"/g) ?? []).length, 76);
  assert.equal((html.match(/class="cell on/g) ?? []).length, 100);
});

test("暗転の量と尺がタイムラインへ渡る", () => {
  const fig: Figure = { id: "f", lineId: "L1", type: "bars", title: "t", dim: 0.7, items: [{ label: "a", value: 1, display: "1" }, { label: "b", value: 2, display: "2" }] };
  const html = buildFigureHtml(fig, 4.5, assets);
  assert.ok(html.includes("DIM=0.7") && html.includes("D=4.500"));
});

test("項目の出る瞬間(reveals)が data-at として各項目に埋まり、尺で縮めない", () => {
  const fig: Figure = {
    id: "f", lineId: "L1", type: "bars", title: "t", caption: "c",
    items: [{ label: "a", value: 1, display: "1" }, { label: "b", value: 2, display: "2", atPhrase: 3 }],
  };
  const html = buildFigureHtml(fig, 8, assets, { items: [0, 5.5], caption: 6.2 });
  const ats = [...html.matchAll(/class="row" data-at="([\d.]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ats, ["0.000", "5.500"]);
  assert.ok(html.includes('class="caption" data-at="6.200"'));
  assert.ok(!/timeScale/.test(html), "尺に合わせて縮めない(縮めると句とずれる)");
  // grid の内訳は粒と凡例の両方に留めが付く
  const grid: Figure = { id: "g", lineId: "L1", type: "grid", title: "t", segments: [{ label: "a", count: 3 }, { label: "b", count: 2, atPhrase: 1 }], total: 10 };
  const gh = buildFigureHtml(grid, 8, assets, { items: [0, 2.5] });
  assert.equal((gh.match(/class="cell on" data-at="2.500"/g) ?? []).length, 2);
  assert.ok(gh.includes('class="li seg" data-at="2.500"'));
});

test("章カードの板: 不透明な紙に番号と章名だけ(H3 に文字を描かせない)", async () => {
  const { buildCardHtml, cardHash } = await import("./render-figures");
  const html = buildCardHtml("第一章", "最初に会う相手が、最初の天敵", { fontUrl: "file:///f.ttf" });
  assert.ok(html.includes("第一章") && html.includes("最初に会う相手が、最初の天敵"));
  assert.ok(/background:#F4F1E7/.test(html), "全面が紙色(下の生成クリップを見せない)");
  assert.ok(!/opacity:0/.test(html), "全コマ同一。フェードや描画の進行は無い");
  assert.notEqual(cardHash("第一章", "a", 0, 10), cardHash("第一章", "b", 0, 10));
});

/* ---- cardHoldSec(2026-09-29) ---- */

test("章カードの板の窓: cardHoldFrames があればその尺だけ、無ければ区間まるごと", async () => {
  const { cardBoardFrames } = await import("./render-figures");
  assert.equal(cardBoardFrames({ frames: 200, cardHoldFrames: 60 }), 60);
  assert.equal(cardBoardFrames({ frames: 200 }), 200);
});

test("章カードの板の不透明度: 指定なしは全コマ 1、cardHoldSec では図解と同じ FADE_SEC で出入りする", async () => {
  const { cardOpacityAt } = await import("./render-figures");
  const { FADE_SEC } = await import("./figures");
  const fps = 24, frames = 60;
  for (let i = 0; i < frames; i++) assert.equal(cardOpacityAt(i, frames, fps, false), 1);
  assert.equal(cardOpacityAt(0, frames, fps, true), 0, "入りは 0 から");
  assert.equal(cardOpacityAt(30, frames, fps, true), 1, "中は不透明");
  const fadeFrames = Math.ceil(FADE_SEC * fps);
  assert.ok(cardOpacityAt(fadeFrames - 1, frames, fps, true) < 1);
  assert.equal(cardOpacityAt(fadeFrames, frames, fps, true), 1);
  const last = cardOpacityAt(frames - 1, frames, fps, true);
  assert.ok(last > 0 && last < 0.2, "尻は 0 へ向かう: " + last);
});

test("cardHash: フェードの有無で変わる(指定なしの既存ハッシュは変えない)", async () => {
  const { cardHash } = await import("./render-figures");
  assert.equal(cardHash("一", "a", 0, 10), cardHash("一", "a", 0, 10, false));
  assert.notEqual(cardHash("一", "a", 0, 10), cardHash("一", "a", 0, 10, true));
});

test("scaleAlpha: 不透明な板の PNG のアルファだけを掛ける(色は変えない)", async () => {
  const { scaleAlpha } = await import("./render-figures");
  const sharp = (await import("sharp")).default;
  const buf = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 244, g: 241, b: 231 } } }).png().toBuffer();
  const { data, info } = await sharp(await scaleAlpha(buf, 0.5)).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  assert.deepEqual([...data.subarray(0, 4)], [244, 241, 231, 128]);
});

test("cardFrameBuffers: フェードありの板は全コマ同じ画素形式(RGBA)。混在すると ffmpeg がフィルタグラフを作り直してコマを落とす・止まる(2026-09-30 ep001 で -217秒)", async () => {
  const { cardFrameBuffers } = await import("./render-figures");
  const sharp = (await import("sharp")).default;
  const opaque = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 244, g: 241, b: 231 } } }).png().toBuffer();
  const fps = 24, frames = 60;
  const bufs = await cardFrameBuffers(opaque, frames, fps, true);
  assert.equal(bufs.length, frames);
  const channels = await Promise.all(bufs.map(async (b) => (await sharp(b).metadata()).channels));
  assert.deepEqual([...new Set(channels)], [4], "全コマ RGBA");
  const mid = await sharp(bufs[30]).raw().toBuffer();
  assert.equal(mid[3], 255, "中は不透明");
  // フェードなし(従来)は撮った1枚をそのまま全コマに使う
  const legacy = await cardFrameBuffers(opaque, 5, fps, false);
  assert.equal(legacy.length, 5);
  assert.ok(legacy.every((b) => b.equals(opaque)));
});

test("cardHash: フェードありの鍵は画素形式をそろえた版で変わる(混在して焼いた板を焼き済み扱いしない)", async () => {
  const { cardHash } = await import("./render-figures");
  const { FADE_SEC } = await import("./figures");
  const { createHash } = await import("node:crypto");
  const broken = createHash("sha1").update(JSON.stringify({ card: ["一", "a"], startFrame: 0, frames: 60, v: 1, fade: FADE_SEC })).digest("hex").slice(0, 12);
  assert.notEqual(cardHash("一", "a", 0, 60, true), broken);
});
