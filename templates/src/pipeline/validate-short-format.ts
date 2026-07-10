#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

/**
 * channel/short-formats/<formatId>.json(ショートフォーマット契約)の検証。
 *  1. src/schemas/short-format.schema.json への適合
 *  2. segments[].id の一意性
 *  3. targetSec 合計が targetDurationSec の ±15% に収まること
 *  4. formatId とファイル名(拡張子除く)の一致
 * 失敗は exit 1(理由を列挙)。
 */
export function validateShortFormat(
  fileArg: string,
  projectRoot: string = process.cwd()
): string[] {
  const abs = path.resolve(projectRoot, fileArg);
  const schema = JSON.parse(
    readFileSync(
      path.resolve(projectRoot, "src/schemas/short-format.schema.json"),
      "utf-8"
    )
  ) as object;
  const data = JSON.parse(readFileSync(abs, "utf-8")) as unknown;
  const errors: string[] = [];

  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    for (const e of validate.errors ?? []) {
      errors.push(`スキーマ違反: ${e.instancePath || "/"} ${e.message}`);
    }
    return errors; // 構造が壊れている場合は以降の検査をスキップ
  }

  const fmt = data as {
    formatId: string;
    targetDurationSec: number;
    segments: Array<{ id: string; targetSec: number }>;
  };

  const ids = new Set<string>();
  for (const seg of fmt.segments) {
    if (ids.has(seg.id)) errors.push(`segments.id が重複: ${seg.id}`);
    ids.add(seg.id);
  }

  const sum = fmt.segments.reduce((a, s) => a + s.targetSec, 0);
  if (Math.abs(sum - fmt.targetDurationSec) > fmt.targetDurationSec * 0.15) {
    errors.push(
      `segments.targetSec 合計 ${sum}s が targetDurationSec ${fmt.targetDurationSec}s の±15%を超えている`
    );
  }

  const stem = path.basename(abs, ".json");
  if (fmt.formatId !== stem) {
    errors.push(`formatId "${fmt.formatId}" とファイル名 "${stem}" が一致しない`);
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
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      "Usage: validate-short-format.ts <formatJson>  (例: channel/short-formats/rank3-reasons.json)"
    );
    process.exit(1);
  }
  const errors = validateShortFormat(arg);
  if (errors.length > 0) {
    for (const m of errors) console.error(`NG: ${m}`);
    process.exit(1);
  }
  console.log(`OK: ${arg}`);
}
