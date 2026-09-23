/**
 * 「次に見る」動画の選定(終端の回遊設計)。
 *
 *   npm run next-videos episodes/<epId> [--apply] [--snapshot docs/analytics/<日付>-snapshot.json]
 *
 * 実測(docs/analytics)で「見た人が登録する」回へ送客する。
 * YouTube Data API には終了画面・カードの API が無いので、自動化できるのは
 *   1. 候補の選定(この道具。publish/next-videos.json に書く)
 *   2. 概要欄への「▶ 次に見る」リンクの追記(--apply。metadata.json の description)
 * まで。**終了画面の設定は人間が Studio で行う**(next-videos.json の一覧を貼るだけにしてある)。
 *
 * 選定規則: 公開済み(public)・スナップショット時点で公開後7日以上・自分以外、を
 * **登録/1k再生(subscribersGained / views × 1000)の降順**、同点は関連動画流入比
 * (RELATED_VIDEO の再生 / 流入経路の合計)の降順に並べ、上位 N 本(既定2)。
 * 直近の公開回はまだ集計されていないので候補にしない(公開後3〜4日はゼロが出る)。
 *
 * 根拠(2026-09-18 Studio 実測・本編36本 / docs/analytics/2026-09-18-studio-report.md):
 * 平均視聴率は視聴回数と -0.82・インプレッションとも強い負の相関で、広く配信されなかった
 * 「常連だけが見た回」ほど高く出る。平均視聴率で選ぶと常連向けの回へ送ってしまい、
 * 新しく来た人を登録へ変える目的に合わない。登録/1k再生は「見た人を登録に変えた力」を直接測る。
 * 関連動画流入比が高い回は、動画から動画への連鎖で見られた実績がある(終了画面と同じ導線)。
 *
 * フォールバック: スナップショットに subscribersGained が1本も無い(古い形式)なら
 * 従来の平均視聴率の降順で選ぶ。一部の回だけ無い場合は、ある回を先に並べ無い回を後ろへ回す。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const MIN_AGE_DAYS = 7;
/**
 * 候補の公開後日数の上限。2026-09-23 に追加。登録/1k 再生はチャンネルが小さかった頃の回ほど高く出る
 * (7月の回が 8〜9)ので、直近の回を優先する。窓内の候補が limit に満たなければ全期間から補う
 */
const MAX_AGE_DAYS = 60;
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
  summary?: { averageViewPercentage?: number; views?: number; subscribersGained?: number };
  /** 維持率カーブ(elapsedVideoTimeRatio 0.01〜1.00) */
  retention?: Array<{ elapsedVideoTimeRatio: number; audienceWatchRatio: number; relativeRetentionPerformance?: number }>;
  /** 流入経路別の再生 */
  traffic?: Array<{ insightTrafficSourceType: string; views: number; estimatedMinutesWatched?: number }>;
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
  /** 登録/1k再生(データが無ければ undefined) */
  subsPer1k?: number;
  /** 関連動画流入比 0〜1(データが無ければ undefined) */
  relatedRatio?: number;
}

export type RankRule = "subsPer1k" | "averageViewPercentage";

/** 登録/1k再生。views が 0 か登録数が無ければ undefined */
export function subsPer1kOf(v: SnapshotVideo): number | undefined {
  const views = v.summary?.views ?? 0;
  const subs = v.summary?.subscribersGained;
  if (subs === undefined || !(views > 0)) return undefined;
  return Math.round((subs / views) * 1000 * 100) / 100;
}

/** 関連動画流入比。流入データが無ければ undefined */
export function relatedRatioOf(v: SnapshotVideo): number | undefined {
  const total = (v.traffic ?? []).reduce((a, t) => a + (t.views ?? 0), 0);
  if (!(total > 0)) return undefined;
  const rel = (v.traffic ?? []).filter((t) => t.insightTrafficSourceType === "RELATED_VIDEO").reduce((a, t) => a + t.views, 0);
  return Math.round((rel / total) * 1000) / 1000;
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

function eligible(snap: Snapshot, selfVideoId: string | undefined): Array<[string, SnapshotVideo]> {
  const fetched = Date.parse(snap.fetchedAt);
  return Object.entries(snap.videos).filter(([id, v]) => {
    if (id === selfVideoId) return false;
    if (v.privacy !== "public") return false;
    if (isoDurationSec(v.duration) < MIN_DURATION_SEC) return false;
    const ageDays = (fetched - Date.parse(v.publishedAt)) / 86400000;
    if (!(ageDays >= MIN_AGE_DAYS)) return false;
    return Math.min(100, v.summary?.averageViewPercentage ?? 0) > 0;
  });
}

/** どちらの基準で並べるか。候補に登録数のある回が1本も無ければ従来基準 */
export function rankRule(snap: Snapshot, selfVideoId: string | undefined): RankRule {
  return eligible(snap, selfVideoId).some(([, v]) => subsPer1kOf(v) !== undefined) ? "subsPer1k" : "averageViewPercentage";
}

export function rankNextVideos(
  snap: Snapshot,
  selfVideoId: string | undefined,
  uploads: Map<string, string>,
  limit = 2,
): Pick[] {
  const rule = rankRule(snap, selfVideoId);
  const picks: Pick[] = eligible(snap, selfVideoId).map(([id, v]) => ({
    videoId: id, epId: uploads.get(id), title: v.title, url: "https://youtu.be/" + id,
    averageViewPercentage: Math.min(100, v.summary?.averageViewPercentage ?? 0),
    views: v.summary?.views ?? 0, publishedAt: v.publishedAt,
    subsPer1k: subsPer1kOf(v), relatedRatio: relatedRatioOf(v),
  }));
  const fetched = Date.parse(snap.fetchedAt);
  const recent = picks.filter((p) => (fetched - Date.parse(p.publishedAt)) / 86400000 <= MAX_AGE_DAYS);
  if (recent.length >= limit) picks.splice(0, picks.length, ...recent);
  const byAvp = (a: Pick, b: Pick) => b.averageViewPercentage - a.averageViewPercentage || b.views - a.views;
  if (rule === "subsPer1k") {
    picks.sort((a, b) => {
      const ha = a.subsPer1k !== undefined, hb = b.subsPer1k !== undefined;
      if (ha !== hb) return ha ? -1 : 1;
      if (!ha) return byAvp(a, b);
      return b.subsPer1k! - a.subsPer1k! || (b.relatedRatio ?? 0) - (a.relatedRatio ?? 0) || b.views - a.views;
    });
  } else {
    picks.sort(byAvp);
  }
  return picks.slice(0, limit);
}

const RULE_TEXT: Record<RankRule, string> = {
  subsPer1k: "登録/1k再生の降順(同点は関連動画流入比)",
  averageViewPercentage: "平均視聴率の降順(登録数データが無いための従来基準フォールバック)",
};

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
  const rule = rankRule(snap, selfId);
  if (picks.length === 0) throw new Error("候補がありません(公開後7日以上・public・平均視聴率ありの動画が無い)");

  const outPath = join(epDir, "publish", "next-videos.json");
  const out = {
    epId, snapshot: basename(snapPath), rule: RULE_TEXT[rule] + "・公開後" + MIN_AGE_DAYS + "日以上・public・" + MIN_DURATION_SEC + "秒以上(ショート除外)・自分以外",
    picks,
    studio: "終了画面は API で設定できない。Studio → 動画 → 終了画面で、この2本を「動画」要素として置く(概要欄には --apply で追記済み)",
  };
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log("次に見る(" + basename(snapPath) + " / " + RULE_TEXT[rule] + "):");
  for (const p of picks) {
    const subs = p.subsPer1k !== undefined ? "登録/1k " + p.subsPer1k.toFixed(2) + " / " : "";
    const rel = p.relatedRatio !== undefined ? "関連流入 " + (p.relatedRatio * 100).toFixed(0) + "% / " : "";
    console.log("  " + p.title + " " + p.url + "(" + subs + rel + "平均視聴率 " + p.averageViewPercentage.toFixed(1) + "% / " + p.views + "再生" + (p.epId ? " / " + p.epId : "") + ")");
  }
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
