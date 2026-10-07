import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkStudio } from "./check-studio.js";

const ROOT = resolve(import.meta.dirname, "../..");
const EP = "episodes/ep999-test";

function setup(result?: unknown, meta: Record<string, unknown> = { memberEarlyAccess: { hours: 24 } }): string {
  const root = mkdtempSync(join(tmpdir(), "studio-"));
  mkdirSync(join(root, "src/schemas"), { recursive: true });
  cpSync(join(ROOT, "src/schemas/studio-result.schema.json"), join(root, "src/schemas/studio-result.schema.json"));
  const pub = join(root, EP, "publish");
  mkdirSync(pub, { recursive: true });
  writeFileSync(join(pub, "upload-result.json"), JSON.stringify({ videoId: "v1" }));
  writeFileSync(join(pub, "metadata.json"), JSON.stringify(meta));
  if (result !== undefined) writeFileSync(join(pub, "studio-result.json"), JSON.stringify(result));
  return root;
}
const item = (status: string) => ({ status, evidence: "画面の文言" });
const all = (s: string) => ({ thumbTest: item(s), monetization: item(s), memberEarlyAccess: item(s), endScreen: item(s) });
const res = (items: unknown, videoId = "v1") => ({ videoId, checkedAt: "2026-10-07T00:00:00Z", items });

test("4項目すべて done なら ok", () => {
  assert.deepEqual(checkStudio(EP, setup(res(all("done")))), { ok: true, problems: [] });
});
test("studio-result が無ければ未完", () => {
  const r = checkStudio(EP, setup());
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /studio-result/);
});
test("pending があれば未完で項目名を出す", () => {
  const r = checkStudio(EP, setup(res({ ...all("done"), endScreen: item("pending") })));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /endScreen/);
});
test("Chrome 未接続で全項目 pending なら4項目とも未完に出る", () => {
  const r = checkStudio(EP, setup(res(all("pending"))));
  assert.equal(r.problems.length, 4);
});
test("videoId が upload-result と違えば未完", () => {
  assert.match(checkStudio(EP, setup(res(all("done"), "OTHER"))).problems.join(), /videoId/);
});
test("upload-result が無ければ未完", () => {
  const root = setup(res(all("done")));
  const r = checkStudio("episodes/ep000-none", root);
  assert.equal(r.ok, false);
});
test("メンバー先行を使わない回は memberEarlyAccess=skipped で ok", () => {
  const r = checkStudio(EP, setup(res({ ...all("done"), memberEarlyAccess: item("skipped") }), {}));
  assert.equal(r.ok, true);
});
test("memberEarlyAccess 指定のある回で skipped は未完", () => {
  assert.equal(checkStudio(EP, setup(res({ ...all("done"), memberEarlyAccess: item("skipped") }))).ok, false);
});
test("evidence が空・項目欠落はスキーマ違反で未完", () => {
  assert.equal(checkStudio(EP, setup(res({ ...all("done"), thumbTest: { status: "done", evidence: "" } }))).ok, false);
  const { endScreen: _e, ...three } = all("done");
  assert.equal(checkStudio(EP, setup(res(three))).ok, false);
});
