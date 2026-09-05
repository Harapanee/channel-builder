import assert from "node:assert/strict";
import test from "node:test";
import { I2V_LINE, chapterCard, composePrompt } from "./compose";
import type { Vocab } from "./types";

const VOCAB: Vocab = {
  STYLE: "2D-animated doodle style.",
  CLOSE: "Nothing else appears in the frame at any point.",
  CLOSE_H: "Nothing else appears, but hands may appear.",
  CLOSE_TEXT: "No other writing appears.",
  CLOSEUP_GUARD: "Even at this size the subject stays a simple flat doodle drawing.",
  places: { SEA: "a flat blue field" },
  subjects: { ADULT: "one cartoon salmon" },
  props: {},
};

test("3フィールドがこの順で1回ずつ出る", () => {
  const p = composePrompt({ body: "A wide shot of a flat blue field.", sound: "A low hum." }, VOCAB);
  const lines = p.split("\n");
  assert.ok(lines[0].startsWith("integrated_multimodal_description: [Shot 1] "));
  assert.equal(lines[1], "");
  assert.ok(lines[2].startsWith("overall_soundscape: "));
  assert.equal(lines[3], "");
  assert.equal(lines[4], "non_diegetic_music: N/A");
  assert.equal(p.match(/integrated_multimodal_description:/g)?.length, 1);
});

test("[Shot 1] の直後に画風が入り、末尾は閉じの一文で終わる", () => {
  const p = composePrompt({ body: "A wide shot.", sound: "A hum." }, VOCAB);
  assert.ok(p.includes(`[Shot 1] ${VOCAB.STYLE} A wide shot. ${VOCAB.CLOSE}`));
});

test("open は CLOSE_H、text は CLOSE_TEXT に切り替わる", () => {
  assert.ok(composePrompt({ body: "b", sound: "s", open: true }, VOCAB).includes(VOCAB.CLOSE_H));
  assert.ok(composePrompt({ body: "b", sound: "s", text: true }, VOCAB).includes(VOCAB.CLOSE_TEXT));
});

test("寄りのカットには CLOSEUP_GUARD が自動で付く", () => {
  assert.ok(composePrompt({ body: "A close shot of the fish.", sound: "s" }, VOCAB).includes(VOCAB.CLOSEUP_GUARD));
  assert.ok(composePrompt({ body: "A very close shot of the eye.", sound: "s" }, VOCAB).includes(VOCAB.CLOSEUP_GUARD));
  assert.ok(!composePrompt({ body: "A wide shot of the sea.", sound: "s" }, VOCAB).includes(VOCAB.CLOSEUP_GUARD));
});

test("寄りの言い回しは close shot / very close shot に限らない(2026-08-27 拡張)", () => {
  const guarded = (body: string) => composePrompt({ body, sound: "s" }, VOCAB).includes(VOCAB.CLOSEUP_GUARD);
  for (const body of [
    "A close-up of the eye.",
    "A closeup of the eye.",
    "A tight shot of the mouth.",
    "A macro view of the scale.",
    "A close overhead shot looking straight down at the silt.",
    "A very close overhead view of the gravel.",
  ]) assert.ok(guarded(body), body);
});

test("寄りでない文脈の close は CLOSEUP_GUARD を呼ばない(誤爆させない)", () => {
  const guarded = (body: string) => composePrompt({ body, sound: "s" }, VOCAB).includes(VOCAB.CLOSEUP_GUARD);
  for (const body of [
    "A wide shot of the sea. Two ears sit close together in one short row. The camera holds a static shot.",
    "A wide shot of the shore. The calf stays close to her side. The camera holds a static shot.",
    // 敵対レビュー(2026-08-27)が見つけた動詞・形容詞の close。名詞句の頭でないので寄りではない
    "A wide shot of the shore. Her eyes close as the shot fades to grey.",
    "A wide shot of the shore. She pulls the calf close before the shot ends.",
    "A wide shot of the bank. The gap begins to close in this view of the bank.",
  ]) assert.ok(!guarded(body), body);
});

test("first_frame があるときは公式の指示行が先頭に付き、直後が空行", () => {
  const p = composePrompt({ body: "b", sound: "s" }, VOCAB, { firstFrame: true });
  const lines = p.split("\n");
  assert.equal(lines[0], I2V_LINE);
  assert.equal(
    I2V_LINE,
    "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.",
  );
  assert.equal(lines[1], "");
  assert.ok(lines[2].startsWith("integrated_multimodal_description:"));
});

test("music を指定すれば non_diegetic_music に入る(既定は N/A)", () => {
  const p = composePrompt({ body: "b", sound: "s", music: "Sparse piano notes at a slow tempo." }, VOCAB);
  assert.ok(p.endsWith("non_diegetic_music: Sparse piano notes at a slow tempo."));
});

test("章カードは2行の文字と字数宣言を含む", () => {
  const decl = chapterCard("第七章", "沿岸");
  assert.equal(decl.text, true);
  assert.ok(decl.body?.includes('"第七章", spelled with those three characters'));
  assert.ok(decl.body?.includes('"沿岸", spelled with those two characters'));
});

test("章カードは11文字以上でも字数を数字で書ける", () => {
  const decl = chapterCard("第一章", "あいうえおかきくけこさし");
  assert.ok(decl.body?.includes('spelled with those 12 characters'));
});
