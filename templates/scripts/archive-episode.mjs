#!/usr/bin/env node
// 公開済みエピソードの重い成果物を外部SSDへ退避し、ローカルから消す(2026-10-29 全チャンネル共通)。
//
//   node scripts/archive-episode.mjs <epId> [--dry] [--force] [--restore]
//
// 置き場所: $ARCHIVE_ROOT(既定 /Volumes/YouTubeArchive)/<チャンネルフォルダ名>/<リポジトリ内の相対パス>
// 対象: episodes/<ep>/out・episodes/<ep>/narration・episodes/<ep>/publish/en/package・review/<ep>
// 手順: ファイルごとにコピー → サイズ+sha256 照合 → 一致したものだけローカルを消す。
//       SSD 未接続・アップロード未完(publish/upload-result.json 無し。--force で無視)なら何もせず exit 2。
//       退避先に同名で内容の違うファイルがあれば上書きせず、そのファイルはローカルに残して exit 1。
// --restore: 退避先からローカルへ書き戻す(退避先は消さない)。公開後の局所修正に使う。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const epId = args.find((a) => !a.startsWith("--"));
const dry = args.includes("--dry");
const force = args.includes("--force");
const restore = args.includes("--restore");
if (!epId) {
  console.error("usage: node scripts/archive-episode.mjs <epId> [--dry] [--force] [--restore]");
  process.exit(2);
}

const repo = process.cwd();
const archiveRoot = process.env.ARCHIVE_ROOT || "/Volumes/YouTubeArchive";
const dest = path.join(archiveRoot, path.basename(repo));
const TARGETS = [
  `episodes/${epId}/out`,
  `episodes/${epId}/narration`,
  `episodes/${epId}/publish/en/package`,
  `review/${epId}`,
];

if (!fs.existsSync(path.join(repo, ".channel-system.json"))) {
  console.error("STOP: チャンネルフォルダを cwd にして実行する");
  process.exit(2);
}
if (!fs.existsSync(path.join(repo, "episodes", epId))) {
  console.error(`STOP: episodes/${epId} が無い`);
  process.exit(2);
}
// 外部ボリュームが本当にマウントされているか(未接続時に /Volumes 下へ普通のフォルダを作らない)
if (!fs.existsSync(archiveRoot) || (!process.env.ARCHIVE_ROOT && fs.statSync(archiveRoot).dev === fs.statSync("/").dev)) {
  console.error(`STOP: ${archiveRoot} が接続されていない。SSD を繋いでからやり直す`);
  process.exit(2);
}
if (!restore && !force && !fs.existsSync(path.join(repo, "episodes", epId, "publish", "upload-result.json"))) {
  console.error("STOP: publish/upload-result.json が無い(アップロード未完)。退避は公開予約の後(--force で無視)");
  process.exit(2);
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
function sha256(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(8 << 20);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest("hex");
}
function same(a, b) {
  return fs.statSync(a).size === fs.statSync(b).size && sha256(a) === sha256(b);
}
function pruneEmpty(dir, stop) {
  while (dir.startsWith(stop) && dir !== stop && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

const [fromRoot, toRoot] = restore ? [dest, repo] : [repo, dest];
let moved = 0, bytes = 0, conflicts = 0;
for (const rel of TARGETS) {
  const src = path.join(fromRoot, rel);
  if (!fs.existsSync(src)) continue;
  for (const f of walk(src)) {
    const r = path.relative(fromRoot, f);
    const t = path.join(toRoot, r);
    const size = fs.statSync(f).size;
    if (dry) {
      console.log(`[dry] ${r} (${(size / 1e6).toFixed(1)}MB)`);
      moved++; bytes += size;
      continue;
    }
    if (fs.existsSync(t)) {
      if (!same(f, t)) {
        console.error(`CONFLICT: ${r} は退避先に内容の違うものがある。上書きせず残す`);
        conflicts++;
        continue;
      }
    } else {
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.copyFileSync(f, t + ".partial");
      fs.renameSync(t + ".partial", t);
      if (!same(f, t)) {
        fs.rmSync(t);
        console.error(`VERIFY FAIL: ${r} のコピーが一致しない。ローカルは残す`);
        conflicts++;
        continue;
      }
    }
    if (!restore) {
      fs.rmSync(f);
      pruneEmpty(path.dirname(f), repo);
    }
    moved++; bytes += size;
  }
}
const verb = restore ? "書き戻し" : dry ? "退避予定" : "退避して削除";
console.log(`${verb}: ${moved} ファイル / ${(bytes / 1e9).toFixed(2)}GB → ${restore ? repo : dest}${conflicts ? ` / 残した ${conflicts}` : ""}`);
process.exit(conflicts ? 1 : 0);
