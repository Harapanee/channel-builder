// src/pipeline/h3/figures-keys-layout.test.ts
// 2026-09-23 積み残し: 型ごとの未知キー(ep038: grid の内訳を count でなく value と書き undefined が出た)と
// grid の右列の文字のはみ出し・折り返し(ep042 ⑧)
import assert from "node:assert/strict";
import test from "node:test";
import { estimateTextPx, figureKeyProblems, gridLayoutProblems, GRID_LAYOUT } from "./figures";
import type { Figure } from "./figures";
import { buildFigureHtml } from "./render-figures";

const base = { id: "fig-L10", lineId: "L10", title: "t" };

test("未知キー: grid の segments に value(count の書き違い)があれば止める", () => {
  const fig = { ...base, type: "grid", total: 12, segments: [{ label: "4〜6月", value: 3 }] } as unknown as Figure;
  const p = figureKeyProblems(fig);
  assert.ok(p.some((m) => /segments\[0\].*value/.test(m)), p.join("\n"));
  assert.ok(p.some((m) => /segments\[0\].*count/.test(m)), "count の欠落も言う: " + p.join("\n"));
});

test("未知キー: 図解の直下(bars に highlight など他の型のキー)も止める", () => {
  const fig = { ...base, type: "bars", highlight: 3, items: [{ label: "a", value: 1, display: "1" }, { label: "b", value: 2, display: "2" }] } as unknown as Figure;
  assert.ok(figureKeyProblems(fig).some((m) => /highlight/.test(m)));
});

test("未知キー: bars の items に count・scale の items に value は止める。正しい宣言は空", () => {
  const bars = { ...base, type: "bars", items: [{ label: "a", count: 1, display: "1" }, { label: "b", value: 2, display: "2" }] } as unknown as Figure;
  assert.ok(figureKeyProblems(bars).some((m) => /items\[0\].*count/.test(m)));
  const ok: Figure = { ...base, type: "grid", total: 100, highlight: 30, highlightLabel: "三割", caption: "c", mode: "remove", icon: "dot", holdSec: 0.2, dim: 0.5 };
  assert.deepEqual(figureKeyProblems(ok), []);
  const tl: Figure = { ...base, type: "timeline", events: [{ at: "0", label: "a" }, { at: "1", label: "b", pos: 0.5, accent: true, atPhrase: 1 }] };
  assert.deepEqual(figureKeyProblems(tl), []);
});

test("未知キー: 知らない型は止める", () => {
  assert.ok(figureKeyProblems({ ...base, type: "pie" } as unknown as Figure).length > 0);
});

test("estimateTextPx: 実測(Yusei Magic 44px)に ±8% で合う", () => {
  // 2026-09-23 に Chromium で実測した幅
  const cases: [string, number][] = [["10頭に6頭が死ぬ", 322.4], ["人から餌をもらっていた 75%", 509.1], ["10頭に届かない 18", 346.3], ["あいうえおかきくけこさしすせそ", 557.0], ["ABCDEFGHIJ 1234567890", 496.2], ["2頭はゼロ", 197.7]];
  for (const [t, w] of cases) {
    const e = estimateTextPx(t, 44);
    assert.ok(Math.abs(e - w) / w < 0.08, t + ": 推定 " + e.toFixed(1) + " / 実測 " + w);
  }
});

test("grid の highlightLabel: 粒が少ない配置(右列 324px)で折り返す長さなら止める(ep042 fig-L48 の型)", () => {
  const fig: Figure = { ...base, type: "grid", total: 10, highlight: 6, highlightLabel: "10頭に6頭が死ぬ" };
  assert.ok(gridLayoutProblems(fig).some((m) => /highlightLabel/.test(m)));
  assert.deepEqual(gridLayoutProblems({ ...fig, highlightLabel: "2頭はゼロ" }), []);
});

test("grid の highlightLabel: 100粒の配置(右列 632px)なら同じ文言は通る", () => {
  assert.deepEqual(gridLayoutProblems({ ...base, type: "grid", total: 100, highlight: 60, highlightLabel: "10頭に6頭が死ぬ" }), []);
});

test("grid の右列の一言(caption・折り返さない)が列からはみ出すなら止める(ep038 fig-L80 の型)", () => {
  const fig: Figure = { ...base, type: "grid", total: 12, highlight: 2, caption: "飛べない子が中にいる" };
  assert.ok(gridLayoutProblems(fig).some((m) => /caption/.test(m)));
});

test("grid の内訳ラベルは右端の数字ぶんを引いた幅で見る", () => {
  const fig: Figure = { ...base, type: "grid", total: 12, segments: [{ label: "とても長い内訳のラベルです", count: 3 }] };
  assert.ok(gridLayoutProblems(fig).some((m) => /segments\[0\]/.test(m)));
});

test("GRID_LAYOUT は render-figures の CSS と一致する(片方だけ直すと検査が嘘になる)", () => {
  const html = buildFigureHtml({ ...base, type: "grid", total: 100, highlight: 1, highlightLabel: "a" } as Figure, 1, { fontUrl: "f", gsapUrl: "g" });
  assert.ok(html.includes("width:" + GRID_LAYOUT.panelWidth + "px"));
  assert.ok(html.includes("padding:34px " + GRID_LAYOUT.panelPadX + "px 40px"));
  assert.ok(html.includes("border:" + GRID_LAYOUT.panelBorder + "px solid"));
  assert.ok(html.includes(".gridwrap{display:flex;align-items:center;gap:" + GRID_LAYOUT.wrapGap + "px}"));
  assert.ok(html.includes("padding-right:" + GRID_LAYOUT.sidePadRight + "px"));
  assert.ok(html.includes(".legend{font-size:" + GRID_LAYOUT.legendPx + "px"));
  assert.ok(html.includes("font-size:" + GRID_LAYOUT.captionPx + "px;white-space:nowrap"));
  assert.ok(html.includes(".legend b{margin-left:auto;font-size:" + GRID_LAYOUT.countPx + "px"));
  assert.ok(html.includes(".chip{display:inline-block;width:" + GRID_LAYOUT.chip + "px"));
  assert.ok(html.includes(".legend .li{display:flex;align-items:center;gap:" + GRID_LAYOUT.liGap + "px"));
  assert.ok(html.includes("repeat(10,54px)"));
});
