import assert from "node:assert/strict";
import test from "node:test";
import { lintTextSizeSource } from "./visual-source-lint";

test("fontSizeの数値リテラルだけを設定下限と比較する", () => {
  const source = [
    'const a = { fontSize: 24 };',
    'const b = <div style={{fontSize: 32}} />;',
    'const c = <div style={{fontSize: dynamicSize}} />;',
    'const d = { fontSize: 12 }; // visual-text-lint-allow',
  ].join("\n");
  assert.deepEqual(lintTextSizeSource(source, "Scene.tsx", 28), [
    { file: "Scene.tsx", line: 1, sizePx: 24, minPx: 28 },
  ]);
});
