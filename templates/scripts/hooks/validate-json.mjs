#!/usr/bin/env node
/**
 * PostToolUse hook(Edit|Write): データ契約の自動検証(仕様書§14)。
 * - episodes/<ep>/shots.json / timing.json の編集後 → validate-shots.ts を実行
 * - assets/library.json / .channel-system.json / episode.json の編集後 → JSON構文検査
 * 検証失敗は exit 2(stderrがClaudeに渡り、修正を促す)。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

// 1) shots.json / timing.json → 契約検証(shots.jsonがまだ無い工程はスキップ)
const m = rel.match(/^(episodes\/[^/]+)\/(shots|timing)\.json$/);
if (m) {
  const epDir = m[1];
  if (!fs.existsSync(path.join(projectDir, epDir, "shots.json"))) process.exit(0);
  const r = spawnSync(
    "npx",
    ["tsx", "src/pipeline/validate-shots.ts", epDir],
    { cwd: projectDir, encoding: "utf8", timeout: 60_000 }
  );
  if (r.status !== 0) {
    console.error(
      `契約検証に失敗(${epDir}):\n${(r.stdout ?? "") + (r.stderr ?? "")}`
    );
    process.exit(2);
  }
  process.exit(0);
}

// 2) その他の契約JSON → 構文検査のみ(高速)
if (
  rel === "assets/library.json" ||
  rel === ".channel-system.json" ||
  /^episodes\/[^/]+\/episode\.json$/.test(rel)
) {
  try {
    JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (e) {
    console.error(`JSON構文エラー(${rel}): ${e}`);
    process.exit(2);
  }
}
process.exit(0);
