#!/usr/bin/env node
/**
 * 台本の機械lint。検査は L1(尺)と L7(字幕の漢数字)。
 * 2026-09-02 に L2(読点上限)・L4(ヘッジ近接)・L5(二人称空白)・L6(落ち直後の留保)を廃止した。
 * いずれも文体を縛る方向に効き、短文・否定形の連打や逐語テンプレを再生産していた(CHANGELOG 参照)。
 * 文体・意味の判断は script-director と人間の読みに戻す。
 *
 * L1 の尺判定は2方式:
 *  - 既定: 目標尺比(85〜100%)
 *  - `.channel-system.json` に `durationPolicy: {minSec,maxSec}` があれば絶対レンジ
 *    (下限未満は WARN のみ。文字数で埋めさせると終章の既出事実リプライズが増えるため FAIL にしない)
 *
 * CLI: npx tsx src/pipeline/lint-script.ts episodes/<epId>
 * exit 0 = 全項目PASS / exit 1 = FAILあり / exit 2 = 入力不備
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseScriptFile, ParsedScriptLine } from "./parse-script";

type Violation = { check: string; lineId?: string; detail: string };

export type LintResult = {
  ok: boolean;
  summary: string[]; // 項目ごとの1行サマリ(数字つき)
  violations: Violation[];
  /** FAILさせない指摘(L1 下限)。ok には影響しない。 */
  warnings: Violation[];
};

/**
 * 尺ポリシー(チャンネル単位のオプトイン)。`.channel-system.json` の
 * `durationPolicy` に宣言すると、L1 が「目標尺比(85〜100%)」ではなく
 * 「絶対レンジ(minSec〜maxSec)」で判定する。
 * どちらか片方だけの宣言も可(上限だけ・下限だけ)。未宣言なら従来どおり。
 */
export type DurationPolicy = { minSec?: number; maxSec?: number };

/**
 * L7 字幕の数字は算用数字(bible §8。2026-09-23 channel-refine)。字幕に出る文字列
 * (`- display:` があればそれ、無ければ本文)に、数量としての漢数字が残っていれば拾う。
 * 読み上げ本文は漢数字のままでよい(TTS の読みを変えないため display に算用数字を書く)。
 * 慣用句(一生・一人前・一方・一部など)は保護する。「1万5000」の「万」は単位として許す。
 */
const KANJI_DIGITS = "〇一二三四五六七八九十百千";
const COUNTERS = [
  "キロ", "グラム", "メートル", "センチ", "ミリ", "リットル", "時間", "か月", "ヶ月", "カ月", "パーセント",
  "匹", "羽", "頭", "個", "年", "日", "歳", "才", "倍", "割", "回", "本", "枚", "分", "秒", "月", "週",
  "人", "度", "組", "種", "杯", "粒", "億", "万", "兆", "ｍ", "℃",
];
const IDIOMS = [
  "一生", "一人前", "一人暮らし", "一人きり", "一方", "一部", "一度も", "一度きり", "一匹残らず", "一番", "一緒",
  "一気", "一瞬", "一斉", "一面", "一応", "一旦", "一体", "一向", "一層", "一切", "一見", "一歩", "一口", "一息",
  "一目", "一日も", "一日中", "一回り", "十分", "百獣", "八百屋", "千差万別", "十人十色", "一石二鳥", "四六時中",
  "百発百中", "千載一遇", "二度と", "一か八か", "一難去って", "一匹狼", "一族", "一家", "一色", "一筋", "一帯",
];
export function findKanjiNumerals(sub: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`[${KANJI_DIGITS}]+`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(sub))) {
    const rest = sub.slice(m.index);
    if (IDIOMS.some((w) => rest.startsWith(w))) continue;
    // 慣用句の途中(「千差万別」の「万」の後など)にいる場合も除く
    if (IDIOMS.some((w) => { const k = w.indexOf(m![0]); return k > 0 && sub.slice(m!.index - k).startsWith(w); })) continue;
    const after = sub.slice(m.index + m[0].length);
    const counter = COUNTERS.find((c) => after.startsWith(c));
    const multi = m[0].length >= 2 || /[十百千〇]/.test(m[0]);
    if (counter) out.push(m[0] + counter);
    else if (multi) out.push(m[0]);
  }
  return out;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

export function lintScript(
  lines: ParsedScriptLine[],
  targetDurationSec: number,
  speedScale: number,
  durationPolicy?: DurationPolicy | null
): LintResult {
  const violations: Violation[] = [];
  const warnings: Violation[] = [];
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
      warnings.push({
        check: "L1",
        detail: `推定尺${estimatedSec.toFixed(0)}sが下限${minSec}sに届かない(WARN。文字数で埋めず、納品できる「最悪」が足りているかを見直す)`,
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

  // L7 字幕の漢数字
  let l7 = 0;
  for (const l of lines) {
    const sub = l.hints?.display ?? l.text;
    const hits = findKanjiNumerals(sub);
    // 「一」+助数詞(一度・一日・一匹)は慣用で漢字のことが多いので WARN。それ以外は FAIL
    const soft = hits.filter((h) => /^一[^〇一二三四五六七八九十百千]/.test(h));
    const hard = hits.filter((h) => !soft.includes(h));
    if (soft.length) {
      warnings.push({
        check: "L7",
        lineId: l.lineId,
        detail: `字幕の「一」+助数詞: ${soft.join("・")}。数量なら \`- display:\` で算用数字に(慣用なら漢字のまま可)`,
      });
    }
    if (hard.length) {
      l7++;
      violations.push({
        check: "L7",
        lineId: l.lineId,
        detail: `字幕に漢数字: ${hard.join("・")}。行の直下に \`- display:\` で算用数字の字幕を併記する(読み上げ本文は漢数字のままでよい。bible §8)`,
      });
    }
  }
  summary.push(`L7 字幕の漢数字: ${l7}行`);

  return { ok: violations.length === 0, summary, violations, warnings };
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
  for (const w of result.warnings) {
    console.log(`WARN [${w.check}]${w.lineId ? ` ${w.lineId}` : ""}: ${w.detail}`);
  }
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
