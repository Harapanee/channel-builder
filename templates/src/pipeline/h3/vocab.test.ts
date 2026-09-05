import assert from "node:assert/strict";
import test from "node:test";
// 雛形の語彙帳(example-salmon.ts)を検査する。テンプレ同期で全チャンネルに配られるため、エピソード固有の語彙帳を参照しない
import vocab from "../../../h3/vocab/example-salmon";

test("語彙帳が必須フィールドを持つ", () => {
  for (const key of ["STYLE", "CLOSE", "CLOSE_H", "CLOSE_TEXT", "CLOSEUP_GUARD"] as const) {
    assert.ok(vocab[key].length > 0, `${key} が空`);
  }
});

test("場所・被写体・脇役が名前で引ける", () => {
  assert.ok(vocab.places.SEA.includes("ocean"));
  assert.ok(vocab.places.HATCHERY.includes("concrete"));
  assert.ok(vocab.subjects.ADULT.includes("salmon"));
  assert.ok(vocab.subjects.EGG.includes("roe"));
  assert.ok(vocab.props.BEAR.includes("bear"));
});

test("画風は紙地・極太線・影なしを明示している(一字一句の凍結対象)", () => {
  assert.ok(vocab.STYLE.includes("cream paper"));
  assert.ok(vocab.STYLE.includes("thick rough black marker outlines"));
  assert.ok(vocab.STYLE.includes("no shading and no gradients"));
});

test("閉じの一文は3種とも「他には何も出ない」と言い切る", () => {
  assert.ok(vocab.CLOSE.startsWith("Nothing else appears in the frame"));
  assert.ok(vocab.CLOSE_H.startsWith("Nothing else appears in the frame"));
  assert.ok(vocab.CLOSE_TEXT.includes("No other writing"));
});

test("定数名が3グループで重複していない(cuts.json は名前1つで引くため)", () => {
  const names = [...Object.keys(vocab.places), ...Object.keys(vocab.subjects), ...Object.keys(vocab.props)];
  assert.equal(names.length, new Set(names).size, "定数名が重複している");
});
