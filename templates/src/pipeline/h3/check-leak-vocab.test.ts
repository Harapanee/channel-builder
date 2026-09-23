// src/pipeline/h3/check-leak-vocab.test.ts
// 2026-09-23 積み残し: B16(本文への undefined/null/NaN 混入)・A5 の keyframe 除外・A17(使われない語彙定数)
import assert from "node:assert/strict";
import test from "node:test";
import { checkAdvisories, checkPlaceholderLeak, checkUnusedVocab } from "./check";
import type { Vocab } from "./types";

test("B16: 本文に undefined が混入していれば BLOCK(ep041: props/subjects の取り違え)", () => {
  const f = checkPlaceholderLeak("cL10", "integrated_multimodal_description: [Shot 1] A wide shot of undefined. The fish swims.");
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "BLOCK");
  assert.equal(f[0].rule, "B16");
  assert.match(f[0].message, /undefined/);
});

test("B16: null と NaN も拾う。複数あれば語ごとにまとめて1件", () => {
  const f = checkPlaceholderLeak("cL10", "A wide shot of null. It lasts NaN seconds. Another null.");
  assert.equal(f.length, 1);
  assert.match(f[0].message, /null/);
  assert.match(f[0].message, /NaN/);
});

test("B16: 語の一部(nullify・Nancy・undefinedness でない普通語)は拾わない", () => {
  assert.deepEqual(checkPlaceholderLeak("x", "A wide shot of the sea. Nancy nullifies the banana."), []);
});

test("B16: 終点画像の文面も同じ関数で見る(ID に .endframe を付けて呼ぶ)", () => {
  const f = checkPlaceholderLeak("cL10.endframe", "The jaw is thrust forward, undefined");
  assert.equal(f[0].id, "cL10.endframe");
});

test("A5: keyframe カットでは場所から始まらなくても出さない(ep044 ⑤: 両端の絵が場所を持つ)", () => {
  const body = "The jaw shoots forward and snaps shut. The camera holds a static shot.";
  assert.ok(checkAdvisories("x", body).some((f) => f.rule === "A5"));
  assert.ok(!checkAdvisories("x", body, undefined, { keyframe: true }).some((f) => f.rule === "A5"));
});

const V: Vocab = {
  STYLE: "S", CLOSE: "C", CLOSE_H: "CH", CLOSE_TEXT: "CT", CLOSEUP_GUARD: "G",
  places: { SEA: "a flat blue sea under a pale sky", REEF: "a low grey reef of rounded rocks" },
  subjects: { FISH: "a small silver fish with one black dot eye", ADULT: "a large silver fish" },
  props: { NET: "a loose white net" },
};

test("A17: どのカットの文面にも現れない語彙定数を1件ずつ ADVISE", () => {
  const texts = ["A wide shot of a flat blue sea under a pale sky. a small silver fish with one black dot eye swims."];
  const f = checkUnusedVocab(V, texts);
  assert.deepEqual(f.map((x) => x.id).sort(), ["places.REEF", "props.NET", "subjects.ADULT"]);
  assert.ok(f.every((x) => x.level === "ADVISE" && x.rule === "A17"));
});

test("A17: 終点画像の文面(endState)・sound に現れたものは使われている扱い", () => {
  const texts = [
    "A wide shot of a flat blue sea under a pale sky. a small silver fish with one black dot eye swims.",
    "a large silver fish lies on a low grey reef of rounded rocks",
    "the rustle of a loose white net",
  ];
  assert.deepEqual(checkUnusedVocab(V, texts), []);
});
