import assert from "node:assert/strict";
import test from "node:test";
import {
  findMissingAssets,
  isAssetTableSource,
  keysIn,
  MIN_PARSE_COVERAGE,
  parseAssetTable,
  parseClipBlocks,
  parseConstAliases,
  parseCoverage,
  parseStoryboardRows,
  resolveClipAssets,
} from "./check-storyboard-assets";

const TABLE = `
const A = {
  octopusAdultCanonical: { p: "assets/characters/octopus-adult/canonical.rmbg.png", ar: 1.0000, b: [0, 0, 1, 1] }, // char_octopus_adult_canonical
  octopusParalarvaCanonical: { p: "assets/characters/octopus-paralarva/canonical.rmbg.png", ar: 1.0000, b: [0, 0, 1, 1] }, // char_octopus_paralarva_canonical
  rockyReefSeafloorJpBase: { p: "assets/places/rocky-reef/base.png", ar: 0.5625, b: [0, 0, 1, 1] }, // place_rocky_reef_seafloor_jp_base
};
const REEF = "rockyReefSeafloorJpBase";
`;

test("parseAssetTable: キー→assetId を読む", () => {
  const t = parseAssetTable(TABLE);
  assert.equal(t.get("octopusAdultCanonical"), "char_octopus_adult_canonical");
  assert.equal(t.get("rockyReefSeafloorJpBase"), "place_rocky_reef_seafloor_jp_base");
  assert.equal(t.size, 3);
});

test("parseConstAliases: 舞台キーの別名を解決する", () => {
  const keys = new Set(parseAssetTable(TABLE).keys());
  assert.equal(parseConstAliases(TABLE, keys).get("REEF"), "rockyReefSeafloorJpBase");
});

test("isAssetTableSource: 素材テーブル本体を見分ける(全clipが全素材を継承する事故を防ぐ)", () => {
  assert.ok(isAssetTableSource(TABLE));
  assert.ok(!isAssetTableSource(`{ strands: 13, swing: 3.5 }`));
});

test("parseClipBlocks: function 形式(ep011/ep012)と アロー形式(ep009/ep010)の両方を読む", () => {
  const html = `
SCENES.cL01 = function (g, D) { var c = scene("cL01"); pic(c, "octopusAdultCanonical", {}); };
SCENES.cL02 = (g,D)=>{ const c=scene("cL02"); char(c,A.octopusParalarvaCanonical,{}); };`;
  const blocks = parseClipBlocks(html);
  assert.deepEqual([...blocks.keys()], ["cL01", "cL02"]);
  assert.ok(blocks.get("cL01")!.includes("octopusAdultCanonical"));
});

test("keysIn: 文字列リテラルとプロパティ参照の両方を拾う", () => {
  const keys = new Set(parseAssetTable(TABLE).keys());
  const aliases = parseConstAliases(TABLE, keys);
  assert.deepEqual([...keysIn(`pic(c, "octopusAdultCanonical", {})`, keys, aliases)], ["octopusAdultCanonical"]);
  assert.deepEqual([...keysIn(`char(c, A.octopusParalarvaCanonical, {})`, keys, aliases)], ["octopusParalarvaCanonical"]);
  assert.deepEqual([...keysIn(`epBase(c, { stage: REEF })`, keys, aliases)], ["rockyReefSeafloorJpBase"]);
});

test("resolveClipAssets: 共有ヘルパー経由の素材も clip の参照として数える(paralarva 方式)", () => {
  const html = `${TABLE}
function paralarva(host, o) {
  return pic(host, "octopusParalarvaCanonical", { vw: 200 });
}
SCENES.cL26 = function (g, D) {
  var c = scene("cL26");
  epBase(c, { stage: REEF });
  var sb = paralarva(c, { cx: 960, cy: 430, R: 105 });
};`;
  const used = resolveClipAssets(html).get("cL26")!;
  assert.ok(used.has("char_octopus_paralarva_canonical"), "ヘルパー経由の素材が数えられること");
  assert.ok(used.has("place_rocky_reef_seafloor_jp_base"), "const 別名の舞台が数えられること");
});

test("parseStoryboardRows: 角括弧つきの未生成マーカーも assetId として読む", () => {
  const md = `
| clipId | 開始秒 | 尺 | lineIds | role | 演出記述 | 使用素材 | SE |
| cL26 | 78.63 | 2.13 | L26 | show | 腕を8本広げる | \`[char_octopus_paralarva_canonical]\` | — |
| cL58 | 179.06 | 2.89 | L58 | contrast | path morph | \`[char_octopus_adult_canonical]\` | — |
| 見出し行や本文はここで無視される |`;
  const rows = parseStoryboardRows(md);
  assert.deepEqual(rows.get("cL26"), ["char_octopus_paralarva_canonical"]);
  assert.equal(rows.size, 2);
});

test("findMissingAssets: キャラ素材の指定に対しキャラ素材が1枚も無ければ BLOCK(ep012 幼生タコの再現)", () => {
  const sb = new Map([["cL26", ["char_octopus_paralarva_canonical"]]]);
  // 修正前: 舞台だけ使い、体は softBody で描き起こしていた
  const before = new Map([["cL26", new Set(["place_open_ocean_blue"])]]);
  assert.deepEqual(findMissingAssets(sb, before), [
    { clipId: "cL26", assetId: "char_octopus_paralarva_canonical", severity: "BLOCK" },
  ]);
  // 修正後: 素材で体を描いている
  const after = new Map([["cL26", new Set(["place_open_ocean_blue", "char_octopus_paralarva_canonical"])]]);
  assert.deepEqual(findMissingAssets(sb, after), []);
});

test("findMissingAssets: 別のキャラ素材を使っているなら ADVISE 止まり(意図的な差し替えを遮断しない)", () => {
  const sb = new Map([["cL37", ["char_octopus_paralarva_canonical"]]]);
  const impl = new Map([["cL37", new Set(["char_copepod_canonical"])]]);
  assert.deepEqual(findMissingAssets(sb, impl), [
    { clipId: "cL37", assetId: "char_octopus_paralarva_canonical", severity: "ADVISE" },
  ]);
});

test("findMissingAssets: 実装の無い clip は判定しない(被覆検査の担当)", () => {
  const sb = new Map([["cL99", ["char_x_y"]]]);
  assert.deepEqual(findMissingAssets(sb, new Map()), []);
});

test("parseCoverage: SCENES への代入数と、本体を解析できた数を返す", () => {
  const html = `
const SCENES = {};
SCENES.cL01 = function (c, g, D) { pic(c, "antWorkerCanonical"); };
SCENES.cL02 = (g, D) => { paper(c); };
SCENES["cL03"] = SC("cL03", function (c, g, D) { stage(c, "nestBase"); });
`;
  const cov = parseCoverage(html);
  assert.equal(cov.assigned, 3, "SCENES への代入は3件");
  assert.equal(cov.parsed, 3, "3件とも本体を取り出せている");
});

test("解析器が clip 本体を取れないときは検査不能とわかる(黙って緑にしない)", () => {
  /* ep013 は `SCENES.cL01 = SC("cL01", function (c, g, D) {` というラッパ形式を
     使ったため、旧解析器は clip を1件も取り出せず「0 clip を検査 → OK」で
     exit 0 していた。**解析できない検査は緑ではなく「検査不能」**でなければならない。 */
  const html = `
const SCENES = {};
SCENES.cL01 = MAKE\`cL01\`;
SCENES.cL02 = MAKE\`cL02\`;
`;
  const cov = parseCoverage(html);
  assert.equal(cov.assigned, 2);
  assert.equal(cov.parsed, 0);
  assert.ok(cov.parsed / cov.assigned < MIN_PARSE_COVERAGE, "被覆率が下限を下回る=検査不能");
});
