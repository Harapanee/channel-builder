/**
 * 期待読みと VOICEVOX 実読みの機械diff。
 *
 *   npm run diff:readings episodes/<epId>
 *
 * 入力:
 *   - narration/readings.md           VOICEVOX が実際に読むカナ(tts.ts が出す)
 *   - narration/expected-readings.md  台本から起こした期待読み(reading-checker が
 *                                     **readings.md を見る前に**書く。`- **L01** カナ` 形式)
 *
 * 両者をモーラ表記へ正規化して行ごとに突合し、**差分のある行だけ**を出す。
 * 判定はしない(合否権は reading-checker のまま)。exit 1 = 差分あり / exit 2 = 未記入行あり。
 *
 * 【なぜ要るか】ep024・027・029・030・031 で、実読みが readings.md に出ていたのに
 * LLM の読み比べが通し、完成尺の視聴で誤読が見つかった。長いカナ列の照合は LLM が
 * 苦手で、読みを書くのは得意なので、LLM には期待読みを書かせ、照合を機械へ移す。
 * `check-readings.ts`(既知の型の候補抽出)とは補完関係で、こちらは未知の誤読を拾う。
 *
 * 【正規化の約束】実読みは VOICEVOX 流(エイ→エエ・オウ→オオ・助詞「は」→ワ・「へ」→エ・
 * 「を」→オ)なので、期待側もその流儀で書く必要はない — 以下の normalizeKana が
 * 両側を同じ形へ寄せる。ただし助詞の「は/へ」は文脈が要るので期待側が ワ/エ で書く。
 */
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parseReadings, type ReadingLine } from "./check-readings";

const VOWEL_OF: Record<string, string> = {};
{
  const rows: [string, string][] = [
    ["アカサタナハマヤラワガザダバパァャヮ", "ア"],
    ["イキシチニヒミリギジヂビピィ", "イ"],
    ["ウクスツヌフムユルグズヅブプゥュヴ", "ウ"],
    ["エケセテネヘメレゲゼデベペェ", "エ"],
    ["オコソトノホモヨロヲゴゾドボポォョ", "オ"],
  ];
  for (const [chars, v] of rows) for (const c of chars) VOWEL_OF[c] = v;
}

/** 台本読み/実読みの双方を同じモーラ表記へ寄せる。 */
export function normalizeKana(s: string): string {
  // ひらがな → カタカナ
  let t = s.replace(/[ぁ-ゖ]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) + 0x60)
  );
  // カナ・長音符以外(空白・句読点・記号・数字)は落とす。漢字はそのまま残し差分に出す
  t = t.replace(/[^ァ-ヺー一-鿿]/g, "");
  // 長音符 → 直前の母音
  let out = "";
  for (const c of t) {
    if (c === "ー") {
      const prev = out[out.length - 1];
      out += prev ? (VOWEL_OF[prev] ?? "") : "";
    } else out += c;
  }
  // 清音寄せ
  out = out.replace(/ヅ/g, "ズ").replace(/ヂ/g, "ジ").replace(/ヲ/g, "オ");
  // エ段+イ → エ段+エ / オ段+ウ → オ段+オ(VOICEVOX kana 流儀)
  let r = "";
  for (const c of out) {
    const prev = r[r.length - 1];
    if (c === "イ" && prev && VOWEL_OF[prev] === "エ") r += "エ";
    else if (c === "ウ" && prev && VOWEL_OF[prev] === "オ") r += "オ";
    else r += c;
  }
  // 発音上の同値(VOICEVOX 実測: ep031 で差分30行のうち 23行がこの型)
  r = r
    .replace(/ニッポン/g, "ニホン") // 日本
    .replace(/ジュッ/g, "ジッ") // 十(ジッ/ジュッ)
    .replace(/ソオユウ/g, "ソオイウ") // そういう
    .replace(/ドオユウ/g, "ドオイウ"); // どういう
  return r;
}

/**
 * 塊単位で無視してよい差(聞いて意味が変わらない)。期待側が助詞「へ」を ヘ と
 * 書いた場合が大半(実読みは エ)。語中の ヘ も無視されるが、VOICEVOX が子音 h を
 * 落とす誤読は観測されていないので実害はない。
 */
const IGNORABLE_HUNKS: [string, string][] = [["ヘ", "エ"]];

export type ExpectedLine = { lineId: string; expected: string };

/** expected-readings.md を行へ分解する。`- **L01** カナ` の行だけを拾う。 */
export function parseExpectedReadings(md: string): ExpectedLine[] {
  const out: ExpectedLine[] = [];
  for (const raw of md.split("\n")) {
    const m = /^\s*[-*]\s*\*\*(L\d+)\*\*\s*(.*)$/.exec(raw);
    if (!m) continue;
    out.push({ lineId: m[1], expected: m[2].trim() });
  }
  return out;
}

export type Hunk = {
  /** 期待側の差分文字列(削除分) */
  expected: string;
  /** 実読み側の差分文字列(挿入分) */
  actual: string;
  /** 実読み側の前後4文字を含む文脈(差分は【】で囲む) */
  context: string;
};

/**
 * 正規化済みカナ2本の文字単位 LCS diff。近接(2文字以内)する差分は1つの塊に併合する。
 * a=期待、b=実読み。
 */
export function diffKana(aRaw: string, bRaw: string): Hunk[] {
  const a = normalizeKana(aRaw);
  const b = normalizeKana(bRaw);
  const n = a.length;
  const m = b.length;
  // LCS 表
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // 復元: 各位置に対し (equal|del|ins) の列
  type Op = { t: "=" | "-" | "+"; c: string; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ t: "=", c: a[i], bi: j });
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push({ t: "+", c: b[j], bi: j });
      j += 1;
    } else {
      ops.push({ t: "-", c: a[i], bi: j });
      i += 1;
    }
  }
  // 塊へ併合(等しい文字が2文字以内なら同じ塊)
  const hunks: { del: string; ins: string; bStart: number; bEnd: number }[] = [];
  let cur: (typeof hunks)[number] | null = null;
  let eqRun = 0;
  for (const op of ops) {
    if (op.t === "=") {
      eqRun += 1;
      if (cur && eqRun > 2) {
        hunks.push(cur);
        cur = null;
      }
      continue;
    }
    if (cur && eqRun > 0 && eqRun <= 2) {
      // 直前の等しい文字を塊へ取り込む
      const bridge = b.slice(cur.bEnd, op.bi);
      cur.del += bridge;
      cur.ins += bridge;
      cur.bEnd = op.bi;
    }
    if (!cur) cur = { del: "", ins: "", bStart: op.bi, bEnd: op.bi };
    eqRun = 0;
    if (op.t === "-") cur.del += op.c;
    else {
      cur.ins += op.c;
      cur.bEnd = op.bi + 1;
    }
  }
  if (cur) hunks.push(cur);
  return hunks
    .filter((h) => !IGNORABLE_HUNKS.some(([e, a]) => h.del === e && h.ins === a))
    .map((h) => ({
    expected: h.del,
    actual: h.ins,
    context:
      b.slice(Math.max(0, h.bStart - 4), h.bStart) +
      "【" +
      h.ins +
      "】" +
      b.slice(h.bEnd, h.bEnd + 4),
  }));
}

export type LineDiff = {
  lineId: string;
  text: string;
  expected: string;
  reading: string;
  hunks: Hunk[];
};

export function diffReadings(
  readings: ReadingLine[],
  expected: ExpectedLine[]
): { diffs: LineDiff[]; matched: number; missing: string[] } {
  const exp = new Map(expected.map((e) => [e.lineId, e.expected]));
  const diffs: LineDiff[] = [];
  const missing: string[] = [];
  let matched = 0;
  for (const r of readings) {
    const e = exp.get(r.lineId);
    if (e === undefined || e === "") {
      missing.push(r.lineId);
      continue;
    }
    const hunks = diffKana(e, r.reading);
    if (hunks.length === 0) matched += 1;
    else diffs.push({ lineId: r.lineId, text: r.text, expected: e, reading: r.reading, hunks });
  }
  return { diffs, matched, missing };
}

function main(): void {
  const epArg = process.argv[2];
  if (!epArg) {
    console.error("Usage: diff-readings.ts episodes/<epId>");
    process.exit(2);
  }
  const dir = join(process.cwd(), epArg, "narration");
  const readingsPath = join(dir, "readings.md");
  const expectedPath = join(dir, "expected-readings.md");
  for (const p of [readingsPath, expectedPath]) {
    if (!existsSync(p)) {
      console.error(`見つかりません: ${p}`);
      process.exit(2);
    }
  }
  const readingsMd = readFileSync(readingsPath, "utf-8");
  if (readingsMd.includes("(fishaudio)")) {
    console.error("readings.md が fishaudio 形式(実読みなし)のため diff できません");
    process.exit(2);
  }
  const rows = parseReadings(readingsMd);
  const exp = parseExpectedReadings(readFileSync(expectedPath, "utf-8"));
  const r = diffReadings(rows, exp);

  console.log(
    `読み突合: ${rows.length}行 / 一致 ${r.matched} / 差分 ${r.diffs.length} / 期待未記入 ${r.missing.length}`
  );
  for (const d of r.diffs) {
    console.log(`\n${d.lineId} ${d.text}`);
    console.log(`  期待: ${normalizeKana(d.expected)}`);
    console.log(`  実読: ${normalizeKana(d.reading)}`);
    for (const h of d.hunks) {
      console.log(`  差分: 期待「${h.expected}」→ 実読「${h.actual}」 … ${h.context}`);
    }
  }
  if (r.missing.length > 0) {
    console.log(`\n期待読みが未記入の行: ${r.missing.join(" ")}`);
    console.log("→ expected-readings.md を全行ぶん書いてから再実行する");
    process.exit(2);
  }
  if (r.diffs.length > 0) {
    console.log(
      "\n→ 差分行を reading-checker が1行ずつ判定する(期待側の誤り / VOICEVOX の誤読 / 許容差)。判定はここではしない"
    );
    process.exit(1);
  }
  console.log("差分なし。全行の実読みが期待読みと一致した");
}

if (process.argv[1] && /diff-readings\.ts$/.test(process.argv[1])) main();
