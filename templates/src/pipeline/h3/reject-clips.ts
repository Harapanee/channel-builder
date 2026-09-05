/**
 * 不合格クリップを隔離する。
 *   npm run h3:reject -- <epId> <clipId…>
 *
 * 削除ではなく移動する(較正の材料になる)。移せば batch.mjs の skip 判定が
 * 外れるので、次に run-chapter を回したときに作り直される。
 * **同じIDを2度隔離しても先の隔離物を上書きしない**(連番を付ける)。作り直した2本目が
 * 1本目を消してしまうと、較正の材料を残すという目的そのものが失われる。
 * **鎖の途中を隔離すると下流が古い起点のまま残る。** 鎖区間は入口から隔離すること。
 */
import { basename, join } from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { clipsDir, rejectedDir } from "./config";

/** 空いている隔離先の名前。既にあれば -2, -3… を付けて先の隔離物を守る */
export function freeName(dest: string, id: string): string {
  let candidate = join(dest, id + ".mp4");
  for (let n = 2; existsSync(candidate); n += 1) candidate = join(dest, id + "-" + n + ".mp4");
  return candidate;
}

function main(): void {
  const [epId, ...ids] = process.argv.slice(2);
  if (!epId || ids.length === 0) { console.error("使い方: npm run h3:reject -- <epId> <clipId…>"); process.exit(2); }
  const dest = rejectedDir(epId);
  mkdirSync(dest, { recursive: true });
  let moved = 0;
  for (const id of ids) {
    const src = join(clipsDir(epId), id + ".mp4");
    if (!existsSync(src)) { console.log("skip " + id + "(クリップがありません)"); continue; }
    const to = freeName(dest, id);
    renameSync(src, to);
    moved += 1;
    console.log("隔離: " + id + (basename(to) === id + ".mp4" ? "" : " → " + basename(to) + "(前の隔離物を残すため連番)"));
  }
  console.log(moved + "本を " + dest + " へ移しました。次の h3:run で作り直されます");
}

if (process.argv[1] && basename(process.argv[1]) === "reject-clips.ts") main();
