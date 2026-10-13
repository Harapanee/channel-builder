import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hash,
  fileHash,
  assertDuration,
  assertFiles,
  sourceKey,
} from "./provenance";
const expect = (v: any) => ({
  toBe: (x: any) => assert.equal(v, x),
  toEqual: (x: any) => assert.deepEqual(v, x),
  toThrow: () => assert.throws(v),
  not: {
    toBe: (x: any) => assert.notEqual(v, x),
    toThrow: () => assert.doesNotThrow(v),
  },
});
describe("English provenance", () => {
  it("rejects absent, zero and nonfinite duration", () => {
    for (const n of [undefined, 0, -1, NaN, Infinity])
      expect(() => assertDuration(n, "L01")).toThrow();
  });
  it("detects changed WAV bytes", () => {
    const p = path.join(mkdtempSync(path.join(os.tmpdir(), "en-")), "a.wav");
    writeFileSync(p, "before");
    const files = { [p]: fileHash(p) };
    assertFiles(files);
    writeFileSync(p, "after");
    expect(() => assertFiles(files)).toThrow();
  });
  it("keys source content and voice but not placement timing", () => {
    const a = { ja: "猫", en: "cat", voice: { voice: "adam" }, synth: "v1" };
    expect(sourceKey(a)).toBe(sourceKey({ ...a }));
    expect(sourceKey(a)).not.toBe(sourceKey({ ...a, en: "dog" }));
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
  });
});

import { mkdirSync, rmSync } from "node:fs";
import {
  verifySpeech,
  fitBinding,
  lock,
  snapshot,
  saveArtifact,
} from "./provenance";
import { fitDecision } from "./en-plan";
it("does not bless untracked WAVs, invalidates changed text and preserves timing-only reuse", () => {
  const ep = mkdtempSync(path.join(os.tmpdir(), "en-proof-")),
    out = path.join(ep, "out/en");
  mkdirSync(path.join(out, "lines"), { recursive: true });
  writeFileSync(path.join(out, "lines/L01.wav"), "wav");
  const ctx: any = {
    timing: {
      totalDurationSec: 3,
      lines: [{ lineId: "L01", text: "猫", startSec: 0, endSec: 2 }],
    },
    voice: { voice: "adam" },
    sources: { L01: { ja: "猫", en: "cat" } },
  };
  assert.throws(() => verifySpeech(ep, ctx));
  const m = {
    schema: 1,
    lines: {
      L01: {
        source: ctx.sources.L01,
        key: hash(ctx.sources.L01),
        duration: 2,
        speed: 1,
        wavHash: fileHash(path.join(out, "lines/L01.wav")),
      },
    },
  };
  writeFileSync(path.join(out, "speech-manifest.json"), JSON.stringify(m));
  verifySpeech(ep, ctx);
  const before = fitBinding(ep, ctx);
  ctx.timing.lines[0].startSec = 0.1;
  verifySpeech(ep, ctx);
  assert.notEqual(before, fitBinding(ep, ctx));
  ctx.sources.L01.en = "dog";
  assert.throws(() => verifySpeech(ep, ctx));
  rmSync(ep, { recursive: true, force: true });
});
it("serializes writers and releases lock", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "en-lock-"));
  const release = lock(out);
  assert.throws(() => lock(out));
  release();
  lock(out)();
  rmSync(out, { recursive: true, force: true });
});
it("cannot treat NaN duration as an OK fit", () => {
  assert.throws(() =>
    fitDecision({ slotSec: 3, jaDurSec: 2 }, NaN, 1, {
      minSpeed: 0.8,
      maxSpeed: 1.2,
    }),
  );
});
it("released locks remove all process listeners", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "en-listeners-"));
  const events = ["exit", "SIGINT", "SIGTERM"] as const;
  const before = events.map((e) => process.listenerCount(e));
  for (let i = 0; i < 15; i++) lock(dir)();
  assert.deepEqual(
    events.map((e) => process.listenerCount(e)),
    before,
  );
  rmSync(dir, { recursive: true, force: true });
});

import { legacyBgmSegments } from "./legacy-cues";
it("resolved legacy BGM source mutation invalidates the snapshot before a bed is rebuilt", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "en-bgm-")),
    prior = process.cwd();
  try {
    process.chdir(dir);
    mkdirSync("assets/audio/bgm", { recursive: true });
    writeFileSync("assets/audio/bgm/music.mp3", "original");
    const segments = legacyBgmSegments([
      { file: "audio/bgm/music.mp3", startSec: 0, endSec: 5, gainDb: -10 },
    ]);
    const inputs = snapshot(segments.map((s) => s.file));
    assertFiles(inputs);
    writeFileSync("assets/audio/bgm/music.mp3", "modified");
    assert.throws(() => assertFiles(inputs), /stale/);
  } finally {
    process.chdir(prior);
    rmSync(dir, { recursive: true, force: true });
  }
});
