#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

/**
 * episodes/<epId>/publish/metadata.json(YouTube公開メタデータ契約)の検証。
 *  1. src/schemas/metadata.schema.json への適合
 *  2. thumbnail がエピソード内に収まる安全な相対パスであること(絶対・「..」拒否)
 *  3. thumbnail の実ファイル存在
 * 失敗は exit 1(理由を列挙)。
 */
export function validateMetadata(
  episodeDirArg: string,
  projectRoot: string = process.cwd()
): string[] {
  const epDir = path.resolve(projectRoot, episodeDirArg);
  const metaPath = path.join(epDir, "publish", "metadata.json");
  const errors: string[] = [];

  if (!existsSync(metaPath)) {
    return [`publish/metadata.json がない: ${metaPath}(publisherの出力3)`];
  }

  const schema = JSON.parse(
    readFileSync(
      path.resolve(projectRoot, "src/schemas/metadata.schema.json"),
      "utf-8"
    )
  ) as object;

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch (e) {
    return [`metadata.json がJSONとして不正: ${(e as Error).message}`];
  }

  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    for (const e of validate.errors ?? []) {
      errors.push(`スキーマ違反: ${e.instancePath || "/"} ${e.message}`);
    }
    return errors;
  }

  const meta = data as { thumbnail?: string };
  if (meta.thumbnail !== undefined) {
    if (!isSafeRel(meta.thumbnail)) {
      errors.push(
        `thumbnail はエピソード内相対パスが必要(絶対パス・「..」不可): ${meta.thumbnail}`
      );
    } else if (!existsSync(path.join(epDir, meta.thumbnail))) {
      errors.push(`thumbnail の実ファイルがない: ${meta.thumbnail}`);
    }
  }

  return errors;
}

/** エピソードフォルダ内に収まる相対パスか(絶対・「..」・バックスラッシュ拒否) */
function isSafeRel(rel: string): boolean {
  if (rel === "" || rel.startsWith("/") || rel.includes("\\")) return false;
  return rel.split("/").every((seg) => seg !== "" && seg !== ".." && seg !== ".");
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
      "Usage: validate-metadata.ts <episodeDir>  (例: episodes/ep001-xxx)"
    );
    process.exit(1);
  }
  const errors = validateMetadata(arg);
  if (errors.length > 0) {
    for (const m of errors) console.error(`NG: ${m}`);
    process.exit(1);
  }
  console.log(`OK: ${arg}/publish/metadata.json`);
}
