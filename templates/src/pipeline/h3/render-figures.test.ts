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
