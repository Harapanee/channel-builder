#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

/** 書式規則($defs.entryFormat)を適用し始める packagedAt。これ以前のエントリは据え置き。 */
const FORMAT_RULES_FROM = "2026-08-24";

/**
 * channel/episode-ledger.json(全話台帳契約)の検証。
 *  1. src/schemas/episode-ledger.schema.json への適合
 *  2. epId の一意性
 *  3. $defs.entryFormat の書式規則(FORMAT_RULES_FROM 以降のエントリのみ)
 * 失敗は exit 1(理由を列挙)。台帳は publisher(出力4)が追記し、
 * script-director / theme-scout / channel-refine が読む。
 */
export function validateLedger(projectRoot: string = process.cwd()): string[] {
  const p = path.join(projectRoot, "channel", "episode-ledger.json");
  if (!existsSync(p)) {
    return [
      `channel/episode-ledger.json がない(publisherの出力4。初期値は {"episodes": []})`,
    ];
  }
  const schema = JSON.parse(
    readFileSync(
      path.resolve(projectRoot, "src/schemas/episode-ledger.schema.json"),
      "utf-8"
    )
  ) as object;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(p, "utf-8"));
  } catch (e) {
    return [`episode-ledger.json がJSONとして不正: ${(e as Error).message}`];
  }
  const errors: string[] = [];
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    for (const e of validate.errors ?? []) {
      errors.push(`スキーマ違反: ${e.instancePath || "/"} ${e.message}`);
    }
    return errors;
  }
  const ledger = data as {
    episodes: Array<{ epId: string; packagedAt?: string }>;
  };
  const seen = new Set<string>();
  for (const ep of ledger.episodes) {
    if (seen.has(ep.epId)) errors.push(`epId重複: ${ep.epId}`);
    seen.add(ep.epId);
  }

  // 書式規則($defs.entryFormat)は FORMAT_RULES_FROM 以降のエントリにのみ適用する。
  // 既存エントリは据え置き(2026-08-24 の判断)。packagedAt 未記入は対象外。
  const formatSchema = (schema as { $defs?: { entryFormat?: object } }).$defs
    ?.entryFormat;
  if (formatSchema) {
    const validateFormat = ajv.compile(formatSchema);
    for (const ep of ledger.episodes) {
      const { epId, packagedAt } = ep;
      if (!packagedAt || packagedAt < FORMAT_RULES_FROM) continue;
      if (!validateFormat(ep)) {
        for (const e of validateFormat.errors ?? []) {
          errors.push(`書式違反 ${epId}: ${e.instancePath || "/"} ${e.message}`);
        }
      }
    }
  }
  return errors;
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      path.resolve(fileURLToPath(import.meta.url)) ===
      path.resolve(process.argv[1])
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const errors = validateLedger();
  if (errors.length > 0) {
    for (const m of errors) console.error(`NG: ${m}`);
    process.exit(1);
  }
  console.log("OK: channel/episode-ledger.json");
}
