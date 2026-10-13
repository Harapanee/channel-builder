import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeStatus, validateEvidence } from "./en-status";
const expect = (v: any) => ({
  toBe: (x: any) => assert.equal(v, x),
  toEqual: (x: any) => assert.deepEqual(v, x),
  toThrow: () => assert.throws(v),
  not: {
    toBe: (x: any) => assert.notEqual(v, x),
    toThrow: () => assert.doesNotThrow(v),
  },
});
describe("English publication evidence", () => {
  it("distinguishes not recorded, missing and processing", () => {
    expect(normalizeStatus(undefined)).toBe("not-recorded");
    expect(normalizeStatus("なし")).toBe("missing");
    expect(normalizeStatus("処理中…(読み直し時点)")).toBe("processing");
    expect(normalizeStatus("公開済み 1件")).toBe("published");
    expect(normalizeStatus("set")).toBe("uploaded");
  });
  it("rejects invalid evidence", () => {
    expect(() => validateEvidence({ videoId: "abc" })).toThrow();
    expect(() =>
      validateEvidence({
        videoId: "abcdefghijk",
        observedAt: "2026-10-13T01:00:00Z",
        fields: { audio: { state: "published", raw: "公開済み" } },
      }),
    ).not.toThrow();
  });
});

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordEvidence, inventory } from "./en-status";
it("retains historical evidence and applies only observed fields", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "en-status-")),
    ep = path.join(root, "ep-test");
  mkdirSync(path.join(ep, "publish/en"), { recursive: true });
  const p = path.join(ep, "publish/en/studio-en.json");
  writeFileSync(
    p,
    JSON.stringify({
      videoId: "abcdefghijk",
      audio: "processing",
      thumbnail: "set",
      checkedAt: "2020-01-01T00:00:00Z",
    }),
  );
  recordEvidence(ep, {
    videoId: "abcdefghijk",
    observedAt: "2020-01-02T00:00:00Z",
    fields: { audio: { state: "published", raw: "公開済み" } },
  });
  const r = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(r.audio, "processing");
  assert.equal(r.observations.length, 1);
  const rows = inventory(root);
  assert.equal(rows[0].observed.audio.state, "published");
  assert.equal(rows[0].observed.thumbnail.source, "historical-record");
  assert.equal(rows[0].observed.captions.state, "not-recorded");
  assert.throws(() =>
    recordEvidence(ep, {
      videoId: "wrongwrong1",
      observedAt: "2020-01-03T00:00:00Z",
      fields: { audio: { state: "published", raw: "published" } },
    }),
  );
  rmSync(root, { recursive: true, force: true });
});
it("rejects conflicting studio/upload identities and exposes conflict in inventory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "en-conflict-")),
    ep = path.join(root, "ep-test");
  mkdirSync(path.join(ep, "publish/en"), { recursive: true });
  const p = path.join(ep, "publish/en/studio-en.json");
  writeFileSync(
    p,
    JSON.stringify({ videoId: "abcdefghijk", audio: "processing" }),
  );
  writeFileSync(
    path.join(ep, "publish/upload-result.json"),
    JSON.stringify({ videoId: "zyxwvutsrqp" }),
  );
  assert.throws(() =>
    recordEvidence(ep, {
      videoId: "abcdefghijk",
      observedAt: "2020-01-03T00:00:00Z",
      fields: { audio: { state: "published", raw: "published" } },
    }),
  );
  assert.equal(inventory(root)[0].videoId, null);
  assert.match(JSON.stringify(inventory(root)[0]), /identity-conflict/);
  rmSync(root, { recursive: true, force: true });
});
