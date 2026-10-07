#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

/**
 * episodes/<epId>/publish/studio-result.json(studio-finish の結果)の合否。
 *  1. スキーマ適合(4項目・status・evidence)
 *  2. videoId が upload-result.json と一致
 *  3. 4項目が done。memberEarlyAccess だけは metadata.json に memberEarlyAccess が無い回で skipped を許す
 * 未完は exit 1(残りの項目を列挙)。
 */
const ITEMS = ["thumbTest", "monetization", "memberEarlyAccess", "endScreen"] as const;

type Item = { status: string; evidence: string };
type StudioResult = { videoId: string; items: Record<(typeof ITEMS)[number], Item> };

function readJson(p: string): unknown {
  return JSON.parse(readFileSync(p, "utf-8"));
}

export function checkStudio(
  episodeDirArg: string,
  projectRoot: string = process.cwd()
): { ok: boolean; problems: string[] } {
  const pub = path.join(path.resolve(projectRoot, episodeDirArg), "publish");
  const resultPath = path.join(pub, "studio-result.json");
  const uploadPath = path.join(pub, "upload-result.json");
  const problems: string[] = [];

  if (!existsSync(uploadPath)) return { ok: false, problems: ["upload-result.json がない(先に youtube:publish)"] };
  if (!existsSync(resultPath)) return { ok: false, problems: ["studio-result.json がない(/studio-finish が未実行)"] };

  const schema = readJson(path.resolve(projectRoot, "src/schemas/studio-result.schema.json")) as object;
  const validate = new Ajv({ allErrors: true }).compile(schema);
  const result = readJson(resultPath);
  if (!validate(result)) {
    for (const e of validate.errors ?? []) problems.push(`スキーマ違反: ${e.instancePath || "/"} ${e.message}`);
    return { ok: false, problems };
  }
  const r = result as StudioResult;
  const upload = readJson(uploadPath) as { videoId?: string };
  if (r.videoId !== upload.videoId) {
    problems.push(`videoId が upload-result と違う(${r.videoId} ≠ ${upload.videoId})`);
  }
  const meta = existsSync(path.join(pub, "metadata.json"))
    ? (readJson(path.join(pub, "metadata.json")) as { memberEarlyAccess?: unknown })
    : {};
  for (const key of ITEMS) {
    const it = r.items[key];
    if (it.status === "done") continue;
    if (key === "memberEarlyAccess" && it.status === "skipped" && meta.memberEarlyAccess === undefined) continue;
    problems.push(`${key}: ${it.status}(${it.evidence})`);
  }
  return { ok: problems.length === 0, problems };
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: check-studio <episodes/epId>");
    process.exit(1);
  }
  const { ok, problems } = checkStudio(arg);
  if (!ok) {
    console.error(`Studio 仕上げが未完(${arg}):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`OK: Studio 仕上げ4項目が完了(${arg})`);
}
