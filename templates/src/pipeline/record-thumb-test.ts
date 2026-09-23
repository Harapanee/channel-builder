/**
 * サムネ AB テスト(YouTube Studio「テストと比較」)の結果を記録する。結果は API で取れないので人が転記する。
 *
 *   npx tsx src/pipeline/record-thumb-test.ts <epId> --winner <1|2|3|thumb-N> [--shares a,b[,c]] [--note <所感>] [--date YYYY-MM-DD]
 *
 * 書き先は episodes/<epId>/publish/thumb-test.json。形は src/schemas/thumb-test.schema.json に従う
 * (factory-ui の saveThumbTest と同じ契約):
 *   - winner: "thumb-1" | "thumb-2" | "thumb-3"(--winner 2 は "thumb-2" に直す)
 *   - shares: { "thumb-1": a, "thumb-2": b, "thumb-3": c }(視聴シェア%。並びは案の番号順。2案テストなら2個)
 *   - recordedAt: 記録日(JST の YYYY-MM-DD。--date で上書き)
 * スキーマ違反は書かない。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv from "ajv";

const ROOT = resolve(import.meta.dirname, "../..");
const KEYS = ["thumb-1", "thumb-2", "thumb-3"] as const;
type ThumbKey = (typeof KEYS)[number];

export interface ThumbTest {
  winner: ThumbKey;
  shares?: Partial<Record<ThumbKey, number>>;
  note?: string;
  recordedAt: string;
}

export interface ThumbTestArgs {
  epId: string;
  winner: string;
  shares?: string;
  note?: string;
  date?: string;
}

export function parseThumbTestArgs(argv: string[]): ThumbTestArgs {
  const flags = new Map<string, string>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { flags.set(a.slice(2), argv[i + 1] ?? ""); i++; } else pos.push(a);
  }
  const epId = pos[0];
  if (!epId) throw new Error("epId がありません。使い方: record-thumb-test <epId> --winner <1|2|3> [--shares a,b,c] [--note ...]");
  const winner = flags.get("winner");
  if (!winner) throw new Error("--winner がありません(1|2|3 または thumb-N)");
  return { epId, winner, shares: flags.get("shares"), note: flags.get("note"), date: flags.get("date") };
}

export function buildThumbTest(a: ThumbTestArgs, today: string): ThumbTest {
  const w = /^(?:thumb-)?([123])$/.exec(a.winner.trim());
  if (!w) throw new Error("winner は 1〜3(または thumb-1〜thumb-3): " + a.winner);
  const winner = ("thumb-" + w[1]) as ThumbKey;
  const out: ThumbTest = { winner, recordedAt: a.date ?? today };
  if (a.shares !== undefined) {
    const parts = a.shares.split(",").map((s) => s.trim());
    if (parts.length < 2 || parts.length > 3) throw new Error("shares は案の番号順に2〜3個(例 40,35,25): " + a.shares);
    const vals = parts.map(Number);
    if (vals.some((v, i) => parts[i] === "" || !Number.isFinite(v) || v < 0 || v > 100)) throw new Error("shares は 0〜100 の数: " + a.shares);
    if (Number(w[1]) > vals.length) throw new Error("shares の個数(" + vals.length + ")が winner(" + winner + ")に届かない");
    out.shares = Object.fromEntries(vals.map((v, i) => [KEYS[i], v])) as ThumbTest["shares"];
  }
  if (a.note !== undefined && a.note !== "") out.note = a.note;
  return out;
}

export function writeThumbTest(root: string, epId: string, data: ThumbTest): string {
  const schema = JSON.parse(readFileSync(join(ROOT, "src/schemas/thumb-test.schema.json"), "utf8")) as object;
  const validate = new Ajv({ allErrors: true }).compile(schema);
  if (!validate(data)) {
    throw new Error("スキーマ違反(thumb-test.schema.json): " + (validate.errors ?? []).map((e) => (e.instancePath || "/") + " " + e.message).join(" / "));
  }
  const epDir = join(root, "episodes", epId);
  if (!existsSync(epDir)) throw new Error("エピソードがありません: " + epDir);
  mkdirSync(join(epDir, "publish"), { recursive: true });
  const p = join(epDir, "publish", "thumb-test.json");
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
  return p;
}

function main(): void {
  const a = parseThumbTestArgs(process.argv.slice(2));
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const data = buildThumbTest(a, today);
  const p = writeThumbTest(ROOT, a.epId, data);
  console.log("→ " + p);
  console.log(JSON.stringify(data));
}

const isMain = process.argv[1] && /record-thumb-test\.ts$/.test(process.argv[1]);
if (isMain) {
  try { main(); } catch (e) { console.error("❌ " + (e as Error).message); process.exit(1); }
}
