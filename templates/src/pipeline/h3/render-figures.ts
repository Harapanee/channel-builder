/**
 * 図解(figures.json)を透過PNG連番に焼く。
 *
 *   npm run h3:figures -- <epId> [--only fig-L16,...] [--force] [--check]
 *
 * --check は宣言の検査だけ(ブラウザを起動しない。figure-planner の自己検算用)。
 *
 * 図解1つを小さな HTML(GSAP タイムライン・paused・決定論)として組み、Playwright で
 * 24fps の各フレームへシークして透過PNGを撮る。下の映像を暗くする層も一緒に焼くので、
 * assemble は字幕と同じ overlay 経路で重ねるだけでよい。
 *
 * 出力: h3/episodes/<epId>/figures/<id>/f%05d.png と figures/index.json
 * 設計: docs/superpowers/specs/2026-09-04-h3-figure-overlay-design.md
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { resolveChromePath } from "../composition-dom";
import { OUT_FPS, ROOT } from "./config";
import {
  DEFAULT_DIM, FADE_SEC, figureHash, figureItems, figureReveals, figureWindow, typeRuns, validateFigure,
} from "./figures";
import { buildSegments } from "./assemble";
import { createHash } from "node:crypto";
import type { Figure, FigureIndex, FigureIndexEntry, FigureLine, FiguresFile, GridFigure, Reveals } from "./figures";
import type { CutsFile } from "./types";

const W = 1920;
const H = 1080;
const COLORS: Record<string, string> = {
  paper: "#F4F1E7", ink: "#1B1A17", indigo: "#37416B", red: "#C6382C", yellow: "#E7B23A",
};

export function figuresPath(epId: string): string {
  return join(ROOT, "h3/episodes", epId, "figures.json");
}
export function figuresDir(epId: string): string {
  return join(ROOT, "h3/episodes", epId, "figures");
}
export function figureIndexPath(epId: string): string {
  return join(figuresDir(epId), "index.json");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const BOWL_SVG = `<svg viewBox="0 0 64 64" width="100%" height="100%"><path d="M8 28 H56 Q56 52 32 54 Q8 52 8 28 Z" fill="#F4F1E7" stroke="#1B1A17" stroke-width="4" stroke-linejoin="round"/><path d="M10 28 Q32 10 54 28" fill="#E7B23A" stroke="#1B1A17" stroke-width="4"/><path d="M20 24 q6 -6 12 0 q6 -6 12 0" fill="none" stroke="#C6382C" stroke-width="3"/></svg>`;
const OTTER_SVG = `<svg viewBox="0 0 64 64" width="100%" height="100%"><ellipse cx="32" cy="36" rx="20" ry="16" fill="#8B6B4A" stroke="#1B1A17" stroke-width="4"/><circle cx="32" cy="20" r="11" fill="#8B6B4A" stroke="#1B1A17" stroke-width="4"/><circle cx="27" cy="18" r="2" fill="#1B1A17"/><circle cx="37" cy="18" r="2" fill="#1B1A17"/><ellipse cx="32" cy="24" rx="3" ry="2" fill="#1B1A17"/></svg>`;

const SCALE_ICONS: Record<string, string> = {
  none: "",
  hand: `<svg viewBox="0 0 64 64"><path d="M20 58 V30 a4 4 0 0 1 8 0 V24 a4 4 0 0 1 8 0 V26 a4 4 0 0 1 8 0 V32 a4 4 0 0 1 8 0 V46 c0 8-6 12-14 12 Z M20 40 l-8-10 a3 3 0 0 1 5-4 l3 4" fill="#F4F1E7" stroke="#1B1A17" stroke-width="3" stroke-linejoin="round"/></svg>`,
  bottle: `<svg viewBox="0 0 64 64"><path d="M26 6 h12 v8 l6 8 v34 a4 4 0 0 1-4 4 H24 a4 4 0 0 1-4-4 V22 l6-8 Z" fill="#F4F1E7" stroke="#1B1A17" stroke-width="3" stroke-linejoin="round"/><rect x="24" y="30" width="16" height="14" fill="#E7B23A" stroke="#1B1A17" stroke-width="2"/></svg>`,
  pole: `<svg viewBox="0 0 64 64"><rect x="29" y="4" width="6" height="56" fill="#F4F1E7" stroke="#1B1A17" stroke-width="3"/><rect x="14" y="10" width="36" height="5" fill="#F4F1E7" stroke="#1B1A17" stroke-width="3"/><rect x="18" y="20" width="28" height="5" fill="#F4F1E7" stroke="#1B1A17" stroke-width="3"/></svg>`,
  human: `<svg viewBox="0 0 64 64"><circle cx="32" cy="12" r="8" fill="#F4F1E7" stroke="#1B1A17" stroke-width="3"/><path d="M32 20 v22 M32 26 l-12 10 M32 26 l12 10 M32 42 l-10 18 M32 42 l10 18" fill="none" stroke="#1B1A17" stroke-width="4" stroke-linecap="round"/></svg>`,
  otter: OTTER_SVG,
};

function gridCells(fig: GridFigure): { cls: string; color: string; seg?: number }[] {
  const total = fig.total ?? 100;
  const cells: { cls: string; color: string; seg?: number }[] = [];
  if (fig.segments) {
    fig.segments.forEach((s, si) => {
      for (let i = 0; i < s.count; i++) cells.push({ cls: "cell on", color: COLORS[s.color ?? "indigo"] ?? s.color ?? COLORS.indigo, seg: si });
    });
    while (cells.length < total) cells.push({ cls: "cell on rest", color: COLORS.paper });
  } else {
    const k = fig.highlight ?? 0;
    for (let i = 0; i < total; i++) {
      const hot = i < k;
      cells.push({ cls: "cell on" + (hot ? (fig.mode === "remove" ? " gone" : " hot") : ""), color: hot ? COLORS.red : COLORS.paper });
    }
  }
  return cells;
}

/** 図解1つぶんの HTML。テストしやすいよう純粋に文字列を返す */
export function buildFigureHtml(fig: Figure, durationSec: number, assets: { fontUrl: string; gsapUrl: string }, reveals?: Reveals): string {
  const dim = fig.dim ?? DEFAULT_DIM;
  // 各項目を出す瞬間(窓の頭からの秒)。宣言の atPhrase から figures.ts が決める。無ければ型ごとの間隔
  const rv = reveals ?? { items: figureItems(fig).map((_, i) => i * 0.45) };
  const at = (i: number): string => ` data-at="${(rv.items[i] ?? 0).toFixed(3)}"`;
  let body = "";
  if (fig.type === "bars") {
    const max = Math.max(...fig.items.map((i) => i.value));
    // 板の内側(1440 - 枠12 - 余白112 = 1316)から、ラベル列(440)と最長の数値文字(64px × 文字数)を引いた残りが棒の最大長
    const longestVal = Math.max(...fig.items.map((i) => i.display.length));
    const maxBar = Math.min(820, 1316 - 440 - 30 - Math.ceil(longestVal * 62));
    body = `<div class="bars">` + fig.items.map((it, i) => {
      const w = Math.max(10, Math.round((it.value / max) * maxBar));
      return `<div class="row"${at(i)}><div class="label">${esc(it.label)}</div><div class="track"><div class="fill${it.accent ? " accent" : ""}" data-w="${w}"></div><div class="val${it.accent ? " accent" : ""}">${esc(it.display)}</div></div></div>`;
    }).join("") + `</div>`;
  } else if (fig.type === "grid") {
    const cells = gridCells(fig);
    const total = fig.total ?? 100;
    const cols = total <= 40 ? 8 : 10;
    const size = total <= 40 ? 108 : 54;
    const icon = fig.icon === "bowl" ? BOWL_SVG : fig.icon === "otter" ? OTTER_SVG : "";
    const legend = fig.segments
      ? `<div class="legend">` + fig.segments.map((s, i) => `<div class="li seg"${at(i)}><span class="chip" style="background:${COLORS[s.color ?? "indigo"] ?? s.color}"></span>${esc(s.label)}<b>${s.count}%</b></div>`).join("") + `</div>`
      : fig.highlightLabel ? `<div class="legend"><div class="li"><span class="chip" style="background:${COLORS.red}"></span>${esc(fig.highlightLabel)}</div></div>` : "";
    // 粒の図解は板が縦に長いので、一言は下ではなく右の列に置く(字幕帯と離す)
    const sideCaption = fig.caption ? `<div class="caption side"${rv.caption === undefined ? "" : ` data-at="${rv.caption.toFixed(3)}"`}>${esc(fig.caption)}</div>` : "";
    body = `<div class="gridwrap"><div class="grid" style="grid-template-columns:repeat(${cols},${size}px)">`
      + cells.map((c) => `<div class="${c.cls}"${c.seg === undefined ? "" : at(c.seg)} style="width:${size - 8}px;height:${size - 8}px;${icon ? "" : "background:" + c.color}">${icon}</div>`).join("")
      + `</div><div class="side">${legend}${sideCaption}</div></div>`;
  } else if (fig.type === "recap") {
    body = `<div class="recap">` + fig.items.map((it, i) => `<div class="ri${it.now ? " now" : ""}"${at(i)}><span class="stamp">${it.now ? "＋" : "✓"}</span><span class="rl">${esc(it.label)}</span><span class="rt">${esc(it.text)}</span></div>`).join("") + `</div>`;
  } else if (fig.type === "timeline") {
    const n = fig.events.length;
    const pos = (e: import("./figures").TimelineEvent, i: number) => e.pos ?? (n === 1 ? 0.5 : i / (n - 1));
    body = `<div class="tl"><div class="tl-line"></div>` + fig.events.map((e, i) => {
      const x = 11 + pos(e, i) * 78;
      return `<div class="ev${e.accent ? " accent" : ""}"${at(i)} style="left:${x.toFixed(1)}%"><div class="tick"></div><div class="at">${esc(e.at)}</div><div class="ev-label">${esc(e.label)}</div></div>`;
    }).join("") + `</div>`;
  } else if (fig.type === "scale") {
    const max = Math.max(...fig.items.map((i) => i.size));
    body = `<div class="scale">` + fig.items.map((it, i) => {
      const w = Math.max(24, Math.round((it.size / max) * 560));
      const h = Math.max(24, Math.round((it.size / max) * 300));
      const icon = SCALE_ICONS[it.icon ?? "none"] ?? "";
      return `<div class="sc"${at(i)}><div class="blob${it.accent ? " accent" : ""}" data-w="${w}" data-h="${h}" style="width:${w}px;height:${h}px">${icon}</div><div class="sc-val${it.accent ? " accent" : ""}">${esc(it.display)}</div><div class="sc-label">${esc(it.label)}</div></div>`;
    }).join("") + `</div>`;
  }
  const capAt = rv.caption === undefined ? "" : ` data-at="${rv.caption.toFixed(3)}"`;
  const caption = fig.caption && fig.type !== "grid" ? `<div class="caption"${capAt}>${esc(fig.caption)}</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Yusei Magic";src:url("${assets.fontUrl}")}
html,body{margin:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden}
*{box-sizing:border-box}
.dim{position:absolute;inset:0;background:#000;opacity:0}
.panel{position:absolute;left:50%;top:110px;width:1440px;transform:translateX(-50%) rotate(-0.5deg);opacity:0;
  background:${COLORS.paper};border:6px solid ${COLORS.ink};border-radius:30px 24px 32px 26px / 26px 32px 24px 30px;
  padding:34px 56px 40px;font-family:"Yusei Magic",sans-serif;color:${COLORS.ink};
  box-shadow:10px 12px 0 rgba(27,26,23,.35)}
.title{font-size:58px;line-height:1.2;margin-bottom:22px;letter-spacing:.02em}
.caption{font-size:44px;margin-top:22px;color:${COLORS.red};text-align:right}
.bars .row{display:flex;align-items:center;margin:18px 0}
.bars .label{flex:0 0 440px;font-size:42px;line-height:1.2;padding-right:20px}
.bars .track{flex:1;display:flex;align-items:center;height:96px}
.bars .fill{height:70px;width:0;background:${COLORS.indigo};border:5px solid ${COLORS.ink};border-radius:14px 10px 12px 16px}
.bars .fill.accent{background:${COLORS.red}}
.bars .val{font-size:64px;margin-left:22px;white-space:nowrap;opacity:0}
.bars .val.accent{color:${COLORS.red}}
.gridwrap{display:flex;align-items:center;gap:48px}
.grid{display:grid;gap:8px;justify-content:start}
.cell{border:4px solid ${COLORS.ink};border-radius:50%;transform:scale(0);display:flex;align-items:center;justify-content:center;overflow:hidden}
.cell:has(svg){border:0;border-radius:0}
.side{flex:1;display:flex;flex-direction:column;justify-content:center;gap:24px}
.legend{font-size:44px;line-height:1.3}
.recap .ri{display:flex;align-items:baseline;gap:22px;font-size:46px;line-height:1.3;margin:14px 0;opacity:0;transform:translateX(-20px)}
.recap .ri.now{color:${COLORS.red}}
.recap .stamp{font-size:52px;width:64px;text-align:center}
.recap .rl{flex:0 0 300px}
.recap .rt{flex:1}
.tl{position:relative;height:330px;margin-top:40px}
.tl-line{position:absolute;left:11%;right:11%;top:150px;height:8px;background:${COLORS.ink};border-radius:4px;transform-origin:left center;transform:scaleX(0)}
.ev{position:absolute;top:0;width:280px;margin-left:-140px;text-align:center;opacity:0;transform:translateY(16px)}
.ev .tick{width:34px;height:34px;border:6px solid ${COLORS.ink};border-radius:50%;background:${COLORS.indigo};margin:132px auto 0}
.ev.accent .tick{background:${COLORS.red}}
.ev .at{position:absolute;top:70px;left:0;right:0;font-size:40px}
.ev .ev-label{font-size:42px;line-height:1.2;margin-top:14px}
.ev.accent .ev-label{color:${COLORS.red}}
.scale{display:flex;align-items:flex-end;justify-content:space-around;gap:40px;min-height:420px}
.sc{display:flex;flex-direction:column;align-items:center;gap:12px}
.blob{background:${COLORS.indigo};border:5px solid ${COLORS.ink};border-radius:38% 42% 40% 44% / 44% 40% 42% 38%;transform:scale(0);transform-origin:bottom center;display:flex;align-items:center;justify-content:center;overflow:hidden}
.blob.accent{background:${COLORS.red}}
.blob svg{width:80%;height:80%}
.sc-val{font-size:60px;opacity:0}
.sc-val.accent{color:${COLORS.red}}
.sc-label{font-size:40px}
.caption.side{margin-top:0;text-align:left;font-size:46px;white-space:nowrap}
.legend .li{display:flex;align-items:center;gap:16px;margin:12px 0}
.legend b{margin-left:auto;font-size:58px}
.chip{display:inline-block;width:40px;height:40px;border:4px solid ${COLORS.ink};border-radius:50%}
</style></head><body>
<div class="dim"></div>
<div class="panel"><div class="title">${esc(fig.title)}</div>${body}${caption}</div>
<script src="${assets.gsapUrl}"></script>
<script>
(function(){
  var D=${durationSec.toFixed(3)}, F=${FADE_SEC}, DIM=${dim};
  var tl=gsap.timeline({paused:true});
  tl.to(".dim",{opacity:DIM,duration:F,ease:"none"},0);
  tl.to(".panel",{opacity:1,y:0,duration:F,ease:"power2.out"},0);
  gsap.set(".panel",{y:28});
  // 各項目は data-at(窓の頭からの秒。ナレーションがその数字を言う句)に置く。板の出現(F)より前には出さない。
  // 尺に合わせて縮めない — 縮めると句とずれる。窓の尻に食い込まないことは figures.ts の検査が担保する
  var c=gsap.timeline();
  function atOf(el){ var v=parseFloat(el.getAttribute("data-at")); if(isNaN(v)) v=0; return Math.max(F, Math.min(v, Math.max(F, D-F-0.3))); }
  document.querySelectorAll(".bars .row").forEach(function(row){
    var t=atOf(row), el=row.querySelector(".fill"), w=+el.getAttribute("data-w");
    c.to(el,{width:w,duration:0.8,ease:"power2.out"},t);
    c.to(row.querySelector(".val"),{opacity:1,duration:0.25},t+0.3);
  });
  var cells=document.querySelectorAll(".cell");
  if(cells.length){
    var per=Math.min(0.06,1.6/cells.length);
    var groups={};
    cells.forEach(function(el){ var k=el.hasAttribute("data-at")?atOf(el).toFixed(3):"base"; (groups[k]=groups[k]||[]).push(el); });
    Object.keys(groups).forEach(function(k){
      var t=k==="base"?F:parseFloat(k);
      c.to(groups[k],{scale:1,duration:0.3,ease:"back.out(2)",stagger:Math.min(per,1.2/groups[k].length)},t);
    });
    var gone=document.querySelectorAll(".cell.gone");
    if(gone.length){ c.to(gone,{opacity:0.12,scale:0.5,duration:0.25,stagger:Math.min(0.04,1.4/gone.length)},F+cells.length*per+0.5); }
    document.querySelectorAll(".legend .li.seg").forEach(function(li){ gsap.set(li,{opacity:0}); c.to(li,{opacity:1,duration:0.3},atOf(li)); });
  }
  document.querySelectorAll(".recap .ri").forEach(function(el){ c.to(el,{opacity:1,x:0,duration:0.45,ease:"power2.out"},atOf(el)); });
  var line=document.querySelector(".tl-line");
  if(line){
    c.to(line,{scaleX:1,duration:1.2,ease:"power2.inOut"},F);
    document.querySelectorAll(".ev").forEach(function(el){ c.to(el,{opacity:1,y:0,duration:0.4,ease:"power2.out"},atOf(el)); });
  }
  document.querySelectorAll(".scale .sc").forEach(function(sc){
    var t=atOf(sc);
    c.to(sc.querySelector(".blob"),{scale:1,duration:0.7,ease:"back.out(1.4)"},t);
    c.to(sc.querySelector(".sc-val"),{opacity:1,duration:0.25},t+0.4);
  });
  document.querySelectorAll(".caption[data-at]").forEach(function(el){ gsap.set(el,{opacity:0}); c.to(el,{opacity:1,duration:0.3},atOf(el)); });
  tl.add(c,0);
  tl.to([".dim",".panel"],{opacity:0,duration:F,ease:"none"},Math.max(F,D-F));
  window.__timelines={figure:tl};
  window.__figureReady=true;
})();
</script></body></html>`;
}

/**
 * 章カード。**H3 に文字を描かせない**(2026-09-05)。
 * H3 生成のカードは ep026 で2回・ep027 で3回、1コマ目に「ペンを持つ人の手」が湧き、seed を振っても再発した
 * (否定形は効かない・文字は手を呼ぶ)。cuts.json の `card: [番号, 章名]` から不透明な紙の板を機械で焼き、
 * 生成クリップの上に全面で重ねる。全コマ同一・決定論。下のクリップは何が出ていても見えない。
 */
export function buildCardHtml(num: string, name: string, assets: { fontUrl: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Yusei Magic";src:url("${assets.fontUrl}")}
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:${COLORS.paper}}
*{box-sizing:border-box}
.card{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding-bottom:90px;font-family:"Yusei Magic",sans-serif;color:${COLORS.ink};text-align:center}
.num{font-size:72px;letter-spacing:.12em;margin-bottom:28px}
.rule{width:220px;height:8px;background:${COLORS.ink};border-radius:4px;transform:rotate(-0.6deg);margin-bottom:44px}
.name{font-size:112px;line-height:1.25;max-width:1600px;letter-spacing:.02em}
</style></head><body>
<div class="card"><div class="num">${esc(num)}</div><div class="rule"></div><div class="name">${esc(name)}</div></div>
<script>window.__figureReady=true;</script>
</body></html>`;
}

export function cardHash(num: string, name: string, startFrame: number, frames: number): string {
  return createHash("sha1").update(JSON.stringify({ card: [num, name], startFrame, frames, v: 1 })).digest("hex").slice(0, 12);
}

/** 各図解の 3/4 地点のフレームを灰色の下地に載せて1枚に並べる(工程12の目視用) */
async function writeContactSheet(epId: string, entries: FigureIndexEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const cw = 640, ch = 360, cols = 3;
  const rows = Math.ceil(entries.length / cols);
  const tiles = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const src = join(e.dir, "f" + String(Math.floor(e.frames * 0.75)).padStart(5, "0") + ".png");
    // sharp は resize を composite より先に適用するので、合成と縮小は2段に分ける
    const full = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 120, g: 150, b: 160, alpha: 1 } } })
      .composite([{ input: src }]).png().toBuffer();
    const buf = await sharp(full).resize(cw, ch).png().toBuffer();
    tiles.push({ input: buf, left: (i % cols) * cw, top: Math.floor(i / cols) * ch });
  }
  await sharp({ create: { width: cols * cw, height: rows * ch, channels: 3, background: { r: 60, g: 60, b: 60 } } })
    .composite(tiles).jpeg({ quality: 85 }).toFile(join(figuresDir(epId), "contact.jpg"));
}

interface Options { epId: string; only: Set<string> | null; force: boolean; check: boolean }

function parseArgs(argv: string[]): Options {
  const [epId, ...rest] = argv;
  if (!epId) throw new Error("使い方: npm run h3:figures -- <epId> [--only a,b] [--force]");
  const o: Options = { epId, only: null, force: false, check: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--only") o.only = new Set((rest[++i] ?? "").split(",").filter(Boolean));
    else if (rest[i] === "--force") o.force = true;
    else if (rest[i] === "--check") o.check = true;
    else throw new Error("不明な引数: " + rest[i]);
  }
  return o;
}

function readIndex(epId: string): FigureIndex | null {
  const p = figureIndexPath(epId);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as FigureIndex) : null;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const { epId } = opts;
  const fPath = figuresPath(epId);
  if (!existsSync(fPath)) throw new Error("figures.json がありません: " + fPath);
  const file = JSON.parse(readFileSync(fPath, "utf8")) as FiguresFile;
  const timing = JSON.parse(readFileSync(join(ROOT, "episodes", epId, "timing.json"), "utf8")) as { totalDurationSec: number; lines: FigureLine[] };
  const cutsFile = JSON.parse(readFileSync(join(ROOT, "h3/episodes", epId, "cuts.json"), "utf8")) as CutsFile;
  const lineById = new Map(timing.lines.map((l) => [l.lineId, l]));

  const problems = file.figures.flatMap((f) => validateFigure(f, lineById, cutsFile.cuts));
  const ids = new Set<string>();
  for (const f of file.figures) {
    if (ids.has(f.id)) problems.push("id が重複: " + f.id);
    ids.add(f.id);
  }
  if (problems.length > 0) {
    for (const m of problems) console.error("❌ " + m);
    process.exit(1);
  }
  {
    const windows = file.figures.map((f) => ({ f, w: figureWindow(f, lineById, timing.totalDurationSec) })).sort((a, b) => a.w.fromSec - b.w.fromSec);
    for (let i = 1; i < windows.length; i++) {
      if (windows[i].w.fromSec < windows[i - 1].w.toSec) {
        console.error("❌ 図解の窓が重なっています: " + windows[i - 1].f.id + " と " + windows[i].f.id);
        process.exit(1);
      }
    }
    const perMin = file.figures.length / (timing.totalDurationSec / 60);
    console.log("図解 " + file.figures.length + "本 / " + (timing.totalDurationSec / 60).toFixed(1) + "分(" + perMin.toFixed(2) + "本/分)"
      + (file.figures.length === 0 ? " ⚠️ 0本(数字の行が無い台本は稀。宣言漏れを疑う)" : ""));
    for (const { f, w } of windows) {
      console.log("  " + f.id + " " + f.type + " " + w.fromSec.toFixed(1) + "→" + w.toSec.toFixed(1) + "秒 「" + f.title + "」");
      // 各項目が出る絶対秒と、留めた句の文面(先バレの目視確認用)
      const r = figureReveals(f, lineById, w);
      figureItems(f).forEach((it, i) => {
        const label = (it as { display?: string; label?: string; at?: string }).display ?? (it as { at?: string }).at ?? (it as { label?: string }).label ?? "";
        const line = lineById.get(it.atLineId ?? f.lineId);
        const phrase = it.atPhrase === undefined ? "(留めなし・前の項目の直後)" : "「" + (line?.phrases?.[it.atPhrase]?.text ?? "?") + "」";
        console.log("      " + (w.fromSec + r.items[i]).toFixed(1) + "秒 " + label + " " + phrase);
      });
    }
  }
  {
    const runs = typeRuns(file.figures.map((f) => ({ f, w: figureWindow(f, lineById, timing.totalDurationSec) }))
      .sort((a, b) => a.w.fromSec - b.w.fromSec).map((x) => x.f.type));
    for (const r of runs) {
      if (r.count >= 3) console.log("  ⚠️ 同じ型 " + r.type + " が " + r.count + " 本続く(体長・重さは scale、期間は timeline を検討。figure-planner 手順3)");
    }
  }
  // 章カード(cuts.json の card)。宣言は要らず、カットの受け持ち区間がそのまま窓になる
  const segments = buildSegments(cutsFile.cuts, timing.lines, timing.totalDurationSec, OUT_FPS);
  const cards = segments.flatMap((s) => {
    const c = cutsFile.cuts[s.clipId]?.card;
    return c ? [{ segment: s, num: c[0], name: c[1] }] : [];
  });
  console.log("章カード " + cards.length + "本(cuts.json の card から機械で焼く。H3 の文字は使わない)");
  for (const c of cards) console.log("  card-" + c.segment.clipId + " " + c.segment.startSec.toFixed(1) + "秒〜 " + c.segment.frames + "F 「" + c.num + " / " + c.name + "」");
  if (opts.check) { console.log("✅ 宣言の検査OK(--check なので焼いていません)"); return; }

  const prev = readIndex(epId);
  const prevById = new Map((prev?.entries ?? []).map((e) => [e.id, e]));
  const fontUrl = pathToFileURL(join(ROOT, "assets/fonts/YuseiMagic-Regular.ttf")).href;
  const gsapUrl = pathToFileURL(join(ROOT, "assets/vendor/gsap.min.js")).href;
  mkdirSync(figuresDir(epId), { recursive: true });

  const entries: FigureIndexEntry[] = [];
  let browser: import("playwright-core").Browser | null = null;
  try {
    for (const fig of file.figures) {
      const win = figureWindow(fig, lineById, timing.totalDurationSec);
      const startFrame = Math.round(win.fromSec * OUT_FPS);
      const frames = Math.round(win.toSec * OUT_FPS) - startFrame;
      const hash = figureHash(fig, OUT_FPS, win);
      const dir = join(figuresDir(epId), fig.id);
      const entry: FigureIndexEntry = { id: fig.id, dir, startFrame, frames, hash };
      const old = prevById.get(fig.id);
      const have = existsSync(dir) ? readdirSync(dir).filter((n) => /^f\d{5}\.png$/.test(n)).length : 0;
      const skip = !opts.force && old && old.hash === hash && have === frames && !(opts.only && opts.only.has(fig.id));
      if (opts.only && !opts.only.has(fig.id) && old) { entries.push(old); continue; }
      if (skip) { console.log("  " + fig.id + ": 焼き済み(" + frames + "F)"); entries.push(entry); continue; }

      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const html = buildFigureHtml(fig, frames / OUT_FPS, { fontUrl, gsapUrl }, figureReveals(fig, lineById, win));
      const htmlPath = join(dir, "figure.html");
      writeFileSync(htmlPath, html);
      browser ??= await chromium.launch({ executablePath: resolveChromePath(ROOT), args: ["--mute-audio"] });
      const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      const t0 = Date.now();
      try {
        await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 60000 });
        await page.waitForFunction("window.__figureReady === true", undefined, { timeout: 30000 });
        await page.evaluate("document.fonts.ready.then(function(){return true})");
        for (let i = 0; i < frames; i++) {
          const t = i / OUT_FPS;
          await page.evaluate(`(function(){var tl=window.__timelines.figure;tl.pause();tl.totalTime(${t}+0.001,true);tl.totalTime(${t},false);if(window.gsap&&gsap.ticker){gsap.ticker.tick();gsap.ticker.sleep();}})()`);
          await page.screenshot({ path: join(dir, "f" + String(i).padStart(5, "0") + ".png"), omitBackground: true, animations: "disabled" });
        }
      } finally {
        await page.close();
      }
      console.log("  " + fig.id + ": " + frames + "F(" + win.fromSec.toFixed(2) + "→" + win.toSec.toFixed(2) + "秒)" + " " + ((Date.now() - t0) / 1000).toFixed(1) + "秒");
      entries.push(entry);
    }
    for (const c of cards) {
      const id = "card-" + c.segment.clipId;
      const startFrame = c.segment.offsetFrames;
      const frames = c.segment.frames;
      const hash = cardHash(c.num, c.name, startFrame, frames);
      const dir = join(figuresDir(epId), id);
      const entry: FigureIndexEntry = { id, kind: "card", dir, startFrame, frames, hash };
      const old = prevById.get(id);
      const have = existsSync(dir) ? readdirSync(dir).filter((n) => /^f\d{5}\.png$/.test(n)).length : 0;
      if (opts.only && !opts.only.has(id) && old) { entries.push(old); continue; }
      if (!opts.force && old && old.hash === hash && have === frames && !(opts.only && opts.only.has(id))) {
        console.log("  " + id + ": 焼き済み(" + frames + "F)"); entries.push(entry); continue;
      }
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const htmlPath = join(dir, "card.html");
      writeFileSync(htmlPath, buildCardHtml(c.num, c.name, { fontUrl }));
      browser ??= await chromium.launch({ executablePath: resolveChromePath(ROOT), args: ["--mute-audio"] });
      const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      const t0 = Date.now();
      try {
        await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 60000 });
        await page.waitForFunction("window.__figureReady === true", undefined, { timeout: 30000 });
        await page.evaluate("document.fonts.ready.then(function(){return true})");
        // 全コマ同一。1枚撮って複製する(assemble は連番を読むので枚数はそろえる)
        const first = join(dir, "f00000.png");
        await page.screenshot({ path: first, animations: "disabled" });
        const buf = readFileSync(first);
        for (let i = 1; i < frames; i++) writeFileSync(join(dir, "f" + String(i).padStart(5, "0") + ".png"), buf);
      } finally {
        await page.close();
      }
      console.log("  " + id + ": " + frames + "F(章カード「" + c.num + " / " + c.name + "」)" + " " + ((Date.now() - t0) / 1000).toFixed(1) + "秒");
      entries.push(entry);
    }
  } finally {
    if (browser) await browser.close();
  }
  const index: FigureIndex = { episodeId: epId, fps: OUT_FPS, entries };
  writeFileSync(figureIndexPath(epId), JSON.stringify(index, null, 2) + "\n");
  await writeContactSheet(epId, entries);
  console.log("✅ figures/index.json: " + entries.length + "本(一覧: figures/contact.jpg)");
}

const isMain = process.argv[1] && /render-figures\.ts$/.test(process.argv[1]);
if (isMain) {
  main().catch((e) => { console.error("❌ " + (e as Error).message); process.exit(1); });
}
