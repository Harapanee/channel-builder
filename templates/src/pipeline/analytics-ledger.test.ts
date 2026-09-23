import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  applyPerformance,
  buildPerformance,
  applyThemeScores,
  compareGroups,
  latestScores,
  parseBacklogScores,
  parseCsv,
  parseStudioContent,
  renderAxisCheck,
  retentionAt,
  spearman,
} from "./analytics-ledger";
import type { Snapshot } from "./next-videos";
import { validateLedger } from "./validate-ledger";

const ROOT = resolve(import.meta.dirname, "../..");

const CSV = [
  "コンテンツ,動画のタイトル,動画公開時刻,長さ,平均視聴率 (%),登録者増加数,視聴回数,推定収益 (USD),サムネイルのインプレッション,サムネイルのクリック率 (%)",
  "合計,,,,46.53,7879,1410110,1354.603,10752096,4.3",
  'vidA,"タイトル, カンマ入り","Aug 4, 2026",600,41.81,432,100000,63.366,1000000,4.67',
  'vidB,B,"Sep 9, 2026",900,37.48,,50000,,500000,',
].join("\n");

const snap: Snapshot = {
  fetchedAt: "2026-09-18T15:59:57.264Z",
  videos: {
    vidA: {
      title: "A", publishedAt: "2026-08-04T09:00:00Z", privacy: "public", duration: "PT10M",
      summary: { views: 90000, averageViewPercentage: 40, subscribersGained: 300 },
      retention: [
        { elapsedVideoTimeRatio: 0.05, audienceWatchRatio: 0.8 },
        { elapsedVideoTimeRatio: 0.1, audienceWatchRatio: 0.6 },
      ],
    },
    vidB: {
      title: "B", publishedAt: "2026-09-09T09:00:00Z", privacy: "public", duration: "PT15M",
      summary: { views: 40000, averageViewPercentage: 37, subscribersGained: 80 },
      retention: [],
    },
    vidC: {
      title: "公開直後", publishedAt: "2026-09-15T09:00:00Z", privacy: "public", duration: "PT15M",
      summary: { views: 0, averageViewPercentage: 0, subscribersGained: 0 },
    },
  },
};

test("CSV: 引用符の中のカンマを割らない", () => {
  const rows = parseCsv('a,"b, c",d\n1,2,3\n');
  assert.deepEqual(rows, [["a", "b, c", "d"], ["1", "2", "3"]]);
});

test("Studio CSV: 合計行を捨て、動画IDごとに数値を取る(空欄は undefined)", () => {
  const m = parseStudioContent(CSV);
  assert.equal(m.size, 2);
  const a = m.get("vidA")!;
  assert.equal(a.views, 100000);
  assert.equal(a.impressions, 1000000);
  assert.equal(a.ctr, 4.67);
  assert.equal(a.subsGained, 432);
  assert.equal(a.revenueEst, 63.366);
  const b = m.get("vidB")!;
  assert.equal(b.subsGained, undefined);
  assert.equal(b.ctr, undefined);
});

test("維持率カーブを秒で線形補間する", () => {
  const curve = snap.videos.vidA.retention!;
  // 600 秒の動画の 45 秒 = 比 0.075 → 0.8 と 0.6 の中間
  assert.equal(retentionAt(curve, 600, 45), 0.7);
  // 先頭点より手前は先頭点の値
  assert.equal(retentionAt(curve, 600, 10), 0.8);
  assert.equal(retentionAt([], 600, 45), undefined);
  assert.equal(retentionAt(curve, 0, 45), undefined);
});

test("Spearman: 単調なら1・逆なら-1・同順位は平均順位・3件未満は null", () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  const r = spearman([1, 1, 2, 3], [1, 2, 3, 4])!;
  assert.ok(r > 0.9 && r < 1);
  assert.equal(spearman([1, 2], [1, 2]), null);
  assert.equal(spearman([1, 1, 1], [1, 2, 3]), null);
});

test("performance: CSV を優先して結合し、公開後7日未満は除外して理由を返す", () => {
  const uploads = new Map([["vidA", "ep001-a"], ["vidB", "ep002-b"], ["vidC", "ep003-c"]]);
  const { perf, skipped } = buildPerformance({
    snap, studio: parseStudioContent(CSV), uploads,
    sources: { snapshot: "s.json", studioCsv: "c.csv" },
  });
  const a = perf.get("ep001-a")!;
  assert.equal(a.asOf, "2026-09-19"); // fetchedAt の JST 日付
  assert.equal(a.daysSincePublish, 45);
  assert.equal(a.views, 100000);
  assert.equal(a.impressions, 1000000);
  assert.equal(a.ctr, 4.67);
  assert.equal(a.avgViewPct, 41.81);
  assert.equal(a.subsPer1k, 4.32);
  assert.equal(a.retention45s, 0.7);
  assert.equal(a.revenueEst, 63.37);
  // CSV に登録数が無い回はスナップショットから
  const b = perf.get("ep002-b")!;
  assert.equal(b.subsPer1k, 2);
  assert.equal(b.retention45s, undefined);
  assert.equal(b.revenueEst, undefined);
  assert.ok(!perf.has("ep003-c"));
  assert.deepEqual(skipped.map((s) => s.epId), ["ep003-c"]);
  assert.match(skipped[0].reason, /7日未満/);
});

test("台帳への書き込み: 既存フィールドを保ち performance だけ置き換える・対象外の回は触らない", () => {
  const ledger = {
    episodes: [
      { epId: "ep001-a", subject: "A", arcType: "型A", signatures: [], motifs: [], performance: { asOf: "old", daysSincePublish: 1, views: 1 } },
      { epId: "ep003-c", subject: "C", arcType: "型B", signatures: [], motifs: [], performance: { asOf: "keep", daysSincePublish: 9, views: 5 } },
    ],
  };
  const perf = new Map([["ep001-a", { asOf: "2026-09-19", daysSincePublish: 45, views: 100000 }]]);
  const { ledger: out, updated } = applyPerformance(ledger, perf);
  assert.deepEqual(updated, ["ep001-a"]);
  assert.equal(out.episodes[0].performance!.views, 100000);
  assert.equal(out.episodes[0].subject, "A");
  assert.equal(out.episodes[1].performance!.asOf, "keep");
});

test("performance を持つ台帳がスキーマ(validate:ledger)を通る", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  mkdirSync(join(dir, "channel"));
  mkdirSync(join(dir, "src/schemas"), { recursive: true });
  copyFileSync(join(ROOT, "src/schemas/episode-ledger.schema.json"), join(dir, "src/schemas/episode-ledger.schema.json"));
  const ep = {
    epId: "ep001-a", subject: "A", arcType: "型A", signatures: [], motifs: [],
    performance: {
      asOf: "2026-09-19", daysSincePublish: 45, views: 100000, impressions: 1000000, ctr: 4.67,
      avgViewPct: 41.81, subsPer1k: 4.32, retention45s: 0.7, revenueEst: 63.37,
      sources: { snapshot: "s.json", studioCsv: "c.csv" },
    },
  };
  writeFileSync(join(dir, "channel/episode-ledger.json"), JSON.stringify({ episodes: [ep] }));
  assert.deepEqual(validateLedger(dir), []);
  // 未知のフィールドは弾く(契約の追加のみ・緩めない)
  writeFileSync(join(dir, "channel/episode-ledger.json"), JSON.stringify({ episodes: [{ ...ep, performance: { ...ep.performance, foo: 1 } }] }));
  assert.ok(validateLedger(dir).length > 0);
});

test("backlog の採点表から epId ごとの軸点を取る(点の無い行・epId の無い行は捨てる)", () => {
  const md = [
    "| 順位 | 題材 | 異常 | 認知 | 密度 | 誤解 | 多様 | 計 | 状態 |",
    "|---|---|---|---|---|---|---|---|---|",
    "| 1 | ウーパールーパー | 9 | 9 | 8 | 9 | 10 | 45 | 制作中(ep027-axolotl) |",
    "| 2 | カモノハシ | 9 | 9 | 8 | 9 | 8 | 43 | 済(ep028-platypus) |",
    "| 20 | アンテキヌス | 5 | 3 | 10 | 8 | 7 | 33 | 候補 |",
    "| — | ラッコ | — | — | — | — | — | — | 制作中(ep026-sea-otter) |",
  ].join("\n");
  const m = parseBacklogScores(md);
  assert.deepEqual([...m.keys()], ["ep027-axolotl", "ep028-platypus"]);
  assert.deepEqual(m.get("ep028-platypus"), { 異常: 9, 認知: 9, 密度: 8, 誤解: 9, 多様: 8, 計: 43 });
});

test("前後比較: 群ごとの件数と中央値", () => {
  const rows = [
    { epId: "a", after: false, v: 10 }, { epId: "b", after: false, v: 30 },
    { epId: "c", after: true, v: 20 }, { epId: "d", after: true, v: undefined },
  ];
  const g = compareGroups(rows.map((r) => ({ after: r.after, value: r.v })));
  assert.deepEqual(g, { before: { n: 2, median: 20 }, after: { n: 1, median: 20 } });
});

test("axis-check.md: 件数と「本数が少なく断定できない」を必ず書き、除外件数を明記する", () => {
  const md = renderAxisCheck({
    asOf: "2026-09-19",
    sources: { snapshot: "s.json", studioCsv: "c.csv" },
    rows: [
      { epId: "ep027-a", arcType: "型B(誤解破壊)", after45: true, scores: { 異常: 9, 認知: 9, 密度: 8, 誤解: 9, 多様: 10, 計: 45 }, perf: { asOf: "x", daysSincePublish: 10, views: 3, impressions: 30, retention45s: 0.7 } },
      { epId: "ep028-b", arcType: "型A(転落)", after45: true, scores: { 異常: 8, 認知: 9, 密度: 8, 誤解: 9, 多様: 8, 計: 42 }, perf: { asOf: "x", daysSincePublish: 10, views: 2, impressions: 20, retention45s: 0.72 } },
      { epId: "ep029-c", arcType: "型B", after45: true, scores: { 異常: 7, 認知: 8, 密度: 7, 誤解: 9, 多様: 9, 計: 40 }, perf: { asOf: "x", daysSincePublish: 10, views: 1, impressions: 10 } },
      { epId: "ep010-d", arcType: "型C", after45: false, perf: { asOf: "x", daysSincePublish: 50, views: 5, impressions: 50, retention45s: 0.8 } },
    ],
    skipped: [{ epId: "ep040-x", reason: "公開後7日未満(3日)" }],
  });
  assert.match(md, /本数が少なく断定できない/);
  assert.match(md, /n=3/);
  assert.match(md, /採点の無い回 1 本は相関から除外/);
  assert.match(md, /ep040-x/);
  // 異常(9,8,7)と views(3,2,1)は完全に単調
  assert.match(md, /\| 異常 \| 3 \| 1\.00 \| 1\.00 \|/);
});

const header = "| 順位 | 題材 | 異常 | 認知 | 密度 | 誤解 | 多様 | 計 | 状態 |\n|---|---|---|---|---|---|---|---|---|\n";
test("採点の履歴: 新しい版から順に見て、点が残っている最初の版を採る(再採点で消えた済み回を拾う)", () => {
  const now = header + "| — | カモノハシ | — | — | — | — | — | — | 済(ep028-platypus) |\n| 1 | クリオネ | 8 | 9 | 7 | 10 | 9 | 43 | 候補 |";
  const older = header + "| 2 | カモノハシ | 9 | 9 | 8 | 9 | 8 | 43 | 済(ep028-platypus) |";
  const oldest = header + "| 2 | カモノハシ | 1 | 1 | 1 | 1 | 1 | 5 | 候補(ep028-platypus) |";
  const m = latestScores([{ ref: "working-tree", md: now }, { ref: "abc1234", md: older }, { ref: "def5678", md: oldest }]);
  assert.deepEqual(m.get("ep028-platypus"), { scores: { 異常: 9, 認知: 9, 密度: 8, 誤解: 9, 多様: 8, 計: 43 }, ref: "abc1234" });
});

test("台帳の themeScores: 無い回にだけ書く(選定時の点を後の再採点で上書きしない)", () => {
  const ledger = {
    episodes: [
      { epId: "ep028-platypus", subject: "カモノハシ", arcType: "型A", signatures: [], motifs: [] },
      { epId: "ep029-shoebill", subject: "ハシビロコウ", arcType: "型B", signatures: [], motifs: [],
        themeScores: { oddity: 1, recognition: 1, density: 1, misconception: 1, diversity: 1, total: 5, source: "keep" } },
    ],
  };
  const found = new Map([
    ["ep028-platypus", { scores: { 異常: 9, 認知: 9, 密度: 8, 誤解: 9, 多様: 8, 計: 43 }, ref: "abc1234" }],
    ["ep029-shoebill", { scores: { 異常: 9, 認知: 8, 密度: 7, 誤解: 9, 多様: 9, 計: 42 }, ref: "abc1234" }],
  ]);
  const { ledger: out, updated } = applyThemeScores(ledger, found);
  assert.deepEqual(updated, ["ep028-platypus"]);
  assert.deepEqual(out.episodes[0].themeScores, { oddity: 9, recognition: 9, density: 8, misconception: 9, diversity: 8, total: 43, source: "channel/backlog.md@abc1234" });
  assert.equal(out.episodes[1].themeScores!.source, "keep");
});

test("themeScores を持つ台帳がスキーマを通る", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  mkdirSync(join(dir, "channel"));
  mkdirSync(join(dir, "src/schemas"), { recursive: true });
  copyFileSync(join(ROOT, "src/schemas/episode-ledger.schema.json"), join(dir, "src/schemas/episode-ledger.schema.json"));
  const ep = { epId: "ep028-platypus", subject: "カモノハシ", arcType: "型A", signatures: [], motifs: [],
    themeScores: { oddity: 9, recognition: 9, density: 8, misconception: 9, diversity: 8, total: 43, source: "channel/backlog.md@abc1234" } };
  writeFileSync(join(dir, "channel/episode-ledger.json"), JSON.stringify({ episodes: [ep] }));
  assert.deepEqual(validateLedger(dir), []);
});
