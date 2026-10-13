import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chooseSource, validateImageSize } from "./en-thumb";
const expect = (v: any) => ({
  toBe: (x: any) => assert.equal(v, x),
  toEqual: (x: any) => assert.deepEqual(v, x),
  toThrow: () => assert.throws(v),
  not: {
    toBe: (x: any) => assert.notEqual(v, x),
    toThrow: () => assert.doesNotThrow(v),
  },
});
describe("explicit English thumbnail", () => {
  it("explicit source overrides cached live JPEG", () =>
    expect(
      chooseSource("/e", { thumbSource: "publish/thumb-2.png" }, true),
    ).toBe("/e/publish/thumb-2.png"));
  it("rejects wrong dimensions and missing pixels", () => {
    expect(() => validateImageSize(0, 720)).toThrow();
    expect(() => validateImageSize(1024, 1024)).toThrow();
    expect(() => validateImageSize(1280, 720)).not.toThrow();
  });
});

import { spawnSync } from "node:child_process";
it("legacy command fails explicitly instead of pretending to generate", () => {
  const p = spawnSync(
    "bash",
    ["scripts/en-dub/thumb-en.sh", "ep065-horned-lizard"],
    { encoding: "utf8" },
  );
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /Usage/);
});
