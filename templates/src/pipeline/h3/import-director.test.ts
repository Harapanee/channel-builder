import assert from "node:assert/strict";
import test from "node:test";
import { buildFromDirector, chapterOfLines, firstWorstOf, parseDirectorMd, renderShotsTs } from "./import-director";
import type { TimingLine } from "./plan";

const md = `# 何か前置き

## カット

### cL01
- lines: L01, L02
- chain: no
- body: A wide shot of a village.
- sound: river water

### cL03
- lines: L03
- chain: yes
- seed: 7
- body: The boy keeps walking.
- sound: footsteps at 00:02.000
`;

const line = (lineId: string, startSec: number): TimingLine => ({ lineId, startSec, endSec: startSec + 1 } as TimingLine);
const timing = { totalDurationSec: 20, lines: [line("L01", 0), line("L02", 3), line("L03", 8)] };
const script = `# 台本\n\n## [L01] 1 誕生\n> a\n\n## [L02] 1 誕生\n> b\n\n## [L03] 2 年齢のはしご\n> c\n`;

test("演出家の md からカットを読む(seed は任意)", () => {
  const cuts = parseDirectorMd(md);
  assert.equal(cuts.length, 2);
  assert.deepEqual(cuts[0], { id: "cL01", lineIds: ["L01", "L02"], chain: false, body: "A wide shot of a village.", sound: "river water" });
  assert.equal(cuts[1].chain, true);
  assert.equal(cuts[1].seed, 7);
});

test("台本の段見出しから行→章を決める", () => {
  const m = chapterOfLines(script);
  assert.equal(m.get("L01"), "1 誕生");
  assert.equal(m.get("L03"), "2 年齢のはしご");
});

test("台帳を組む: 章・尺(区間以上・下限)・鎖", () => {
  const r = buildFromDirector("epX", parseDirectorMd(md), timing, chapterOfLines(script));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.cutsFile.chapters.map((c) => [c.id, c.name, c.cuts]), [["ch00", "誕生", ["cL01"]], ["ch01", "年齢のはしご", ["cL03"]]]);
  assert.equal(r.cutsFile.cuts.cL01.seconds, 8);
  assert.ok(r.cutsFile.cuts.cL03.seconds >= 12);
  assert.equal(r.cutsFile.cuts.cL03.chain, true);
  assert.equal(r.shots.cL03.seed, 7);
});

test("行の取りこぼし・順序違い・ID不一致・15秒超を問題として返す", () => {
  const bad = parseDirectorMd(md.replace("L01, L02", "L01").replace("### cL03", "### cL09"));
  const r = buildFromDirector("epX", bad, { ...timing, totalDurationSec: 30 }, chapterOfLines(script));
  const text = r.problems.join("\n");
  assert.match(text, /L02/);
  assert.match(text, /cL09/);
  assert.match(text, /15秒|上限/);
});

test("既存台帳の skipHeadFrames / holdSlow は同じカットIDへ引き継ぐ", () => {
  const prev = { cL01: { lineIds: ["L01", "L02"], seconds: 8, place: "", subject: "", role: "", skipHeadFrames: 6, holdSlow: true } };
  const r = buildFromDirector("epX", parseDirectorMd(md), timing, chapterOfLines(script), prev);
  assert.equal(r.cutsFile.cuts.cL01.skipHeadFrames, 6);
  assert.equal(r.cutsFile.cuts.cL01.holdSlow, true);
  assert.equal(r.cutsFile.cuts.cL03.skipHeadFrames, undefined);
});

test("章ファイルの TS は文字列をそのまま埋め、鎖と seed を持つ", () => {
  const r = buildFromDirector("epX", parseDirectorMd(md), timing, chapterOfLines(script));
  const ts = renderShotsTs(["cL03"], r.shots, "年齢のはしご");
  assert.match(ts, /export default shots/);
  assert.match(ts, /"The boy keeps walking\."/);
  assert.match(ts, /chain: true/);
  assert.match(ts, /seed: 7/);
  assert.doesNotMatch(ts, /vocab\./);
});

test("区間が短く早回しが上限を超えるカットは holdSlow(頭から等速・余りは切る)", () => {
  const short = { totalDurationSec: 10.5, lines: [line("L01", 0), line("L02", 3), line("L03", 8)] };
  const r = buildFromDirector("epX", parseDirectorMd(md), short, chapterOfLines(script));
  assert.equal(r.cutsFile.cuts.cL03.holdSlow, true);
  assert.equal(r.cutsFile.cuts.cL01.holdSlow, undefined);
});

test("前置きの firstWorstLineId: を台帳へ写す(無ければ書かない)", () => {
  const r = buildFromDirector("epX", parseDirectorMd(md), timing, chapterOfLines(script), undefined, firstWorstOf("firstWorstLineId: L02\n" + md));
  assert.equal(r.cutsFile.firstWorstLineId, "L02");
  const r2 = buildFromDirector("epX", parseDirectorMd(md), timing, chapterOfLines(script));
  assert.equal("firstWorstLineId" in r2.cutsFile, false);
});

test("chainFrom(画像起点の作り直し)を台帳と宣言へ写す", () => {
  const m2 = md.replace("- chain: yes\n- seed: 7", "- chain: no\n- chainFrom: imgL03");
  const r = buildFromDirector("epX", parseDirectorMd(m2), timing, chapterOfLines(script));
  assert.equal(r.cutsFile.cuts.cL03.chainFrom, "imgL03");
  assert.equal(r.shots.cL03.chainFrom, "imgL03");
  assert.match(renderShotsTs(["cL03"], r.shots, "x"), /chainFrom: "imgL03"/);
});
