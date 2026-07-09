#!/usr/bin/env node
/**
 * PreToolUse hook(Edit|Write): 承認済みシステムの保護(仕様書§14)。
 * .channel-system.json の status が "approved" のとき、教義・声・コア
 * コンポーネントへの直接変更をブロックする(/channel-refine 経由を強制)。
 * exit 2 = ブロック(stderrがClaudeに渡る)。それ以外は許可。
 */
import fs from "node:fs";
import path from "node:path";

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

let input = "";
for await (const chunk of process.stdin) input += chunk;

let filePath = "";
try {
  filePath = JSON.parse(input)?.tool_input?.file_path ?? "";
} catch {
  process.exit(0);
}
if (!filePath) process.exit(0);

const rel = path.relative(projectDir, path.resolve(filePath));
const isProtected =
  rel === "channel/bible.md" ||
  rel === "channel/voice.json" ||
  rel.startsWith("src/scenes/core/");
if (!isProtected) process.exit(0);

try {
  // /channel-refine の適用フェーズ(人間承認済み)ではマーカーが置かれ、編集を許可する。
  // マーカーは適用+CHANGELOG記録の完了後に必ず削除すること。
  if (fs.existsSync(path.join(projectDir, ".channel-refine-approved"))) {
    process.exit(0);
  }
  const sys = JSON.parse(
    fs.readFileSync(path.join(projectDir, ".channel-system.json"), "utf8")
  );
  if (sys.status === "approved") {
    console.error(
      `ブロック: ${rel} は承認済みシステム(status: approved)の保護対象です。` +
        `変更は /channel-refine を使い、人間承認後にマーカー(.channel-refine-approved)を` +
        `置いてから適用し、CHANGELOG記録とマーカー削除で完了してください。`
    );
    process.exit(2);
  }
} catch {
  // .channel-system.json が読めない場合はブロックしない
}
process.exit(0);
