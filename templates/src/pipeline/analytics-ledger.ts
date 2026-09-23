/**
 * 実測を全話台帳へ書き戻し、題材採点の軸が当たっているかを確かめる(成果ループ)。
 *
 *   npx tsx src/pipeline/analytics-ledger.ts <snapshot.json> <studio-content.csv> [--dry-run] [--out <md>]
 *
 * 定期実行はしない(2026-09-23 ユーザー決定)。分析のたびに手で回す。
 *
 * 1. API スナップショット(fetch-all.cjs)と Studio「コンテンツ」全期間 CSV を動画IDで結合し、
 *    channel/episode-ledger.json の各話に performance を書く(スキーマは任意フィールドの追加のみ)。
 *    - 動画ID ↔ epId は episodes/<ep>/publish/upload-result.json の videoId
 *    - 視聴回数・インプレッション・CTR・平均視聴率・登録数・収益は CSV 優先、無ければ API
 *    - 維持率 @45秒は API の維持率カーブ(elapsedVideoTimeRatio)を秒へ直して線形補間
 *    - 公開後7日未満の回は書かない(集計遅延でゼロが出る。既に書かれた値も触らない)
 * 2. docs/analytics/<asOf>-axis-check.md に
 *    - channel/backlog.md の採点5軸+計 と views・impressions の Spearman 順位相関
 *      (採点の無い回は除外し、件数を明記)
 *    - 冒頭45秒規則(cuts.json の firstWorstLineId がある回=規則の機械検査を通った回)の前後比較
 *    - 台帳のアーク型別の中央値
 *    を書く。本数が少ないので「断定できない」旨を必ず書く。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { collectUploads, isoDurationSec } from "./next-videos";
import type { Snapshot, SnapshotVideo } from "./next-videos";
import { validateLedger } from "./validate-ledger";

const ROOT = resolve(import.meta.dirname, "../..");
export const MIN_AGE_DAYS = 7;
export const AXES = ["異常", "認知", "密度", "誤解", "多様", "計"] as const;
export type Axis = (typeof AXES)[number];
export type Scores = Record<Axis, number>;

export interface Performance {
  asOf: string;
  daysSincePublish: number;
  views: number;
  impressions?: number;
  ctr?: number;
  avgViewPct?: number;
  subsPer1k?: number;
  retention45s?: number;
  revenueEst?: number;
  sources?: { snapshot: string; studioCsv?: string };
}

export interface StudioRow {
  videoId: string;
  views?: number;
  impressions?: number;
  ctr?: number;
  avgViewPct?: number;
  subsGained?: number;
  revenueEst?: number;
}

// ---------- CSV ----------

/** RFC 4180 程度の CSV パーサ(引用符・引用符内のカンマと改行・"" のエスケープ) */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

const COL = {
  views: "視聴回数",
  impressions: "サムネイルのインプレッション",
  ctr: "サムネイルのクリック率 (%)",
  avgViewPct: "平均視聴率 (%)",
  subsGained: "登録者増加数",
  revenueEst: "推定収益 (USD)",
} as const;

function num(s: string | undefined): number | undefined {
  if (s === undefined || s.trim() === "") return undefined;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Studio「コンテンツ」エクスポート → 動画ID ごとの数値(「合計」行は捨てる) */
export function parseStudioContent(text: string): Map<string, StudioRow> {
  const [header, ...rows] = parseCsv(text);
  const idx = (name: string) => header.indexOf(name);
  const m = new Map<string, StudioRow>();
  for (const r of rows) {
    const id = r[0]?.trim();
    if (!id || id === "合計") continue;
    const row: StudioRow = { videoId: id };
    for (const [k, name] of Object.entries(COL) as Array<[keyof typeof COL, string]>) {
      const i = idx(name);
      const v = i >= 0 ? num(r[i]) : undefined;
      if (v !== undefined) row[k] = v;
    }
    m.set(id, row);
  }
  return m;
}

// ---------- 数値 ----------

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** 維持率カーブの sec 秒時点の audienceWatchRatio(線形補間)。取れなければ undefined */
export function retentionAt(
  curve: NonNullable<SnapshotVideo["retention"]>,
  durationSec: number,
  sec: number,
): number | undefined {
  if (!curve || curve.length === 0 || !(durationSec > 0)) return undefined;
  const pts = [...curve].sort((a, b) => a.elapsedVideoTimeRatio - b.elapsedVideoTimeRatio);
  const t = sec / durationSec;
  if (t <= pts[0].elapsedVideoTimeRatio) return round(pts[0].audienceWatchRatio, 4);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (t <= b.elapsedVideoTimeRatio) {
      const k = (t - a.elapsedVideoTimeRatio) / (b.elapsedVideoTimeRatio - a.elapsedVideoTimeRatio);
      return round(a.audienceWatchRatio + k * (b.audienceWatchRatio - a.audienceWatchRatio), 4);
    }
  }
  return round(pts[pts.length - 1].audienceWatchRatio, 4);
}

function ranks(xs: number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

/** Spearman の順位相関(同順位は平均順位 → Pearson)。3件未満・片側が定数なら null */
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rx = ranks(xs), ry = ranks(ys);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(rx), my = mean(ry);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < rx.length; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my);
    sxx += (rx[i] - mx) ** 2;
    syy += (ry[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return round(sxy / Math.sqrt(sxx * syy), 4);
}

export function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** JST の YYYY-MM-DD */
export function jstDate(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 10);
}

// ---------- 結合 ----------

export function buildPerformance(opts: {
  snap: Snapshot;
  studio: Map<string, StudioRow>;
  /** videoId → epId */
  uploads: Map<string, string>;
  sources: { snapshot: string; studioCsv?: string };
}): { perf: Map<string, Performance>; skipped: Array<{ epId: string; reason: string }> } {
  const { snap, studio, uploads, sources } = opts;
  const fetched = Date.parse(snap.fetchedAt);
  const asOf = jstDate(snap.fetchedAt);
  const perf = new Map<string, Performance>();
  const skipped: Array<{ epId: string; reason: string }> = [];
  for (const [videoId, epId] of uploads) {
    const v = snap.videos[videoId];
    const s = studio.get(videoId);
    if (!v) { skipped.push({ epId, reason: "スナップショットに動画が無い" }); continue; }
    const days = Math.floor((fetched - Date.parse(v.publishedAt)) / 86400000);
    if (days < MIN_AGE_DAYS) { skipped.push({ epId, reason: "公開後" + MIN_AGE_DAYS + "日未満(" + days + "日)" }); continue; }
    const views = s?.views ?? v.summary?.views;
    if (views === undefined) { skipped.push({ epId, reason: "視聴回数が取れない" }); continue; }
    const p: Performance = { asOf, daysSincePublish: days, views };
    if (s?.impressions !== undefined) p.impressions = s.impressions;
    if (s?.ctr !== undefined) p.ctr = s.ctr;
    const avp = s?.avgViewPct ?? v.summary?.averageViewPercentage;
    if (avp !== undefined && avp > 0) p.avgViewPct = round(avp, 2);
    if (s?.subsGained !== undefined && s.views) p.subsPer1k = round((s.subsGained / s.views) * 1000, 2);
    else if (v.summary?.subscribersGained !== undefined && v.summary.views) {
      p.subsPer1k = round((v.summary.subscribersGained / v.summary.views) * 1000, 2);
    }
    const r45 = retentionAt(v.retention ?? [], isoDurationSec(v.duration), 45);
    if (r45 !== undefined) p.retention45s = r45;
    if (s?.revenueEst !== undefined) p.revenueEst = round(s.revenueEst, 2);
    p.sources = s ? sources : { snapshot: sources.snapshot };
    perf.set(epId, p);
  }
  skipped.sort((a, b) => a.epId.localeCompare(b.epId));
  return { perf, skipped };
}

interface LedgerEntry { epId: string; performance?: Performance; themeScores?: ThemeScores; [k: string]: unknown }
interface Ledger { episodes: LedgerEntry[] }

export function applyPerformance<L extends Ledger>(ledger: L, perf: Map<string, Performance>): { ledger: L; updated: string[] } {
  const updated: string[] = [];
  const episodes = ledger.episodes.map((e) => {
    const p = perf.get(e.epId);
    if (!p) return e;
    updated.push(e.epId);
    return { ...e, performance: p };
  });
  return { ledger: { ...ledger, episodes }, updated };
}

// ---------- 採点軸 ----------

/** channel/backlog.md の採点表から epId → 軸点。点の無い行・epId の無い行は捨てる */
export function parseBacklogScores(md: string): Map<string, Scores> {
  const m = new Map<string, Scores>();
  let header: string[] | null = null;
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) { header = null; continue; }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (!header) {
      if (AXES.every((a) => cells.includes(a)) && cells.includes("状態")) header = cells;
      continue;
    }
    const ep = /(ep\d{3}[a-z0-9-]*)/.exec(cells[header.indexOf("状態")] ?? "")?.[1];
    if (!ep) continue;
    const sc = {} as Scores;
    let ok = true;
    for (const a of AXES) {
      const v = num(cells[header.indexOf(a)]);
      if (v === undefined) { ok = false; break; }
      sc[a] = v;
    }
    if (ok) m.set(ep, sc);
  }
  return m;
}

/** 版(新しい順)ごとの採点表から、epId ごとに点が残っている最初(=最新)の版の点を採る */
export function latestScores(versions: Array<{ ref: string; md: string }>): Map<string, { scores: Scores; ref: string }> {
  const out = new Map<string, { scores: Scores; ref: string }>();
  for (const { ref, md } of versions) {
    for (const [ep, scores] of parseBacklogScores(md)) if (!out.has(ep)) out.set(ep, { scores, ref });
  }
  return out;
}

export interface ThemeScores {
  oddity: number;
  recognition: number;
  density: number;
  misconception: number;
  diversity: number;
  total: number;
  source?: string;
}
const AXIS_KEY: Record<Axis, keyof Omit<ThemeScores, "source">> = {
  異常: "oddity", 認知: "recognition", 密度: "density", 誤解: "misconception", 多様: "diversity", 計: "total",
};
export function toThemeScores(s: Scores, source?: string): ThemeScores {
  const t = {} as ThemeScores;
  for (const a of AXES) t[AXIS_KEY[a]] = s[a];
  if (source) t.source = source;
  return t;
}
export function fromThemeScores(t: ThemeScores): Scores {
  const s = {} as Scores;
  for (const a of AXES) s[a] = t[AXIS_KEY[a]];
  return s;
}

/** 台帳に themeScores の無い回にだけ書く(選定時の点を後の再採点で上書きしない) */
export function applyThemeScores<L extends Ledger>(ledger: L, found: Map<string, { scores: Scores; ref: string }>): { ledger: L; updated: string[] } {
  const updated: string[] = [];
  const episodes = ledger.episodes.map((e) => {
    const f = found.get(e.epId);
    if (e.themeScores || !f) return e;
    updated.push(e.epId);
    return { ...e, themeScores: toThemeScores(f.scores, "channel/backlog.md@" + f.ref) };
  });
  return { ledger: { ...ledger, episodes }, updated };
}

export function compareGroups(rows: Array<{ after: boolean; value: number | undefined }>): {
  before: { n: number; median?: number };
  after: { n: number; median?: number };
} {
  const pick = (after: boolean) => rows.filter((r) => r.after === after && r.value !== undefined).map((r) => r.value as number);
  const b = pick(false), a = pick(true);
  return { before: { n: b.length, median: median(b) }, after: { n: a.length, median: median(a) } };
}

// ---------- レポート ----------

export interface AxisRow {
  epId: string;
  arcType?: string;
  after45: boolean;
  scores?: Scores;
  perf: Performance;
}

const f2 = (x: number | null | undefined) => (x === null || x === undefined ? "—" : x.toFixed(2));
const fInt = (x: number | undefined) => (x === undefined ? "—" : Math.round(x).toLocaleString("en-US"));
const fPct = (x: number | undefined) => (x === undefined ? "—" : (x * 100).toFixed(1) + "%");

export function renderAxisCheck(opts: {
  asOf: string;
  sources: { snapshot: string; studioCsv?: string };
  rows: AxisRow[];
  skipped: Array<{ epId: string; reason: string }>;
}): string {
  const { asOf, sources, rows, skipped } = opts;
  const scored = rows.filter((r) => r.scores);
  const unscored = rows.length - scored.length;
  const L: string[] = [];
  L.push("# 題材採点軸と実測の突合(" + asOf + ")", "");
  L.push("元データ: `" + sources.snapshot + "`" + (sources.studioCsv ? " + `" + sources.studioCsv + "`" : "") + "。生成: `src/pipeline/analytics-ledger.ts`(手動実行)。");
  L.push("対象: 台帳に performance を書いた " + rows.length + " 本(公開後" + MIN_AGE_DAYS + "日以上)。除外 " + skipped.length + " 本(末尾に理由)。", "");
  const nAfter = rows.filter((r) => r.after45).length;
  L.push("> **本数が少なく断定できない**: 採点軸の相関は n=" + scored.length + "、冒頭45秒規則の前後比較は 前 n=" + (rows.length - nAfter) + "・後 n=" + nAfter + "。");
  L.push("> 順位相関の符号と大きさは傾向の目安であり、bible・採点基準の変更根拠にはしない(次回以降の実測で再検証する)。", "");

  L.push("## 1. 採点軸 × 実測(Spearman 順位相関)", "");
  L.push("採点は台帳の `themeScores`(`channel/backlog.md` の表 = bible §14 の5軸+計 を、点が残っている最新の版から写したもの。済みの回は再採点で帳から点が消えるため git 履歴から拾う)。採点の無い回 " + unscored + " 本は相関から除外(5軸の採点が始まったのは 2026-09-03 版からで、それ以前に選ばれた回には点が無い)。n=" + scored.length + "。", "");
  L.push("| 軸 | n | × views | × impressions |", "|---|---|---|---|");
  for (const a of AXES) {
    const pv = scored.map((r) => [r.scores![a], r.perf.views] as const);
    const pi = scored.filter((r) => r.perf.impressions !== undefined).map((r) => [r.scores![a], r.perf.impressions!] as const);
    const rv = spearman(pv.map((p) => p[0]), pv.map((p) => p[1]));
    const ri = spearman(pi.map((p) => p[0]), pi.map((p) => p[1]));
    L.push("| " + a + " | " + pv.length + " | " + f2(rv) + " | " + f2(ri) + " |");
  }
  L.push("");
  if (scored.length > 0) {
    L.push("| epId | " + AXES.join(" | ") + " | views | impressions | CTR% | 登録/1k |", "|---|" + AXES.map(() => "---").join("|") + "|---|---|---|---|");
    for (const r of [...scored].sort((a, b) => b.perf.views - a.perf.views)) {
      L.push("| " + r.epId + " | " + AXES.map((a) => String(r.scores![a])).join(" | ") + " | " + fInt(r.perf.views) + " | " + fInt(r.perf.impressions) + " | " + f2(r.perf.ctr) + " | " + f2(r.perf.subsPer1k) + " |");
    }
    L.push("");
  }

  L.push("## 2. 冒頭45秒規則の前後比較", "");
  L.push("「後」= `h3/episodes/<ep>/cuts.json` に `firstWorstLineId` がある回(bible §4 の規則を check:h3 B14 が機械検査した回)。「前」= それ以外。");
  L.push("前群は公開時期が早く(収益化前・配信テスト前の回を含む)、差は規則の効果と時期の違いが混ざる。", "");
  L.push("| 指標(中央値) | 前 n | 前 | 後 n | 後 |", "|---|---|---|---|---|");
  const metrics: Array<[string, (p: Performance) => number | undefined, (x?: number) => string]> = [
    ["維持率 @45秒", (p) => p.retention45s, fPct],
    ["views", (p) => p.views, fInt],
    ["impressions", (p) => p.impressions, fInt],
    ["CTR %", (p) => p.ctr, (x) => f2(x)],
    ["平均視聴率 %", (p) => p.avgViewPct, (x) => f2(x)],
    ["登録/1k", (p) => p.subsPer1k, (x) => f2(x)],
  ];
  for (const [name, get, fmt] of metrics) {
    const g = compareGroups(rows.map((r) => ({ after: r.after45, value: get(r.perf) })));
    L.push("| " + name + " | " + g.before.n + " | " + fmt(g.before.median) + " | " + g.after.n + " | " + fmt(g.after.median) + " |");
  }
  L.push("");

  L.push("## 3. アーク型別(台帳の arcType 先頭の型名)", "");
  L.push("| 型 | n | views 中央値 | impressions 中央値 | 維持率 @45秒 中央値 |", "|---|---|---|---|---|");
  const byArc = new Map<string, AxisRow[]>();
  for (const r of rows) {
    const k = /型[A-Z]/.exec(r.arcType ?? "")?.[0] ?? "不明";
    byArc.set(k, [...(byArc.get(k) ?? []), r]);
  }
  for (const [k, rs] of [...byArc.entries()].sort()) {
    const imp = rs.map((r) => r.perf.impressions).filter((x): x is number => x !== undefined);
    const ret = rs.map((r) => r.perf.retention45s).filter((x): x is number => x !== undefined);
    L.push("| " + k + " | " + rs.length + " | " + fInt(median(rs.map((r) => r.perf.views))) + " | " + fInt(median(imp)) + " | " + fPct(median(ret)) + " |");
  }
  L.push("");

  L.push("## 除外した回", "");
  if (skipped.length === 0) L.push("- なし");
  for (const s of skipped) L.push("- " + s.epId + ": " + s.reason);
  L.push("");
  return L.join("\n");
}

// ---------- CLI ----------

function after45Set(): Set<string> {
  const dir = join(ROOT, "h3/episodes");
  const s = new Set<string>();
  if (!existsSync(dir)) return s;
  for (const ep of readdirSync(dir)) {
    const p = join(dir, ep, "cuts.json");
    if (!existsSync(p)) continue;
    try {
      if ((JSON.parse(readFileSync(p, "utf8")) as { firstWorstLineId?: string }).firstWorstLineId) s.add(ep);
    } catch { /* 壊れた cuts.json は「前」扱い */ }
  }
  return s;
}

/** backlog.md の作業ツリー版+git 履歴の各版(新しい順) */
function backlogVersions(): Array<{ ref: string; md: string }> {
  const rel = "channel/backlog.md";
  const out: Array<{ ref: string; md: string }> = [];
  const p = join(ROOT, rel);
  if (existsSync(p)) out.push({ ref: "working-tree", md: readFileSync(p, "utf8") });
  let hashes: string[] = [];
  try {
    hashes = execFileSync("git", ["log", "--format=%h", "--", rel], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch { /* git が無ければ作業ツリーだけ */ }
  for (const h of hashes) {
    try { out.push({ ref: h, md: execFileSync("git", ["show", h + ":" + rel], { cwd: ROOT, encoding: "utf8", maxBuffer: 16 << 20 }) }); } catch { /* その版に無い */ }
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const pos = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
  if (pos.length < 2) throw new Error("使い方: npx tsx src/pipeline/analytics-ledger.ts <snapshot.json> <studio-content.csv> [--dry-run] [--out <md>]");
  const snapPath = resolve(process.cwd(), pos[0]);
  const csvPath = resolve(process.cwd(), pos[1]);
  const dry = args.includes("--dry-run");
  const oi = args.indexOf("--out");

  const snap = JSON.parse(readFileSync(snapPath, "utf8")) as Snapshot;
  const studio = parseStudioContent(readFileSync(csvPath, "utf8"));
  const uploads = collectUploads(join(ROOT, "episodes"));
  const sources = { snapshot: basename(snapPath), studioCsv: basename(csvPath) };
  const { perf, skipped } = buildPerformance({ snap, studio, uploads, sources });

  const ledgerPath = join(ROOT, "channel/episode-ledger.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
  const inLedger = new Set(ledger.episodes.map((e) => e.epId));
  const notInLedger = [...perf.keys()].filter((ep) => !inLedger.has(ep));
  const withPerf = applyPerformance(ledger, perf);
  const updated = withPerf.updated;
  const { ledger: next, updated: scoredNow } = applyThemeScores(withPerf.ledger, latestScores(backlogVersions()));

  const after = after45Set();
  const rows: AxisRow[] = next.episodes
    .filter((e) => perf.has(e.epId))
    .map((e) => ({
      epId: e.epId, arcType: e.arcType as string | undefined, after45: after.has(e.epId),
      scores: e.themeScores ? fromThemeScores(e.themeScores) : undefined, perf: perf.get(e.epId)!,
    }));
  const allSkipped = [...skipped, ...notInLedger.map((epId) => ({ epId, reason: "台帳に無い" }))];
  const asOf = jstDate(snap.fetchedAt);
  const md = renderAxisCheck({ asOf, sources, rows, skipped: allSkipped });
  const outPath = oi >= 0 ? resolve(process.cwd(), args[oi + 1]) : join(ROOT, "docs/analytics", asOf + "-axis-check.md");

  console.log("performance: " + updated.length + " 本 / 除外 " + allSkipped.length + " 本 / themeScores 新規 " + scoredNow.length + " 本 / 相関に使える採点あり " + rows.filter((r) => r.scores).length + " 本");
  if (dry) { console.log(md); return; }

  const original = readFileSync(ledgerPath, "utf8");
  writeFileSync(ledgerPath, JSON.stringify(next, null, 2) + "\n");
  const errors = validateLedger(ROOT);
  if (errors.length > 0) {
    writeFileSync(ledgerPath, original); // 契約違反なら書き戻さない
    throw new Error("台帳の検証に失敗したので元に戻した:\n  " + errors.join("\n  "));
  }
  writeFileSync(outPath, md);
  console.log("→ " + ledgerPath + "(validate:ledger 通過)");
  console.log("→ " + outPath);
}

const isMain = process.argv[1] && /analytics-ledger\.ts$/.test(process.argv[1]);
if (isMain) {
  try { main(); } catch (e) { console.error("❌ " + (e as Error).message); process.exit(1); }
}
