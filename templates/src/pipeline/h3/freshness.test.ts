import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAmbientRecord,
  checkFreshness,
  clipFingerprint,
  collectClipFingerprints,
  currentInputs,
  episodeInputPaths,
  loadEpisodeFreshness,
  formatFreshness,
  nextIndexInputs,
  readSubsLedger,
  sha1OfFile,
} from "./freshness";
import type { Segment } from "./assemble";

const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "h3-fresh-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("sha1OfFile: 中身の sha1(16進40桁)。無ければ null", () => {
  withDir((d) => {
    const p = join(d, "a.json");
    writeFileSync(p, "abc");
    assert.equal(sha1OfFile(p), "a9993e364706816aba3e25717850c26c9cd0d89d");
    assert.equal(sha1OfFile(join(d, "none.json")), null);
  });
});

test("currentInputs: 在るファイルだけを名前つきで返す", () => {
  withDir((d) => {
    writeFileSync(join(d, "timing.json"), "{}");
    const got = currentInputs({ timing: join(d, "timing.json"), sePlan: join(d, "se-plan.json") });
    assert.deepEqual(Object.keys(got), ["timing"]);
  });
});

test("checkFreshness: 記録と現在が一致すれば何も出ない", () => {
  const r = checkFreshness(
    [{ name: "subs.json", inputs: { timing: "t1" }, expect: ["timing"], rebuild: "npm run h3:subs x" }],
    { timing: "t1" },
  );
  assert.deepEqual(r.stale, []);
  assert.deepEqual(r.legacy, []);
});

test("checkFreshness: timing が変わったら焼き直す成果物と変わった入力を返す", () => {
  const r = checkFreshness(
    [
      { name: "subs.json", inputs: { timing: "t1" }, expect: ["timing"], rebuild: "npm run h3:subs x" },
      { name: "figures/index.json", inputs: { timing: "t1", cuts: "c1", figures: "f1" }, expect: ["timing", "cuts", "figures"], rebuild: "npm run h3:figures -- x" },
    ],
    { timing: "t2", cuts: "c1", figures: "f1" },
  );
  assert.deepEqual(r.stale.map((s) => [s.name, s.changed]), [["subs.json", ["timing"]], ["figures/index.json", ["timing"]]]);
});

test("checkFreshness: 記録時に無かった入力が今はある(se-plan.json を後から書いた)も古い扱い", () => {
  const r = checkFreshness(
    [{ name: "audio-cues.json", inputs: { timing: "t1", bgmPlan: "b1" }, expect: ["timing", "bgmPlan", "sePlan"], rebuild: "h3:audio-cues" }],
    { timing: "t1", bgmPlan: "b1", sePlan: "s1" },
  );
  assert.deepEqual(r.stale[0].changed, ["sePlan"]);
});

test("checkFreshness: inputs を持たない古い成果物は legacy に分ける(止めない)", () => {
  const r = checkFreshness(
    [{ name: "subs.json", inputs: undefined, expect: ["timing"], rebuild: "npm run h3:subs x" }],
    { timing: "t1" },
  );
  assert.deepEqual(r.stale, []);
  assert.deepEqual(r.legacy.map((l) => l.name), ["subs.json"]);
});

test("formatFreshness: 焼き直しのコマンドを並べる", () => {
  const lines = formatFreshness({
    stale: [{ name: "subs.json", changed: ["timing"], rebuild: "npm run h3:subs x" }],
    legacy: [{ name: "audio-cues.json", rebuild: "npm run h3:audio-cues -- x" }],
  });
  assert.ok(lines.errors.some((l) => l.includes("subs.json") && l.includes("timing") && l.includes("npm run h3:subs x")));
  assert.ok(lines.warnings.some((l) => l.includes("audio-cues.json")));
});

test("nextIndexInputs: 全部焼いたなら現在の inputs を記録する", () => {
  assert.deepEqual(nextIndexInputs(undefined, { timing: "t2" }, false), { timing: "t2" });
});

test("nextIndexInputs: --only の部分焼きは、前回と入力が同じときだけ現在を記録する", () => {
  assert.deepEqual(nextIndexInputs({ timing: "t1" }, { timing: "t1" }, true), { timing: "t1" });
  // 入力が変わったのに一部しか焼いていない → 前回の記録のまま(assemble が古いと止める)
  assert.deepEqual(nextIndexInputs({ timing: "t1" }, { timing: "t2" }, true), { timing: "t1" });
  assert.equal(nextIndexInputs(undefined, { timing: "t2" }, true), undefined);
});

test("readSubsLedger: 旧形式(配列)は inputs 無しとして読む", () => {
  const r = readSubsLedger([{ id: "L01", png: "/a.png", start: 0, end: 1 }]);
  assert.equal(r.inputs, undefined);
  assert.equal(r.entries.length, 1);
});

test("readSubsLedger: 新形式({inputs, entries})を読む", () => {
  const r = readSubsLedger({ inputs: { timing: "t1" }, entries: [{ id: "L01", png: "/a.png", start: 0, end: 1 }] });
  assert.deepEqual(r.inputs, { timing: "t1" });
  assert.equal(r.entries[0].id, "L01");
});

test("clipFingerprint: サイズと mtime で作る", () => {
  assert.equal(clipFingerprint({ size: 10, mtimeMs: 1234.5 }), "10:1234.5");
});

const seg = (clipId: string, card = false): Segment =>
  ({ clipId, lineIds: [], startSec: 0, frames: 24, offsetFrames: 0, holdSlow: false, skipHeadFrames: 0, noSub: false, card });

test("collectClipFingerprints: 章カードと無いクリップは数えない", () => {
  withDir((d) => {
    writeFileSync(join(d, "cL01.mp4"), "xx");
    writeFileSync(join(d, "cL02.mp4"), "yyy");
    utimesSync(join(d, "cL01.mp4"), 1000, 1000);
    const got = collectClipFingerprints([seg("cL01"), seg("cL02", true), seg("cL03")], (s) => join(d, s.clipId + ".mp4"));
    assert.deepEqual(Object.keys(got), ["cL01"]);
    assert.equal(got.cL01, "2:1000000");
  });
});

test("checkAmbientRecord: 一致すれば何も出ない", () => {
  const rec = { inputs: { timing: "t", cuts: "c", ambient: "a" }, clips: { cL01: "1:1" } };
  assert.deepEqual(checkAmbientRecord(rec, { inputs: { timing: "t", cuts: "c", ambient: "a" }, clips: { cL01: "1:1" } }), []);
});

test("checkAmbientRecord: クリップの差し替え(reject→run)を検出する", () => {
  const rec = { inputs: { timing: "t", cuts: "c" }, clips: { cL01: "1:1", cL02: "1:1" } };
  const out = checkAmbientRecord(rec, { inputs: { timing: "t", cuts: "c" }, clips: { cL01: "1:1", cL02: "5:9" } });
  assert.equal(out.length, 1);
  assert.match(out[0], /ambient_stale/);
  assert.match(out[0], /cL02/);
});

test("checkAmbientRecord: 入力(timing/cuts/ambient.json)の変更を検出する", () => {
  const out = checkAmbientRecord(
    { inputs: { timing: "t", cuts: "c", ambient: "a" }, clips: {} },
    { inputs: { timing: "t", cuts: "c2", ambient: "a2" }, clips: {} },
  );
  assert.equal(out.length, 1);
  assert.match(out[0], /cuts/);
  assert.match(out[0], /ambient/);
});

test("loadEpisodeFreshness: timing.json を直したのに h3:subs / h3:figures / h3:audio-cues を焼き直していなければ3つとも古い", () => {
  withDir((root) => {
    const ep = "ep999-x";
    const e = join(root, "episodes", ep);
    const h = join(root, "h3/episodes", ep);
    mkdirSync(join(h, "subs"), { recursive: true });
    mkdirSync(join(h, "figures"), { recursive: true });
    mkdirSync(e, { recursive: true });
    writeFileSync(join(e, "timing.json"), "{\"v\":1}");
    writeFileSync(join(h, "cuts.json"), "{}");
    writeFileSync(join(h, "figures.json"), "{}");
    writeFileSync(join(e, "bgm-plan.json"), "{}");
    const now = currentInputs(episodeInputPaths(root, ep));
    writeFileSync(join(h, "subs/subs.json"), JSON.stringify({ inputs: { timing: now.timing }, entries: [] }));
    writeFileSync(join(h, "figures/index.json"), JSON.stringify({ episodeId: ep, fps: 24, entries: [], inputs: { timing: now.timing, cuts: now.cuts, figures: now.figures } }));
    writeFileSync(join(e, "audio-cues.json"), JSON.stringify({ se: [], inputs: { timing: now.timing, bgmPlan: now.bgmPlan } }));
    assert.deepEqual(loadEpisodeFreshness(root, ep).stale, []);

    writeFileSync(join(e, "timing.json"), "{\"v\":2}");
    const r = loadEpisodeFreshness(root, ep);
    assert.deepEqual(r.stale.map((s) => s.name).sort(), ["audio-cues.json", "figures/index.json", "subs/subs.json"]);
    assert.ok(r.stale.every((s) => s.changed.includes("timing")));
  });
});

test("loadEpisodeFreshness: 古い形式(inputs 無し)は legacy、無いファイルは数えない", () => {
  withDir((root) => {
    const ep = "ep999-x";
    mkdirSync(join(root, "h3/episodes", ep, "subs"), { recursive: true });
    mkdirSync(join(root, "episodes", ep), { recursive: true });
    writeFileSync(join(root, "episodes", ep, "timing.json"), "{}");
    writeFileSync(join(root, "h3/episodes", ep, "subs/subs.json"), "[]");
    const r = loadEpisodeFreshness(root, ep);
    assert.deepEqual(r.stale, []);
    assert.deepEqual(r.legacy.map((l) => l.name), ["subs/subs.json"]);
  });
});
