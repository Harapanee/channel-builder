import assert from "node:assert/strict";
import test from "node:test";
import { nextStatusOrThrow } from "./set-status";

const ALLOWED = [
  "researched", "scripted", "voiced", "storyboarded", "assets_ready",
  "implemented", "prechecked", "qa_passed", "reviewed", "packaged",
  "render_ready", "final",
];

test("契約にある status を受け付ける", () => {
  assert.equal(nextStatusOrThrow("scripted", "voiced", ALLOWED), "voiced");
});

test("契約に無い status は止める(prechecked を reviewed へ勝手に読み替える事故を防ぐ)", () => {
  assert.throws(() => nextStatusOrThrow("voiced", "storyboardd", ALLOWED), /契約にありません/);
});

test("後戻りは止める(検査で落ちて status を巻き戻すのは人が判断する)", () => {
  assert.throws(() => nextStatusOrThrow("implemented", "voiced", ALLOWED), /後戻り/);
});

test("同じ status の再設定は許す(再開時の冪等性)", () => {
  assert.equal(nextStatusOrThrow("implemented", "implemented", ALLOWED), "implemented");
});

test("status 未設定のエピソードにはどの status も置ける", () => {
  assert.equal(nextStatusOrThrow(undefined, "researched", ALLOWED), "researched");
});
