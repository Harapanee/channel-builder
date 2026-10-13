/** Local record inventory. Every state is an observation, never a claim about the live UI now. */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { atomicJson, json, lock } from "./provenance";
export const fields = [
  "audio",
  "titleDescription",
  "thumbnail",
  "captions",
] as const;
const states = [
  "not-recorded",
  "unknown",
  "missing",
  "uploaded",
  "processing",
  "published",
  "failed",
] as const;
export function normalizeStatus(v: unknown): string {
  if (v == null) return "not-recorded";
  const s = String(v).toLowerCase();
  if (/failed|error|失敗/.test(s)) return "failed";
  if (/processing|処理中/.test(s)) return "processing";
  if (/published|公開済/.test(s)) return "published";
  if (/missing|なし|未登録/.test(s)) return "missing";
  if (/uploaded|^set$|画像あり|登録済/.test(s)) return "uploaded";
  return "unknown";
}
export interface Evidence {
  videoId: string;
  observedAt: string;
  fields: Partial<
    Record<(typeof fields)[number], { state: string; raw: string }>
  >;
  note?: string;
  source?: unknown;
  rawRows?: unknown;
  autoDub?: unknown;
}
export function validateEvidence(v: any): asserts v is Evidence {
  if (
    !v ||
    !/^[\w-]{11}$/.test(v.videoId) ||
    typeof v.observedAt !== "string" ||
    !/(Z|[+-]\d\d:\d\d)$/.test(v.observedAt) ||
    !Number.isFinite(Date.parse(v.observedAt)) ||
    Date.parse(v.observedAt) > Date.now() + 60000 ||
    !v.fields ||
    !Object.keys(v.fields).length
  )
    throw Error("invalid videoId/observedAt/fields");
  for (const [k, s] of Object.entries(v.fields) as [string, any][]) {
    if (
      !fields.includes(k as any) ||
      !s ||
      !states.includes(s.state) ||
      typeof s.raw !== "string" ||
      !s.raw.trim()
    )
      throw Error(`invalid field evidence ${k}`);
  }
}
export function recordEvidence(epDir: string, evidence: Evidence) {
  validateEvidence(evidence);
  const dir = path.join(epDir, "publish/en"),
    release = lock(dir);
  try {
    const p = path.join(dir, "studio-en.json"),
      old = existsSync(p) ? json(p) : {},
      upload = path.join(epDir, "publish/upload-result.json");
    const uploadId = existsSync(upload) ? json(upload).videoId : undefined;
    if (old.videoId && uploadId && old.videoId !== uploadId)
      throw Error(
        "identity-conflict: studio-en and upload-result videoId differ",
      );
    const expected = old.videoId ?? uploadId;
    if (!expected || expected !== evidence.videoId)
      throw Error("videoId mismatch or no local upload identity");
    const history = Array.isArray(old.observations) ? old.observations : [];
    if (
      history.some(
        (x: any) =>
          x.observedAt === evidence.observedAt &&
          JSON.stringify(x) === JSON.stringify(evidence),
      )
    )
      return;
    const newest = history.reduce(
      (n: number, x: any) => Math.max(n, Date.parse(x.observedAt) || 0),
      Date.parse(old.checkedAt) || 0,
    );
    if (Date.parse(evidence.observedAt) < newest)
      throw Error("observation older than existing record");
    atomicJson(p, {
      ...old,
      legacyRecord:
        old.legacyRecord ??
        Object.fromEntries(
          Object.entries(old).filter(([k]) => k !== "observations"),
        ),
      observations: [...history, evidence],
    });
  } finally {
    release();
  }
}
export function inventory(root = "episodes") {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const ep = path.join(root, d.name),
        p = path.join(ep, "publish/en/studio-en.json"),
        u = path.join(ep, "publish/upload-result.json");
      if (!existsSync(p) && !existsSync(path.join(ep, "en/en.json"))) return [];
      const raw = existsSync(p) ? json(p) : {},
        upload = existsSync(u) ? json(u) : {};
      const observed = Object.fromEntries(
        fields.map((f) => {
          const ev = (raw.observations ?? [])
            .filter((o: any) => o.fields?.[f])
            .sort(
              (a: any, b: any) =>
                Date.parse(b.observedAt) - Date.parse(a.observedAt),
            )[0];
          return [
            f,
            ev
              ? {
                  state: ev.fields[f].state,
                  raw: ev.fields[f].raw,
                  observedAt: ev.observedAt,
                  source: "ui-evidence",
                }
              : {
                  state: normalizeStatus(raw[f]),
                  raw: raw[f] ?? null,
                  observedAt: raw.checkedAt ?? null,
                  source: "historical-record",
                },
          ];
        }),
      );
      const pending = fields.filter(
        (f) =>
          !["published", ...(f === "thumbnail" ? ["uploaded"] : [])].includes(
            observed[f].state,
          ),
      );
      return [
        {
          episodeId: d.name,
          videoId:
            raw.videoId && upload.videoId && raw.videoId !== upload.videoId
              ? null
              : (raw.videoId ?? upload.videoId ?? null),
          identity:
            raw.videoId && upload.videoId && raw.videoId !== upload.videoId
              ? {
                  state: "identity-conflict",
                  studioVideoId: raw.videoId,
                  uploadVideoId: upload.videoId,
                }
              : { state: "consistent" },
          observed,
          pending,
          needsRecheck: fields.filter(
            (f) => observed[f].source === "historical-record",
          ),
          liveState: "not-queried",
        },
      ];
    });
}
if (process.argv[1]?.endsWith("en-status.ts")) {
  const i = process.argv.indexOf("--record");
  if (i >= 0) {
    const ep = process.argv[i + 1],
      file = process.argv[i + 2];
    if (!ep || !file)
      throw Error("usage: en-status.ts --record <epId> <evidence.json>");
    recordEvidence(path.join("episodes", ep), json(file));
  }
  const rows = inventory();
  if (process.argv.includes("--json"))
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          notice: "Recorded observations only; live state not queried.",
          episodes: rows,
        },
        null,
        2,
      ),
    );
  else {
    console.log(
      "英語公開の観測記録（現在の公開状態を問い合わせた結果ではありません）\n\n| Episode | Video | Audio | Captions | 確認対象 |\n|---|---|---|---|---|",
    );
    for (const r of rows)
      console.log(
        `| ${r.episodeId} | ${r.identity.state === "identity-conflict" ? "ID不一致" : (r.videoId ?? "未記録")} | ${r.observed.audio.state} (${r.observed.audio.observedAt ?? "日時未記録"}) | ${r.observed.captions.state} | ${r.pending.join(", ") || "記録上完了"} |`,
      );
  }
}
