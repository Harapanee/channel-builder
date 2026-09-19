import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateMetadata, memberEarlyAccessNotice } from "./validate-metadata.js";

const ROOT = resolve(import.meta.dirname, "../..");
const NOTES =
  "【制作工程・AI利用の開示】\nこの動画は当チャンネルのオリジナル制作です。台本は資料調査に基づくオリジナル執筆、映像は自作プログラムによる独自描画、ナレーションは合成音声(VOICEVOX)です。";

function setup(meta: Record<string, unknown>): { root: string; ep: string } {
  const root = mkdtempSync(join(tmpdir(), "vm-"));
  mkdirSync(join(root, "src/schemas"), { recursive: true });
  cpSync(join(ROOT, "src/schemas/metadata.schema.json"), join(root, "src/schemas/metadata.schema.json"));
  const ep = "episodes/ep999-test";
  mkdirSync(join(root, ep, "publish"), { recursive: true });
  writeFileSync(join(root, ep, "publish/metadata.json"), JSON.stringify(meta));
  return { root, ep };
}

const base = {
  title: "テストに転生したら最悪だった件",
  description: `要約\n\n${NOTES}\n#test`,
  tags: ["a"],
  categoryId: "27",
  privacyStatus: "private",
  aiDisclosure: false,
  productionNotes: NOTES,
};

test("memberEarlyAccess なしは従来どおり OK", () => {
  const { root, ep } = setup(base);
  assert.deepEqual(validateMetadata(ep, root), []);
});

test("memberEarlyAccess は publishAt と概要欄の定型行を要求する", () => {
  const { root, ep } = setup({ ...base, memberEarlyAccess: { hours: 24 } });
  const errs = validateMetadata(ep, root);
  assert.ok(errs.some((e) => e.includes("publishAt")), errs.join("\n"));
  assert.ok(errs.some((e) => e.includes("メンバーシップ")), errs.join("\n"));
});

test("publishAt と定型行(時間数一致)が揃えば OK", () => {
  const notice = memberEarlyAccessNotice(24);
  const { root, ep } = setup({
    ...base,
    publishAt: "2026-09-20T12:00:00+09:00",
    memberEarlyAccess: { hours: 24 },
    description: `要約\n\n${notice}\n\n${NOTES}\n#test`,
  });
  assert.deepEqual(validateMetadata(ep, root), []);
});

test("定型行の時間数が hours と食い違えば NG", () => {
  const { root, ep } = setup({
    ...base,
    publishAt: "2026-09-20T12:00:00+09:00",
    memberEarlyAccess: { hours: 48 },
    description: `要約\n\n${memberEarlyAccessNotice(24)}\n\n${NOTES}\n#test`,
  });
  assert.ok(validateMetadata(ep, root).some((e) => e.includes("メンバーシップ")));
});

test("hours が 0 以下はスキーマ違反", () => {
  const { root, ep } = setup({ ...base, publishAt: "2026-09-20T12:00:00+09:00", memberEarlyAccess: { hours: 0 } });
  assert.ok(validateMetadata(ep, root).some((e) => e.includes("スキーマ違反")));
});
