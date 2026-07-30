#!/usr/bin/env node
/**
 * 台本の機械lint(数え上げで判定できる4項目)。
 * 意味判定が要る項目(同型ビート・因果・署名運用)は台本ゲートの担当者
 * (チャンネルによって台本審査エージェント / script-director のセルフチェック)が担う。
 *
 * L1 の尺判定は2方式:
 *  - 既定: 目標尺比(85〜100%)
 *  - `.channel-system.json` に `durationPolicy: {minSec,maxSec}` があれば絶対レンジ
 *
 * CLI: npx tsx src/pipeline/lint-script.ts episodes/<epId>
 * exit 0 = 全項目PASS / exit 1 = FAILあり / exit 2 = 入力不備
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseScriptFile, ParsedScriptLine } from "./parse-script";

const HEDGES = ["一説に", "という説", "とも言われ", "諸説あ"];

type Violation = { check: string; lineId?: string; detail: string };

export type LintResult = {
  ok: boolean;
  summary: string[]; // 項目ごとの1行サマリ(数字つき)
  violations: Violation[];
};

/**
 * 尺ポリシー(チャンネル単位のオプトイン)。`.channel-system.json` の
 * `durationPolicy` に宣言すると、L1 が「目標尺比(85〜100%)」ではなく
 * 「絶対レンジ(minSec〜maxSec)」で判定する。
 * どちらか片方だけの宣言も可(上限だけ・下限だけ)。未宣言なら従来どおり。
 */
export type DurationPolicy = { minSec?: number; maxSec?: number };

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

export function lintScript(
  lines: ParsedScriptLine[],
  targetDurationSec: number,
  speedScale: number,
  durationPolicy?: DurationPolicy | null
): LintResult {
  const violations: Violation[] = [];
  const summary: string[] = [];

  // L1 時間予算(リファレンス: speedScale=1.05 で約6.3文字/秒 → 6.0×speedScale)
  const charsPerSec = 6.0 * speedScale;
  const totalChars = lines.reduce((n, l) => n + l.text.length, 0);
  const pauseTotal = lines.reduce((n, l) => n + (l.pauseAfterSec ?? 0), 0);
  const estimatedSec = totalChars / charsPerSec + pauseTotal;
  const minSec = num(durationPolicy?.minSec);
  const maxSec = num(durationPolicy?.maxSec);
  const hasPolicy = minSec !== null || maxSec !== null;

  if (hasPolicy) {
    // 尺レンジ方式: 目標尺は目安に降格し、絶対レンジだけを機械判定する
    summary.push(
      `L1 尺レンジ: ${totalChars}文字 + pause${pauseTotal.toFixed(1)}s ≒ ${estimatedSec.toFixed(0)}s / 許容 ${minSec ?? "下限なし"}〜${maxSec ?? "上限なし"}s(目標${targetDurationSec}sは目安)`
    );
    if (minSec !== null && estimatedSec < minSec) {
      violations.push({
        check: "L1",
        detail: `推定尺${estimatedSec.toFixed(0)}sが下限${minSec}sに届かない。約${Math.ceil((minSec - estimatedSec) * charsPerSec)}文字の追加が必要`,
      });
    }
    if (maxSec !== null && estimatedSec > maxSec) {
      violations.push({
        check: "L1",
        detail: `推定尺${estimatedSec.toFixed(0)}sが上限${maxSec}sを超過。約${Math.ceil((estimatedSec - maxSec) * charsPerSec)}文字の削減が必要`,
      });
    }
  } else {
    const ratio = estimatedSec / targetDurationSec;
    summary.push(
      `L1 時間予算: ${totalChars}文字 + pause${pauseTotal.toFixed(1)}s ≒ ${estimatedSec.toFixed(0)}s / 目標${targetDurationSec}s (${(ratio * 100).toFixed(0)}%)`
    );
    if (ratio > 1.0) {
      violations.push({
        check: "L1",
        detail: `推定尺が目標の${(ratio * 100).toFixed(0)}%(100%超過)。約${Math.ceil((estimatedSec - targetDurationSec) * charsPerSec)}文字の削減が必要`,
      });
    }
    if (ratio < 0.85) {
      violations.push({
        check: "L1",
        detail: `推定尺が目標の${(ratio * 100).toFixed(0)}%(下限85%)。約${Math.ceil((targetDurationSec * 0.85 - estimatedSec) * charsPerSec)}文字の追加が必要`,
      });
    }
  }

  // L2 読点上限(1文に「、」2個まで)
  let l2count = 0;
  for (const l of lines) {
    for (const sentence of l.text.split("。")) {
      const commas = (sentence.match(/、/g) ?? []).length;
      if (commas >= 3) {
        l2count++;
        violations.push({
          check: "L2",
          lineId: l.lineId,
          detail: `1文に読点${commas}個(上限2): 「${sentence.slice(0, 30)}…」`,
        });
      }
    }
  }
  summary.push(`L2 読点上限: 違反${l2count}文`);

  // L3 間の予算(pause 0.6s以上は 90秒あたり5箇所以内・比例)
  // 尺レンジ方式のチャンネルでは目標尺が目安なので、推定尺を基準に比例させる
  const pauseRefSec = hasPolicy ? estimatedSec : targetDurationSec;
  const longPauses = lines.filter((l) => (l.pauseAfterSec ?? 0) >= 0.6);
  const allowed = Math.ceil((pauseRefSec / 90) * 5);
  summary.push(`L3 間の予算: 0.6s以上のpause ${longPauses.length}箇所 / 上限${allowed}`);
  if (longPauses.length > allowed) {
    violations.push({
      check: "L3",
      detail: `長い間が${longPauses.length}箇所(上限${allowed})。対象行: ${longPauses.map((l) => l.lineId).join(", ")}`,
    });
  }

  // L4 ヘッジ語の近接反復(同じヘッジ語が隣接2行)
  let l4count = 0;
  for (let i = 1; i < lines.length; i++) {
    for (const h of HEDGES) {
      if (lines[i]!.text.includes(h) && lines[i - 1]!.text.includes(h)) {
        l4count++;
        violations.push({
          check: "L4",
          lineId: lines[i]!.lineId,
          detail: `「${h}」が ${lines[i - 1]!.lineId} と連続使用(言い換える)`,
        });
      }
    }
  }
  summary.push(`L4 ヘッジ語近接: 違反${l4count}箇所`);

  return { ok: violations.length === 0, summary, violations };
}

function main() {
  const epDir = process.argv[2];
  if (!epDir) {
    console.error("usage: lint-script.ts episodes/<epId>");
    process.exit(2);
  }
  let episode: { targetDurationSec?: number };
  let speedScale = 1.05;
  let durationPolicy: DurationPolicy | null = null;
  let parsed: ReturnType<typeof parseScriptFile>;
  try {
    episode = JSON.parse(
      fs.readFileSync(path.join(epDir, "episode.json"), "utf8")
    ) as { targetDurationSec?: number };
    if (!episode.targetDurationSec) {
      console.error(`episode.json に targetDurationSec がありません: ${epDir}`);
      process.exit(2);
    }
    const voicePath = path.join("channel", "voice.json");
    if (fs.existsSync(voicePath)) {
      const v = JSON.parse(fs.readFileSync(voicePath, "utf8")) as { speedScale?: number };
      if (typeof v.speedScale === "number") speedScale = v.speedScale;
    }
    const sysPath = ".channel-system.json";
    if (fs.existsSync(sysPath)) {
      const s = JSON.parse(fs.readFileSync(sysPath, "utf8")) as {
        durationPolicy?: DurationPolicy;
      };
      if (s.durationPolicy && typeof s.durationPolicy === "object") {
        durationPolicy = s.durationPolicy;
      }
    }
    parsed = parseScriptFile(path.join(epDir, "script.md"));
  } catch (e) {
    console.error(`入力不備: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  if (parsed.lines.length === 0) {
    console.error(
      "入力不備: 台本に行が1つもありません(見出し形式 `## [Lxx]` を確認)"
    );
    process.exit(2);
  }
  const result = lintScript(
    parsed.lines,
    episode.targetDurationSec!,
    speedScale,
    durationPolicy
  );
  for (const s of result.summary) console.log(s);
  for (const v of result.violations) {
    console.log(`NG [${v.check}]${v.lineId ? ` ${v.lineId}` : ""}: ${v.detail}`);
  }
  console.log(result.ok ? "lint: PASS" : `lint: FAIL(${result.violations.length}件)`);
  process.exit(result.ok ? 0 : 1);
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      path.resolve(fileURLToPath(import.meta.url)) ===
      path.resolve(process.argv[1])
    );
  } catch {
    return false;
  }
}

if (isMainModule()) main();
