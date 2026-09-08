import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeKana,
  parseExpectedReadings,
  diffKana,
  diffReadings,
} from "./diff-readings";

test("normalizeKana: ひらがな→カタカナ・記号除去・長音展開・清音寄せ", () => {
  assert.equal(normalizeKana("てんせい"), "テンセエ");
  assert.equal(normalizeKana("テンセエ"), "テンセエ");
  assert.equal(normalizeKana("きょうりゅう"), "キョオリュウ");
  assert.equal(normalizeKana("キョオリュウ"), "キョオリュウ");
  assert.equal(normalizeKana("コーヒー"), "コオヒイ");
  assert.equal(normalizeKana("つづく・ちぢむ、を!"), "ツズクチジムオ");
  assert.equal(normalizeKana("オメデトオ ゴザイマス。"), "オメデトオゴザイマス");
});

test("parseExpectedReadings: 行IDとカナを拾う。書式揺れに寛容", () => {
  const md = [
    "# 期待読み",
    "",
    "- **L01** おめでとうございます あなたは",
    "- **L02**  ホソナガイカラダニ",
    "L03 これは拾わない",
  ].join("\n");
  const rows = parseExpectedReadings(md);
  assert.deepEqual(rows, [
    { lineId: "L01", expected: "おめでとうございます あなたは" },
    { lineId: "L02", expected: "ホソナガイカラダニ" },
  ]);
});

test("diffKana: 一致なら差分なし、活用の壊れ・音読み化を検出する", () => {
  assert.deepEqual(diffKana("スイツクコト", "スイツクコト"), []);
  // 吸い付く → スイツケ(ep031)
  const h1 = diffKana("サカナニスイツクコト", "サカナニスイツケコト");
  assert.equal(h1.length, 1);
  assert.equal(h1[0].expected, "ク");
  assert.equal(h1[0].actual, "ケ");
  // 八割五分 → ゴブン(ep031)
  const h2 = diffKana("ハチワリゴブデス", "ハチワリゴブンデス");
  assert.equal(h2.length, 1);
  assert.equal(h2[0].expected, "");
  assert.equal(h2[0].actual, "ン");
  // 五大湖 → ゴダイコ(ep031)
  const h3 = diffKana("ゴダイコデ", "ゴダイコデ");
  assert.deepEqual(h3, []);
  const h4 = diffKana("ゴダイコデ", "ゴダイミズウミデ");
  assert.equal(h4.length, 1);
  assert.ok(h4[0].context.includes("ゴダイ"));
});

test("diffReadings: 行ごとに突合し、未記入行と差分行を分けて返す", () => {
  const readings = [
    { lineId: "L01", text: "吸い付く", reading: "スイツケ" },
    { lineId: "L02", text: "転生", reading: "テンセエ" },
    { lineId: "L03", text: "抜け", reading: "ヌケ" },
  ];
  const expected = [
    { lineId: "L01", expected: "すいつく" },
    { lineId: "L02", expected: "てんせい" },
  ];
  const r = diffReadings(readings, expected);
  assert.deepEqual(r.missing, ["L03"]);
  assert.equal(r.matched, 1);
  assert.equal(r.diffs.length, 1);
  assert.equal(r.diffs[0].lineId, "L01");
});

test("diffKana: 発音上の同値(日本・十・そういう・助詞へ)は差分にしない", () => {
  assert.deepEqual(diffKana("ニホンノカワヘハイル", "ニッポンノカワエハイル"), []);
  assert.deepEqual(diffKana("ゴジッセンチ", "ゴジュッセンチ"), []);
  assert.deepEqual(diffKana("ソオイウツクリ", "ソオユウツクリ"), []);
  // ヘ→エ は語中でも無視される(VOICEVOX が子音 h を落とすことは無いので実害なし)。
  // ヘ→他の文字は無視しない
  assert.equal(diffKana("ヘラス", "ケラス").length, 1);
  // 実際の誤読(ep031 v2 で人の視聴もすり抜けた2件)
  assert.equal(diffKana("ホカノサカナ", "タノサカナ").length, 1);
  assert.equal(diffKana("ソノアイダアナタワ", "ソノカンアナタワ").length, 1);
});
