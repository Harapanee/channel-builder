import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import type { Request, Response } from 'express';
import type { ImageEntry, VoiceEntry } from '../shared/types';

/** media エンドポイントで配信を許可する拡張子 → Content-Type */
export const MEDIA_CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

/** Range リクエストに応じる拡張子(動画・音声のみ) */
const RANGEABLE_EXTS = new Set(['.mp4', '.wav', '.mp3']);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VOICE_EXTS = new Set(['.wav', '.mp3']);

/** images 走査で除外するディレクトリ(実チャンネルは巨大な node_modules を持つ) */
const EXCLUDED_DIRS = new Set(['node_modules', '.git']);

/** images 走査の再帰深さ上限(チャンネルdir基準) */
const MAX_WALK_DEPTH = 8;

/**
 * 検証済み絶対パス(safeResolve 通過後)のメディアファイルを配信する。
 * mp4/wav/mp3 は Range 対応(206 + Content-Range、充足不能は 416)。
 * 画像は Range を無視して常に 200 で全体を返す。
 */
export async function sendMedia(req: Request, res: Response, absPath: string): Promise<void> {
  const ext = path.extname(absPath).toLowerCase();
  const contentType = MEDIA_CONTENT_TYPES[ext];
  if (!contentType) {
    res.status(403).json({ error: 'forbidden media type' });
    return;
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(absPath);
  } catch {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (!stat.isFile()) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const size = stat.size;

  const rangeHeader = req.headers.range;
  if (RANGEABLE_EXTS.has(ext)) {
    res.setHeader('Accept-Ranges', 'bytes');
    if (typeof rangeHeader === 'string') {
      const range = parseByteRange(rangeHeader, size);
      if (range === 'unsatisfiable') {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        res.end();
        return;
      }
      if (range) {
        const { start, end } = range;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', end - start + 1);
        res.setHeader('Content-Type', contentType);
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        streamFile(res, absPath, { start, end });
        return;
      }
      // 構文不正な Range は無視して全体を返す(RFC 9110)
    }
  }

  res.status(200);
  res.setHeader('Content-Length', size);
  res.setHeader('Content-Type', contentType);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  streamFile(res, absPath);
}

/**
 * `bytes=start-end` 形式の単一レンジを解釈する。
 *  - 充足可能なら { start, end }(end はファイル末尾にクランプ)
 *  - start がサイズ以上・逆転・空サフィックスなどは 'unsatisfiable'
 *  - 構文として扱えないヘッダは null(→ 200 全体で応答)
 */
function parseByteRange(
  header: string,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;

  if (rawStart === '') {
    // サフィックスレンジ: bytes=-N(末尾N bytes)
    const suffix = Number(rawEnd);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return 'unsatisfiable';
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (start > end) return 'unsatisfiable';
  return { start, end };
}

function streamFile(res: Response, absPath: string, range?: { start: number; end: number }): void {
  const stream = fs.createReadStream(absPath, range);
  stream.on('error', () => {
    // ヘッダ送信後に読み取りが失敗したら接続を切るしかない
    res.destroy();
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/**
 * チャンネル配下の assets/・episodes/(各エピソードdir)・scratchpad_gen/ から画像
 * (png/jpg/jpeg/webp)を集め、mtime 降順で最大 limit 件返す。
 * node_modules / .git / ドットディレクトリは除外。シンボリックリンクは辿らない。
 */
export async function listImages(channelDir: string, limit: number): Promise<ImageEntry[]> {
  const roots: string[] = ['assets', 'scratchpad_gen'];
  for (const ep of await listSubdirs(path.join(channelDir, 'episodes'))) {
    roots.push(path.join('episodes', ep));
  }

  const results: ImageEntry[] = [];
  for (const rel of roots) {
    await walkImages(channelDir, rel, 0, results);
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, Math.max(0, limit));
}

async function walkImages(
  channelDir: string,
  rel: string,
  depth: number,
  out: ImageEntry[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(path.join(channelDir, rel), { withFileTypes: true });
  } catch {
    return; // 不在ディレクトリはスキップ
  }
  for (const entry of entries) {
    const entryRel = path.join(rel, entry.name);
    if (entry.isDirectory()) {
      const lower = entry.name.toLowerCase();
      if (EXCLUDED_DIRS.has(lower) || entry.name.startsWith('.')) continue;
      if (depth + 1 >= MAX_WALK_DEPTH) continue;
      await walkImages(channelDir, entryRel, depth + 1, out);
      continue;
    }
    if (!entry.isFile()) continue; // シンボリックリンク等は辿らない
    if (!IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
    try {
      const stat = await fsp.stat(path.join(channelDir, entryRel));
      out.push({
        path: entryRel.split(path.sep).join('/'),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    } catch {
      // 走査中に消えたファイルはスキップ
    }
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !EXCLUDED_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * voice-samples/ 直下の .wav/.mp3 を名前順で返す。ディレクトリ不在なら空配列。
 * name は拡張子を除いたファイル名。
 */
export async function listVoices(channelDir: string): Promise<VoiceEntry[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(path.join(channelDir, 'voice-samples'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && VOICE_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => ({
      path: `voice-samples/${e.name}`,
      name: e.name.slice(0, e.name.length - path.extname(e.name).length),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
