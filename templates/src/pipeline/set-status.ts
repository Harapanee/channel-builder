/**
 * episodes/<epId>/episode.json の status を、契約(episode.schema.json の enum)で
 * 検証しながら1コマンドで更新する。
 *
 * なぜコマンドにするか:
 *   2026-08-02 の sekaishi-longform ep002 実測で、メインセッションの Bash 127回のうち
 *   12回が status 更新のための `python3 - <<'EOF' import json ...` heredoc だった。
 *   工程を1つ進めるたびに5〜10行のスクリプトを書き、その往復が以後の全ターンの
 *   コンテキストに乗り続ける。加えて検証が無いため、契約に無い値("prechecked" が
 *   enum に無かった)を書こうとして判断に迷う事故が動物転生 ep014 で起きた。
 *
 * 使い方:
 *   npm run status episodes/<epId> voiced
 *   npm run status <epId> assets_ready
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

/** `ep013-worker-ant` でも `episodes/ep013-worker-ant` でも受ける */
export function resolveEpisodeDir(arg: string, exists: (p: string) => boolean): string {
  for (const dir of [arg, path.join("episodes", arg), path.join("shorts", arg)]) {
    if (exists(path.join(dir, "episode.json"))) return dir;
  }
  throw new Error(`episode.json を持つエピソードが見つかりません: ${arg}`);
}

/**
 * 遷移の可否を決める。契約外は拒否、後戻りは拒否、同値は許す(再開の冪等性)。
 * 後戻りを拒むのは、検査落ちで status を巻き戻す判断を人に残すため。
 */
export function nextStatusOrThrow(
  current: string | undefined,
  next: string,
  allowed: string[]
): string {
  if (!allowed.includes(next)) {
    throw new Error(`status "${next}" は契約にありません。使える値: ${allowed.join(" / ")}`);
  }
  if (current === undefined) return next;
  if (!allowed.includes(current)) return next;
  const from = allowed.indexOf(current);
  const to = allowed.indexOf(next);
  if (to < from) {
    throw new Error(
      `後戻りは自動で行いません(${current} → ${next})。巻き戻すなら episode.json を人が直すこと`
    );
  }
  return next;
}

function allowedFromSchema(schemaPath: string): string[] {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const list = schema?.properties?.status?.enum;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`status の enum を ${schemaPath} から読めません`);
  }
  return list as string[];
}

if (process.argv[1] && path.basename(process.argv[1]) === "set-status.ts") {
  const [arg, next] = process.argv.slice(2);
  if (!arg || !next) fail("使い方: npm run status episodes/<epId> <status>");
  let epDir: string;
  try {
    epDir = resolveEpisodeDir(arg, existsSync);
  } catch (e) {
    fail((e as Error).message);
  }
  const epPath = path.join(epDir, "episode.json");
  let allowed: string[];
  try {
    allowed = allowedFromSchema("src/schemas/episode.schema.json");
  } catch (e) {
    fail((e as Error).message);
  }
  const ep = JSON.parse(readFileSync(epPath, "utf8"));
  let resolved: string;
  try {
    resolved = nextStatusOrThrow(ep.status, next, allowed);
  } catch (e) {
    fail((e as Error).message);
  }
  const before = ep.status ?? "(未設定)";
  ep.status = resolved;
  writeFileSync(epPath, JSON.stringify(ep, null, 2) + "\n");
  console.log(`OK: ${epPath} status ${before} → ${resolved}`);
}
