/**
 * 誤読リスクの機械抽出。
 *
 *   npm run check:readings episodes/<epId>
 *
 * `narration/readings.md`(VOICEVOX の実読みレポート)の**台本表記と実読みカナを機械で突合**し、
 * 危険パターンに当たる行を候補リストとして出す。**判定はしない**(合否権は reading-checker のまま)。
 * この道具の役割は、204行のカナ列を目視で総当たりさせるのをやめ、
 * 「機械が挙げた候補を全部潰す」仕事へ変えることである。
 *
 * 【なぜ要るか】2026-09-02 ep024-chameleon で、reading-checker が 204行を1回のReadで見て
 * 2件しか挙げられず、ユーザーが完成尺を視聴して誤読7件を発見した。定義には既に
 * 「全語を突合する」「難易度で選別しない」と書いてあったので、散文の追記では直らない。
 * 見逃した7件は5つの型に収まり、いずれも(表記, 読み)の対で機械判定できる。
 *
 * 【横断適用】1件見つかったら同じ表記を含む**全行**を並べて出す。
 * ep024 では「種→タネ」を3行、「虫→チュウ」を3行落としており、
 * 1件直して残りを放置する事故がこのゲートの主目的である。
 *
 * 【辞書の分離】ここに書くのは題材に依存しない規則だけ。生物用語など
 * チャンネル固有の語族は `channel/reading-risks.json`(あれば読む)に足す。
 * 混ぜると /system-refine のテンプレート同期でチャンネルの語が他所へ漏れる。
 */
import { basename, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

/** 台本表記の危険パターンと、それが選ばれたら誤読である読み。 */
export type ReadingRisk = {
  /** 規則の名前(報告に出る) */
  id: string;
  /** 台本テキスト側の検出パターン */
  text: string;
  /** 実読みカナ側の検出パターン。両方当たった行を候補にする */
  reading: string;
  /** 何が起きているか(1行) */
  why: string;
  /** 直し方の例 */
  fix: string;
};

/**
 * 題材に依存しない規則。全て 2026-09-02 の ep024-chameleon 実測に基づく。
 * **推測で足さない** — 実際に誤読が観測された型だけを置く(空振りが増えると候補リストが読まれなくなる)。
 */
export const BUILTIN_RISKS: ReadingRisk[] = [
  {
    id: "particle-ha",
    /**
     * 漢字で終わる語に続く助詞「は」。ワ と読まれるのが正。
     * **直後のかなを限定するのが要点**。ep024 の事故は「心配は+いりません」が
     * 「心配+はいり(入り)」と語境界を取られたもので、事故るのは
     * は+次のかな が実在語(はいる/はな/はし/はず/はら/はか)になる位置に限られる。
     * 限定しないと ep024 実測で 23/204行 が当たり(測る=ハカル・葉=ハ・大半=ハン等)、
     * 候補リストが読まれなくなる。限定後は同じ204行で誤検出0・旧L09のみ発火を確認した。
     */
    text: "[\\u4e00-\\u9fff]は[いじずなしらか]",
    reading: "ハ",
    why: "助詞の「は」が ワ ではなく ハ と読まれた可能性(直後のかなと結合して別語になった)",
    fix: "「〜は」を落とすか読点で切る(例: 「心配はいりません」→「心配いりません」)",
  },
  {
    id: "mushi",
    // 単独の「虫」。寄生虫・条虫・線虫・原虫・甲虫などの複合語は チュウ が正
    text: "(?<![寄生条線原甲昆益害幼成])虫(?![類])",
    reading: "チュウ",
    why: "単独の「虫」が むし ではなく チュウ と読まれた可能性",
    fix: "「むし」とひらがなに開き、字幕は `- display:` で「虫」を維持する",
  },
  {
    id: "shu",
    // 「種」単独。種類・種族・種子・品種などは正しく読まれる
    text: "(?<![品人業])種(?![類族子])",
    reading: "タネ",
    why: "生物の「種(しゅ)」が たね と読まれた可能性",
    fix: "「種類」「なかま」へ言い換える",
  },
  {
    id: "bunno",
    text: "[一二三四五六七八九十百千0-9０-９]分の",
    reading: "プンノ",
    why: "分数の「分の」が ぶんの ではなく ぷんの(時間の分)と読まれた可能性",
    fix: "「さんぶんのいち」のようにひらがなで書き、字幕は `- display:` で「3分の1」を維持する",
  },
  {
    id: "futari-gumi",
    text: "二人",
    reading: "ニニン",
    why: "「二人」が ふたり ではなく ににん と読まれた可能性",
    fix: "「ふたり」とひらがなに開き、字幕は `- display:` で「二人」を維持する",
  },
];

export type ReadingLine = { lineId: string; text: string; reading: string };

/** readings.md を行へ分解する。VOICEVOX 形式(`- **L01** 本文` / `  - 読み: カナ`)のみ。 */
export function parseReadings(md: string): ReadingLine[] {
  const out: ReadingLine[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^- \*\*(L\d+)\*\* (.*)$/.exec(lines[i]);
    if (!head) continue;
    const body = /^\s*- 読み: (.*)$/.exec(lines[i + 1] ?? "");
    out.push({ lineId: head[1], text: head[2], reading: body ? body[1] : "" });
  }
  return out;
}

export type Hit = { risk: ReadingRisk; lineId: string; text: string; reading: string };

/**
 * 候補を挙げる。**当たった行だけでなく、同じ表記を含む全行を返す**(横断適用の強制)。
 * `matched` が false の行は「同じ表記だが読みは今のところ正しい」= 直すときに一緒に見る対象。
 */
export function findRisks(
  rows: ReadingLine[],
  risks: ReadingRisk[],
): { risk: ReadingRisk; hits: Hit[]; siblings: ReadingLine[] }[] {
  const out: { risk: ReadingRisk; hits: Hit[]; siblings: ReadingLine[] }[] = [];
  for (const risk of risks) {
    const textRe = new RegExp(risk.text);
    const readRe = new RegExp(risk.reading);
    const hits: Hit[] = [];
    const siblings: ReadingLine[] = [];
    for (const r of rows) {
      if (!textRe.test(r.text)) continue;
      if (readRe.test(r.reading)) hits.push({ risk, ...r });
      else siblings.push(r);
    }
    if (hits.length > 0) out.push({ risk, hits, siblings });
  }
  return out;
}

/** チャンネル固有の語族。無ければ空。 */
export function loadChannelRisks(root: string): ReadingRisk[] {
  const p = join(root, "channel", "reading-risks.json");
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, "utf8")) as { risks?: ReadingRisk[] };
  return raw.risks ?? [];
}

function main(): void {
  const dir = process.argv[2];
  if (!dir) {
    console.error("使い方: npm run check:readings episodes/<epId>");
    process.exit(2);
  }
  const md = join(dir, "narration", "readings.md");
  if (!existsSync(md)) {
    console.error(
      "readings.md がありません: " + md + "\n先に `npm run tts " + dir + " -- --readings-only` を実行してください",
    );
    process.exit(2);
  }
  const body = readFileSync(md, "utf8");
  if (!body.includes("VOICEVOX実読み")) {
    console.log("実読みのレポートではないため突合できません(fishaudio 等)。reading-checker の表記ベース検査へ回します");
    process.exit(0);
  }
  const rows = parseReadings(body);
  const risks = [...BUILTIN_RISKS, ...loadChannelRisks(process.cwd())];
  const found = findRisks(rows, risks);

  console.log(`誤読リスク検査: ${rows.length}行 / 規則 ${risks.length}件`);
  if (found.length === 0) {
    console.log("候補 0件。reading-checker の全行突合へ進んでください(この検査は既知の型しか見ません)");
    process.exit(0);
  }
  let total = 0;
  for (const f of found) {
    total += f.hits.length;
    console.log(`\n[${f.risk.id}] ${f.risk.why}`);
    console.log(`  直し方: ${f.risk.fix}`);
    for (const h of f.hits) console.log(`  ❗ ${h.lineId} ${h.text}\n     読み: ${h.reading}`);
    if (f.siblings.length > 0) {
      console.log(`  ◻ 同じ表記を含む他の${f.siblings.length}行(読みは今のところ正しい。直すときは横断で見ること):`);
      for (const s of f.siblings) console.log(`     ${s.lineId} ${s.text.slice(0, 40)}`);
    }
  }
  console.log(`\n候補 ${total}件。**全件について reading-checker が PASS/REVISE を報告すること**`);
  console.log("※ この検査は既知の型しか見ない。候補ゼロでも全行突合を省略しない");
  process.exit(1);
}

if (process.argv[1] && basename(process.argv[1]) === "check-readings.ts") main();
