import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ComponentPropsValidator } from "./component-contracts";

function projectRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "component-contracts-"));
  mkdirSync(path.join(root, "channel"));
  return root;
}

test("ComparisonSplitのネストしたprops形状を検証する", () => {
  const validator = new ComponentPropsValidator(projectRoot());
  assert.deepEqual(
    validator.validate("ComparisonSplit", {
      left: { label: "A", value: 10 },
      right: { label: "B", value: 20 },
      mode: "bars",
    }),
    []
  );
  assert.match(
    validator.validate("ComparisonSplit", {
      left: { label: "A", value: "10" },
      right: { label: "B", value: 20 },
      mode: "unknown",
    }).join("\n"),
    /must be number|must be equal/
  );
});

test("チャンネル固有JSON Schemaを追加できる", () => {
  const root = projectRoot();
  writeFileSync(
    path.join(root, "channel", "component-contracts.json"),
    JSON.stringify({ Outro: { type: "object", required: ["channelName"] } })
  );
  const validator = new ComponentPropsValidator(root);
  assert.equal(validator.configurationErrors.length, 0);
  assert.match(validator.validate("Outro", {}).join("\n"), /channelName/);
});
