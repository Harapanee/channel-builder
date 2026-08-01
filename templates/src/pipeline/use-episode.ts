/**
 * 作業中のエピソードを HyperFrames のエントリ(ルート index.html)に載せる。
 *
 * なぜコマンドにするか:
 *   `npm run dev` / `npm run check` / `hyperframes render` はいずれもルートの
 *   index.html を見る。そのため工程8.5・工程9・レンダー前に毎回
 *   `cp episodes/<epId>/composition.html index.html` を手で打つ運用になっており、
 *   スキル本文の3か所に同じ注意書き(「作業中epを指すよう必ず更新する」)が要った。
 *   打ち忘れると**別のエピソードを検査して緑を出す**。
 *
 *   あわせて index.html は git 追跡から外した(2026-08-02)。中身は
 *   episodes/<epId>/composition.html の写しで、1話ごとに約500KBの全書き換え差分が
 *   入っていた(同じ内容を2重に追跡していた)。
 *
 * 使い方: npm run use episodes/<epId>   /   npm run use ep013-worker-ant
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

/** `ep013-worker-ant` でも `episodes/ep013-worker-ant` でも受ける */
export function resolveEpisodeArg(arg: string, exists: (p: string) => boolean): string {
  for (const dir of [arg, path.join("episodes", arg), path.join("shorts", arg)]) {
    if (exists(path.join(dir, "composition.html"))) return dir;
  }
  throw new Error(`composition.html を持つエピソードが見つかりません: ${arg}`);
}

if (process.argv[1] && path.basename(process.argv[1]) === "use-episode.ts") {
  const arg = process.argv[2];
  if (!arg) fail("使い方: npm run use episodes/<epId>");
  let epDir: string;
  try {
    epDir = resolveEpisodeArg(arg, existsSync);
  } catch (e) {
    fail((e as Error).message);
  }
  const src = path.join(epDir, "composition.html");
  copyFileSync(src, "index.html");
  const html = readFileSync(src, "utf8");
  const dur = /<[^<>]*\bdata-composition-id="([^"]+)"[^<>]*\bdata-duration="([\d.]+)"/.exec(html);
  console.log(
    `OK: index.html ← ${src}` +
      (dur ? `(${dur[1]} / 尺 ${Number(dur[2]).toFixed(2)}秒)` : "") +
      `\n   これで npm run dev / npm run check / レンダーがこのエピソードを見ます`
  );
}
