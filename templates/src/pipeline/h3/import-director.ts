/**
 * h3-director(演出家)が書いた1ファイル h3/episodes/<epId>/director.md を、生成の道具が読む形へ取り込む。
 *   npm run h3:import -- <epId> [--dry]
 *
 * 書き出すもの:
 *   - h3/episodes/<epId>/cuts.json   — 章・束ね・尺・鎖(尺は機械が計算する。演出家は計算しない)
 *   - h3/episodes/<epId>/shots/<章>.ts — body / sound をそのまま埋めた宣言(語彙帳の参照は無い)
 *   - h3/vocab/<epId>.ts               — 無ければ作る。画風の定数だけ(雛形 example-*.ts を継ぐ・places 等は空)
 *
 * 章は台本の段見出し(`## [L01] 1 誕生`)から決める。
 * 区間が短く早回しが SPEEDUP_ADVISE を超えるカットは holdSlow(頭から等速で使い、余りは切る)。
 * 取り込み直し(作り直し後)でも、同じカットIDの skipHeadFrames / holdSlow は既存台帳から引き継ぐ。
 * 行の取りこぼし・順序違い・カットIDと先頭行の不一致・尺の上限超えが1件でもあれば何も書かずに exit 2。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { framesForSeconds } from "./frames";
import { MIN_CLIP_SEC, SPEEDUP_ADVISE, spanSeconds, type TimingLine } from "./plan";
import type { Chapter, Cut, CutsFile, ShotDecl } from "./types";

const ROOT = resolve(import.meta.dirname, "../../..");

export interface DirectorCut {
  id: string;
  lineIds: string[];
  chain: boolean;
  body: string;
  sound: string;
  seed?: number;
  chainFrom?: string;
}

/** `### cLxx` の節を読む。各節は lines / chain / (seed) / body / sound の箇条書き */
export function parseDirectorMd(text: string): DirectorCut[] {
  const out: DirectorCut[] = [];
  const sections = text.split(/^### /m).slice(1);
  for (const sec of sections) {
    const id = sec.split("\n")[0].trim();
    const field = (name: string): string | undefined => sec.match(new RegExp("^- " + name + ":[ \\t]*(.*)$", "m"))?.[1].trim();
    const lines = field("lines");
    if (!/^cL\d+$/.test(id) || lines === undefined) continue;
    const cut: DirectorCut = {
      id,
      lineIds: lines.split(",").map((s) => s.trim()).filter(Boolean),
      chain: /^yes$/i.test(field("chain") ?? ""),
      body: field("body") ?? "",
      sound: field("sound") ?? "",
    };
    const chainFrom = field("chainFrom");
    if (chainFrom) cut.chainFrom = chainFrom;
    const seed = field("seed");
    if (seed !== undefined && seed !== "") cut.seed = Number(seed);
    out.push(cut);
  }
  return out;
}

/** 前置き(最初の `### ` より前)の `firstWorstLineId: L0N`。冒頭の期限を持つチャンネル(check:h3 B14)用 */
export function firstWorstOf(text: string): string | undefined {
  return text.split(/^### /m)[0].match(/^firstWorstLineId:\s*(L\d+)\s*$/m)?.[1];
}

/** 台本の `## [L01] 1 誕生` から 行ID → 段ラベル("1 誕生") */
export function chapterOfLines(script: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const hit of script.matchAll(/^## \[(L\d+)\][ \t]*(.*)$/gm)) m.set(hit[1], hit[2].trim());
  return m;
}

const KANJI = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
function kanjiNum(n: number): string {
  if (n <= 10) return KANJI[n];
  if (n < 20) return "十" + KANJI[n - 10];
  return String(n);
}

export function buildFromDirector(
  epId: string,
  cuts: DirectorCut[],
  timing: { totalDurationSec: number; lines: TimingLine[] },
  chapterOf: Map<string, string>,
  existing?: Record<string, Cut>,
  firstWorstLineId?: string,
): { cutsFile: CutsFile; shots: Record<string, ShotDecl>; problems: string[] } {
  const problems: string[] = [];
  const indexOf = new Map(timing.lines.map((l, i) => [l.lineId, i]));

  // 全行をちょうど1回ずつ、順に使っているか
  const used = cuts.flatMap((c) => c.lineIds);
  const expected = timing.lines.map((l) => l.lineId);
  const missing = expected.filter((id) => !used.includes(id));
  if (missing.length) problems.push("使われていない行: " + missing.join(", "));
  const dup = used.filter((id, i) => used.indexOf(id) !== i);
  if (dup.length) problems.push("2回以上使われた行: " + [...new Set(dup)].join(", "));
  const unknown = used.filter((id) => !indexOf.has(id));
  if (unknown.length) problems.push("timing.json に無い行: " + unknown.join(", "));
  if (!missing.length && !dup.length && !unknown.length && used.join() !== expected.join()) problems.push("行の順序が台本と違う");

  const chapters: Chapter[] = [];
  const ledger: Record<string, Cut> = {};
  const shots: Record<string, ShotDecl> = {};
  for (const c of cuts) {
    if (c.id !== "cL" + (c.lineIds[0] ?? "").slice(1)) problems.push(c.id + ": カットIDが先頭行 " + c.lineIds[0] + " と合わない");
    if (!c.body) problems.push(c.id + ": body が空");
    const first = indexOf.get(c.lineIds[0]);
    const last = indexOf.get(c.lineIds[c.lineIds.length - 1]);
    if (first === undefined || last === undefined) continue;
    const span = spanSeconds(timing.lines, first, last, timing.totalDurationSec);
    const seconds = Math.max(MIN_CLIP_SEC, Math.ceil(span * 10) / 10);
    try {
      framesForSeconds(seconds);
    } catch {
      problems.push(c.id + ": 区間 " + span.toFixed(1) + "秒は1カットの上限(約15秒)を超える。行を分けて別カットにする");
    }
    const label = chapterOf.get(c.lineIds[0]) ?? "";
    let ch = chapters[chapters.length - 1];
    if (!ch || ch.name !== label.replace(/^\d+\s*/, "")) {
      ch = { id: "ch" + String(chapters.length).padStart(2, "0"), title: "第" + kanjiNum(chapters.length + 1) + "章", name: label.replace(/^\d+\s*/, ""), cuts: [] };
      chapters.push(ch);
    }
    ch.cuts.push(c.id);
    const prev = existing?.[c.id];
    ledger[c.id] = {
      lineIds: c.lineIds,
      seconds,
      place: "",
      subject: "",
      role: "",
      ...(c.chain ? { chain: true } : {}),
      ...(c.chainFrom ? { chainFrom: c.chainFrom } : {}),
      ...(prev?.skipHeadFrames ? { skipHeadFrames: prev.skipHeadFrames } : {}),
      ...(prev?.holdSlow || seconds / span > SPEEDUP_ADVISE ? { holdSlow: true } : {}),
    };
    shots[c.id] = { body: c.body, sound: c.sound, ...(c.chain ? { chain: true } : {}), ...(c.chainFrom ? { chainFrom: c.chainFrom } : {}), ...(c.seed !== undefined ? { seed: c.seed } : {}) };
  }
  const cutsFile: CutsFile = { episodeId: epId, chapters, cuts: ledger, needsVocab: [] };
  if (firstWorstLineId) cutsFile.firstWorstLineId = firstWorstLineId;
  return { cutsFile, shots, problems };
}

export function renderShotsTs(ids: string[], shots: Record<string, ShotDecl>, chapterName: string): string {
  const body = ids.map((id) => {
    const s = shots[id];
    const rows = ["    body: " + JSON.stringify(s.body) + ",", "    sound: " + JSON.stringify(s.sound) + ","];
    if (s.chain) rows.push("    chain: true,");
    if (s.chainFrom) rows.push("    chainFrom: " + JSON.stringify(s.chainFrom) + ",");
    if (s.seed !== undefined) rows.push("    seed: " + s.seed + ",");
    return "  " + id + ": {\n" + rows.join("\n") + "\n  },";
  });
  return (
    'import type { ShotDecl } from "../../../../src/pipeline/h3/types";\n\n' +
    "/** " + chapterName + "。h3:import が director.md から書き出した(手で直さず director.md を直して取り込み直す)。 */\n" +
    "const shots: Record<string, ShotDecl> = {\n" + body.join("\n") + "\n};\n\nexport default shots;\n"
  );
}

/** 画風だけの語彙帳。雛形(example-person.ts があればそれ、無ければ最初の example-*.ts)を継ぐ */
function vocabSource(): string {
  const dir = join(ROOT, "h3/vocab");
  const names = readdirSync(dir).filter((f) => /^example-.*\.ts$/.test(f)).sort();
  const pick = names.includes("example-person.ts") ? "example-person.ts" : names[0];
  if (!pick) throw new Error("h3/vocab/example-*.ts が無い(画風の雛形が要る)");
  return (
    'import base from "./' + pick.replace(/\.ts$/, "") + '";\n' +
    'import type { Vocab } from "../../src/pipeline/h3/types";\n\n' +
    "/** 演出家方式(h3:import)の回。画風の定数だけを雛形から継ぎ、人物・場所は各カットの文面が持つ。 */\n" +
    "const vocab: Vocab = { ...base, places: {}, subjects: {}, props: {} };\n\nexport default vocab;\n"
  );
}

function main(): void {
  const epId = process.argv[2];
  const dry = process.argv.includes("--dry");
  if (!epId) {
    console.error("使い方: npm run h3:import -- <epId> [--dry]");
    process.exit(2);
  }
  const epDir = join(ROOT, "h3/episodes", epId);
  const mdPath = join(epDir, "director.md");
  if (!existsSync(mdPath)) {
    console.error("director.md がありません: " + mdPath);
    process.exit(2);
  }
  const timing = JSON.parse(readFileSync(join(ROOT, "episodes", epId, "timing.json"), "utf8"));
  const script = readFileSync(join(ROOT, "episodes", epId, "script.md"), "utf8");
  let existing: Record<string, Cut> | undefined;
  try {
    existing = (JSON.parse(readFileSync(join(epDir, "cuts.json"), "utf8")) as CutsFile).cuts;
  } catch {
    existing = undefined;
  }
  const mdText = readFileSync(mdPath, "utf8");
  const parsed = parseDirectorMd(mdText);
  const { cutsFile, shots, problems } = buildFromDirector(epId, parsed, timing, chapterOfLines(script), existing, firstWorstOf(mdText));
  if (problems.length) {
    console.error("取り込めません(" + problems.length + "件)。director.md を直してください:\n- " + problems.join("\n- "));
    process.exit(2);
  }
  const chains = Object.values(cutsFile.cuts).filter((c) => c.chain).length;
  console.log("カット " + parsed.length + "本 / 章 " + cutsFile.chapters.length + " / 鎖 " + chains + "本 / 行 " + timing.lines.length + "本を被覆");
  if (dry) {
    console.log("--dry: 何も書いていません");
    return;
  }
  mkdirSync(join(epDir, "shots"), { recursive: true });
  for (const f of readdirSync(join(epDir, "shots")).filter((x) => x.endsWith(".ts"))) {
    if (!cutsFile.chapters.some((c) => c.id + ".ts" === f)) console.warn("注意: 古い章ファイル shots/" + f + " が残っています(今回の章割りに無い)");
  }
  for (const ch of cutsFile.chapters) writeFileSync(join(epDir, "shots", ch.id + ".ts"), renderShotsTs(ch.cuts, shots, ch.title + " " + ch.name));
  writeFileSync(join(epDir, "cuts.json"), JSON.stringify(cutsFile, null, 2) + "\n");
  const vocabPath = join(ROOT, "h3/vocab", epId + ".ts");
  if (!existsSync(vocabPath)) writeFileSync(vocabPath, vocabSource());
  console.log("書きました: cuts.json / shots/ch00〜" + cutsFile.chapters[cutsFile.chapters.length - 1].id + ".ts" + (existsSync(vocabPath) ? " / vocab" : ""));
  console.log("次: npm run check:h3 -- " + epId);
}

if (import.meta.url === "file://" + process.argv[1] || process.argv[1]?.endsWith("import-director.ts")) main();
