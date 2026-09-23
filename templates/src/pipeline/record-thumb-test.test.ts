import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildThumbTest, parseThumbTestArgs, writeThumbTest } from "./record-thumb-test";

test("引数: --winner 2 --shares 40,35,25 → スキーマの形(thumb-N キー)", () => {
  const a = parseThumbTestArgs(["ep045-giant-panda", "--winner", "2", "--shares", "40,35.5,24.5", "--note", "顔が大きい"]);
  assert.equal(a.epId, "ep045-giant-panda");
  const d = buildThumbTest(a, "2026-09-23");
  assert.deepEqual(d, {
    winner: "thumb-2",
    recordedAt: "2026-09-23",
    shares: { "thumb-1": 40, "thumb-2": 35.5, "thumb-3": 24.5 },
    note: "顔が大きい",
  });
});

test("winner は thumb-2 の形でも受け付ける・shares と note は省略可", () => {
  const d = buildThumbTest(parseThumbTestArgs(["ep001-x", "--winner", "thumb-3"]), "2026-09-23");
  assert.deepEqual(d, { winner: "thumb-3", recordedAt: "2026-09-23" });
});

test("2案テストは shares 2個でよい", () => {
  const d = buildThumbTest(parseThumbTestArgs(["ep001-x", "--winner", "1", "--shares", "55,45"]), "2026-09-23");
  assert.deepEqual(d.shares, { "thumb-1": 55, "thumb-2": 45 });
});

test("不正: winner 範囲外・shares が4個/数でない・winner 無し・epId 無し", () => {
  assert.throws(() => buildThumbTest(parseThumbTestArgs(["ep001-x", "--winner", "4"]), "2026-09-23"), /winner/);
  assert.throws(() => buildThumbTest(parseThumbTestArgs(["ep001-x", "--winner", "1", "--shares", "1,2,3,4"]), "2026-09-23"), /shares/);
  assert.throws(() => buildThumbTest(parseThumbTestArgs(["ep001-x", "--winner", "1", "--shares", "a,b"]), "2026-09-23"), /shares/);
  assert.throws(() => buildThumbTest(parseThumbTestArgs(["ep001-x", "--winner", "3", "--shares", "50,50"]), "2026-09-23"), /shares/);
  assert.throws(() => parseThumbTestArgs(["ep001-x"]), /--winner/);
  assert.throws(() => parseThumbTestArgs(["--winner", "1"]), /epId/);
});

test("publish/thumb-test.json に書き、スキーマ違反は書かない", () => {
  const root = mkdtempSync(join(tmpdir(), "thumb-"));
  mkdirSync(join(root, "episodes/ep001-x"), { recursive: true });
  const p = writeThumbTest(root, "ep001-x", { winner: "thumb-1", recordedAt: "2026-09-23" });
  assert.equal(p, join(root, "episodes/ep001-x/publish/thumb-test.json"));
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { winner: "thumb-1", recordedAt: "2026-09-23" });
  assert.throws(() => writeThumbTest(root, "ep001-x", { winner: "thumb-9" as "thumb-1", recordedAt: "x" }), /スキーマ/);
  assert.throws(() => writeThumbTest(root, "ep999-none", { winner: "thumb-1", recordedAt: "2026-09-23" }), /エピソード/);
  assert.ok(!existsSync(join(root, "episodes/ep999-none")));
});
