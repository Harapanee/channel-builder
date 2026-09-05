/**
 * 課金前の砦(CLI)。
 *   npm run check:h3 -- <epId> [章ID…] [--dump <出力先>] [--verbose]
 * exit 0=緑 / 1=ADVISE のみ / 2=BLOCK あり
 *
 * BLOCK が1件でもあるうちは生成へ進まない。Pod はまだ起動しない。
 * --dump は合成後の全文を1カット1ファイルで書き出す。レビュアーには
 * このパスだけを渡す(レビュアーは Bash を持たないため)。
 *
 * **ADVISE は同じ指摘を1行へ畳んで出す。** この出力は工程7で人間と h3-prompt-reviewer が
 * 読む唯一の意味的な材料なので、可読性が機能そのものである(2026-08-19 実測: 畳まないと
 * A9 が125行・「no wall」が19行並び、本当に見てほしい A1 の2件が埋もれた)。
 * BLOCK は畳まない(件数が少なく1件ずつ見る必要がある)。--verbose で1カット1行へ戻せる。
 */
import { basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { ROOT } from "./config";
import { checkAdvisories, checkFirstWorst, checkJobSet, checkLedger, checkPromptText, checkSelfContained, checkSpeedup, checkVocabNegations, dropVocabOriginA6 } from "./check";
import { chapterCard, composePrompt } from "./compose";
import { speedupRatios, type TimingLine } from "./plan";
import type { CutsFile, Finding, ShotDecl, Vocab } from "./types";

/** 畳んだ結果の1行ぶん。ids は出た順 */
export interface FoldedFinding {
  rule: string;
  message: string;
  ids: string[];
}

/** 畳んだ行に並べるID数の上限。これを超えたぶんは「ほか N件」にする */
export const FOLD_ID_LIMIT = 10;

/**
 * **規則IDとメッセージが完全に同一の指摘だけ**を1行へ畳む。
 * メッセージに固有の値が埋まっている規則(A1 の「「ruled lines」— …」など)は
 * メッセージが違えば別行のまま残るので、個別の指摘は失われない。
 * 出現順は保つ(先に出たものが上)。
 */
export function foldFindings(findings: Finding[]): FoldedFinding[] {
  const groups = new Map<string, FoldedFinding>();
  for (const f of findings) {
    const key = JSON.stringify([f.rule, f.message]);
    const g = groups.get(key) ?? { rule: f.rule, message: f.message, ids: [] };
    g.ids.push(f.id);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** 畳んだ1行を描画する。1件しか無いものは従来どおり「ID [規則] メッセージ」 */
export function renderFolded(g: FoldedFinding): string {
  if (g.ids.length === 1) return "⚠️  " + g.ids[0] + " [" + g.rule + "] " + g.message;
  const head = g.ids.slice(0, FOLD_ID_LIMIT).join(", ");
  const rest = g.ids.length > FOLD_ID_LIMIT ? "、ほか " + (g.ids.length - FOLD_ID_LIMIT) + "件" : "";
  return "⚠️  [" + g.rule + "] ×" + g.ids.length + " " + g.message + ": " + head + rest;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const epId = args[0];
  const dumpAt = args.indexOf("--dump");
  const dumpDir = dumpAt >= 0 ? args[dumpAt + 1] : undefined;
  const verbose = args.includes("--verbose");
  const only = args.slice(1).filter((a) => !a.startsWith("--") && a !== dumpDir);
  if (!epId) {
    console.error("使い方: npm run check:h3 -- <epId> [章ID…] [--dump <出力先>] [--verbose]");
    process.exit(2);
  }

  const epDir = join(ROOT, "h3/episodes", epId);
  const vocab = (await import(join(ROOT, "h3/vocab", epId + ".ts"))).default as Vocab;
  const cuts = JSON.parse(readFileSync(join(epDir, "cuts.json"), "utf8")) as CutsFile;
  // A10 は timing.json が要る。**無ければ黙って飛ばさず、その旨を出す**
  const timingPath = join(ROOT, "episodes", epId, "timing.json");
  const timing = existsSync(timingPath)
    ? (JSON.parse(readFileSync(timingPath, "utf8")) as { totalDurationSec: number; lines: TimingLine[] })
    : null;
  if (dumpDir) mkdirSync(dumpDir, { recursive: true });

  const chapters = readdirSync(join(epDir, "shots"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""))
    .filter((c) => only.length === 0 || only.includes(c))
    .sort();

  // 章IDを指定したのに1つも一致しなければ誤字の可能性が高い。無言で「0カット緑」を
  // 返すと誤字が課金GOに見えるので、ここで止める(2026-08-19 レビュー対応)。
  if (only.length > 0 && chapters.length === 0) {
    console.error("章ID「" + only.join(", ") + "」に一致する章ファイルが shots/ に無い(誤字の可能性)");
    process.exit(2);
  }

  const findings: Finding[] = [];
  // 語彙帳の否定形は項目ごとに1件(A11)。body 側の A6 で語彙由来のものは後で落とす
  findings.push(...checkVocabNegations(vocab));
  const jobs: { id: string; prompt: string; firstFrameFile?: string }[] = [];
  const declared = new Set<string>();

  for (const ch of chapters) {
    const shots = (await import(join(epDir, "shots", ch + ".ts"))).default as Record<string, ShotDecl>;
    for (const [id, raw] of Object.entries(shots)) {
      declared.add(id);
      const decl: ShotDecl = raw.card ? { ...chapterCard(raw.card[0], raw.card[1]), ...raw } : raw;
      const cut = cuts.cuts[id];
      findings.push(...checkLedger(id, decl, cut));
      if (!cut) continue;
      const hasFirstFrame = Boolean(cut.chain || cut.chainFrom);
      const prompt = composePrompt(decl, vocab, { firstFrame: hasFirstFrame });
      findings.push(...checkPromptText(id, prompt, { seconds: cut.seconds, hasFirstFrame }));
      findings.push(...checkAdvisories(id, decl.body ?? "", vocab));
      findings.push(...checkSelfContained(id, decl, { hasFirstFrame }));
      // basename の一意性だけを見る(実在検査は投入直前に run-chapter が行う)。
      // 鎖の起点は章のカット順から解決する。
      const order = cuts.chapters.find((c) => c.cuts.includes(id))?.cuts ?? [];
      const at = order.indexOf(id);
      const from = cut.chainFrom ?? (cut.chain && at > 0 ? order[at - 1] : undefined);
      if (cut.chain && !cut.chainFrom && at <= 0) {
        findings.push({ level: "BLOCK", id, rule: "B11", message: "章の先頭で chain: true(鎖の起点になる前のカットが無い)" });
      }
      jobs.push({ id, prompt, ...(from ? { firstFrameFile: from + "-last.png" } : {}) });
      if (dumpDir) writeFileSync(join(dumpDir, id + ".txt"), prompt + "\n");
    }
  }
  findings.push(...checkJobSet(jobs));
  // B14: 冒頭45秒(全章を対象にしたときだけ。章指定の部分検査で毎回止めない)
  if (timing && only.length === 0) findings.push(...checkFirstWorst(cuts, timing.lines));

  if (timing) {
    const targeted = Object.fromEntries(
      Object.entries(cuts.cuts).filter(([id]) => jobs.some((j) => j.id === id)),
    );
    const holdSlow = new Set(Object.entries(targeted).filter(([, c]) => c.holdSlow).map(([id]) => id));
    findings.push(...checkSpeedup(speedupRatios(targeted, timing.lines, timing.totalDurationSec), holdSlow));
  } else {
    console.log("⚠️ timing.json が無いため早回しの検査(A10)は行いません");
  }

  // 台帳にあって宣言が無いカット(B11 の逆方向)
  if (only.length === 0) {
    for (const id of Object.keys(cuts.cuts)) {
      if (!declared.has(id)) {
        findings.push({ level: "BLOCK", id, rule: "B11", message: "cuts.json にあるが章ファイルに宣言が無い" });
      }
    }
  }

  const blocks = findings.filter((f) => f.level === "BLOCK");
  const advices = dropVocabOriginA6(findings, vocab).filter((f) => f.level === "ADVISE");
  // BLOCK は1件ずつ(畳まない)
  for (const f of blocks) console.log("❌ " + f.id + " [" + f.rule + "] " + f.message);
  const lines = verbose
    ? advices.map((f) => "⚠️  " + f.id + " [" + f.rule + "] " + f.message)
    : foldFindings(advices).map(renderFolded);
  for (const line of lines) console.log(line);
  if (!verbose && lines.length < advices.length) {
    console.log("(" + advices.length + "件を" + lines.length + "行に畳みました。全件は --verbose)");
  }
  console.log(
    blocks.length === 0 && advices.length === 0
      ? "✅ " + jobs.length + "カットの検査を通過"
      : jobs.length + "カット中 BLOCK " + blocks.length + "件 / ADVISE " + advices.length + "件",
  );
  if (dumpDir) console.log("全文を書き出しました: " + dumpDir);
  process.exit(blocks.length > 0 ? 2 : advices.length > 0 ? 1 : 0);
}

if (process.argv[1] && basename(process.argv[1]) === "check-h3-prompt.ts") await main();
