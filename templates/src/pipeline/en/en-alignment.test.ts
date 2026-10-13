import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { alignedCues } from "./en-alignment";
const expect = (v: any) => ({
  toBe: (x: any) => assert.equal(v, x),
  toEqual: (x: any) => assert.deepEqual(v, x),
  toThrow: () => assert.throws(v),
  not: {
    toBe: (x: any) => assert.notEqual(v, x),
    toThrow: () => assert.doesNotThrow(v),
  },
});
describe("aligned subtitles", () => {
  it("uses observed word boundaries instead of proportional timestamps", () => {
    const text = "First sentence. Second sentence.";
    const c = alignedCues(
      text,
      [
        { text: "First", start: 0, end: 0.5 },
        { text: "sentence.", start: 0.5, end: 1 },
        { text: "Second", start: 2, end: 2.5 },
        { text: "sentence.", start: 2.5, end: 3 },
      ],
      3,
    );
    expect(c.map((x) => [x.start, x.end])).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });
  it("rejects text mismatch and nonfinite boundaries", () => {
    expect(() =>
      alignedCues("hello", [{ text: "wrong", start: 0, end: 1 }], 1),
    ).toThrow();
    expect(() =>
      alignedCues("hello", [{ text: "hello", start: NaN, end: 1 }], 1),
    ).toThrow();
  });
});
