/**
 * 「次に見る」動画の選定(終端の回遊設計)。
 *
 *   npm run next-videos episodes/<epId> [--apply] [--snapshot docs/analytics/<日付>-snapshot.json]
 *
 * 実測(docs/analytics)で平均視聴率が高いのに伸びていない回へ、伸びた回から送客する。
 * YouTube Data API には終了画面・カードの API が無いので、自動化できるのは
 *   1. 候補の選定(この道具。publish/next-videos.json に書く)
 *   2. 概要欄への「▶ 次に見る」リンクの追記(--apply。metadata.json の description)
 * まで。**終了画面の設定は人間が Studio で行う**(next-videos.json の一覧を貼るだけにしてある)。
 *
 * 選定規則: 公開済み(public)・スナップショット時点で公開後7日以上・自分以外、を
 * 平均視聴率(averageViewPercentage)の降順に並べ、上位 N 本(既定2)。
 * 直近の公開回はまだ集計されていないので候補にしない(公開後3〜4日はゼロが出る)。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const MIN_AGE_DAYS = 7;
/** これより短い動画はショートとみなして候補にしない(本編への送客が目的) */
const MIN_DURATION_SEC = 180;

export function isoDurationSec(iso: string | undefined): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
const MARK = "▶ 次に見る";

export interface SnapshotVideo {
  title: string;
  publishedAt: string;
  privacy: string;
  /** ISO 8601(PT12M34S)。ショートを除くために見る */
  duration?: string;
  summary?: { averageViewPercentage?: number; views?: number };
}
export interface Snapshot {
  fetchedAt: string;
  videos: Record<string, SnapshotVideo>;
}
export interface Pick {
  videoId: string;
  epId?: string;
  title: string;
  url: string;
  averageViewPercentage: number;
  views: number;
  publishedAt: string;
}

/** upload-result.json から epId → videoId の対応を集める */
export function collectUploads(episodesDir: string): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(episodesDir)) return m;
  for (const ep of readdirSync(episodesDir)) {
    const p = join(episodesDir, ep, "publish", "upload-result.json");
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as { videoId?: string };
      if (j.videoId) m.set(j.videoId, ep);
    } catch { /* 壊れた upload-result は無視 */ }
  }
  return m;
}

export function rankNextVideos(
  snap: Snapshot,
  selfVideoId: string | undefined,
  uploads: Map<string, string>,
  limit = 2,
): Pick[] {
  const fetched = Date.parse(snap.fetchedAt);
  const picks: Pick[] = [];
  for (const [id, v] of Object.entries(snap.videos)) {
    if (id === selfVideoId) continue;
    if (v.privacy !== "public") continue;
    if (isoDurationSec(v.duration) < MIN_DURATION_SEC) continue;
    const ageDays = (fetched - Date.parse(v.publishedAt)) / 86400000;
    if (!(ageDays >= MIN_AGE_DAYS)) continue;
    const avp = Math.min(100, v.summary?.averageViewPercentage ?? 0);
    if (avp <= 0) continue;
    picks.push({
      videoId: id, epId: uploads.get(id), title: v.title, url: "https://youtu.be/" + id,
      averageViewPercentage: avp, views: v.summary?.views ?? 0, publishedAt: v.publishedAt,
    });
  }
  picks.sort((a, b) => b.averageViewPercentage - a.averageViewPercentage || b.views - a.views);
  return picks.slice(0, limit);
}

/** 概要欄の末尾へ「▶ 次に見る」の段落を足す(既にあれば置き換える) */
export function withNextVideos(description: string, picks: Pick[]): string {
  const block = MARK + "\n" + picks.map((p) => p.title + "\n" + p.url).join("\n");
  const i = description.indexOf(MARK);
  const base = (i >= 0 ? description.slice(0, i) : description).replace(/\s+$/, "");
  return base + "\n\n" + block + "\n";
}

function latestSnapshot(): string {
  const dir = join(ROOT, "docs/analytics");
  const files = readdirSync(dir).filter((f) => /-snapshot\.json$/.test(f)).sort();
  if (files.length === 0) throw new Error("docs/analytics に *-snapshot.json がありません(fetch-all.cjs で取得する)");
  return join(dir, files[files.length - 1]);
}

function main(): void {
  const args = process.argv.slice(2);
  const epDirArg = args.find((a) => !a.startsWith("--"));
  if (!epDirArg) throw new Error("使い方: npm run next-videos episodes/<epId> [--apply] [--snapshot <path>]");
  const epDir = resolve(ROOT, epDirArg);
  const epId = basename(epDir);
  const apply = args.includes("--apply");
  const si = args.indexOf("--snapshot");
  const snapPath = si >= 0 ? resolve(ROOT, args[si + 1]) : latestSnapshot();
  const snap = JSON.parse(readFileSync(snapPath, "utf8")) as Snapshot;
  const uploads = collectUploads(join(ROOT, "episodes"));
  const selfId = [...uploads.entries()].find(([, ep]) => ep === epId)?.[0];
  const picks = rankNextVideos(snap, selfId, uploads);
  if (picks.length === 0) throw new Error("候補がありません(公開後7日以上・public・平均視聴率ありの動画が無い)");

  const outPath = join(epDir, "publish", "next-videos.json");
  const out = {
    epId, snapshot: basename(snapPath), rule: "平均視聴率の降順・公開後" + MIN_AGE_DAYS + "日以上・public・" + MIN_DURATION_SEC + "秒以上(ショート除外)・自分以外",
    picks,
    studio: "終了画面は API で設定できない。Studio → 動画 → 終了画面で、この2本を「動画」要素として置く(概要欄には --apply で追記済み)",
  };
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log("次に見る(" + basename(snapPath) + "):");
  for (const p of picks) console.log("  " + p.title + " " + p.url + "(平均視聴率 " + p.averageViewPercentage.toFixed(1) + "% / " + p.views + "再生" + (p.epId ? " / " + p.epId : "") + ")");
  console.log("→ " + outPath);

  if (apply) {
    const metaPath = join(epDir, "publish", "metadata.json");
    if (!existsSync(metaPath)) throw new Error("metadata.json がありません(publisher の後に --apply する): " + metaPath);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { description: string };
    meta.description = withNextVideos(meta.description, picks);
    if (meta.description.length > 5000) throw new Error("概要欄が 5000 字を超えます(" + meta.description.length + ")");
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
    console.log("→ metadata.json の description に「" + MARK + "」を追記(validate:metadata を通すこと)");
  }
}

const isMain = process.argv[1] && /next-videos\.ts$/.test(process.argv[1]);
if (isMain) {
  try { main(); } catch (e) { console.error("❌ " + (e as Error).message); process.exit(1); }
}
