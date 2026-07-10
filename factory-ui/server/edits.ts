import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { safeResolve } from './pathguard';
import { readChannel } from './scanner';

/**
 * 直接編集操作(claude を介さず、ローカルUIサーバーが対象チャンネル配下のファイルを直接書き換える)。
 *
 * セキュリティ方針(全関数共通・多層防御):
 *  1. dir は「単一パスセグメント」であることを検証(`/`・`\`・`..`・`.`・空は throw)。
 *  2. `readChannel(root, dir)` でチャンネルの実在(=`.channel-system.json` あり)を確認。
 *  3. 実際の読み書きは必ず `safeResolve` を通す。root 外脱出・シンボリックリンク脱出・
 *     `.env*`/`.git`/`node_modules` は null になり、その場合は throw する。
 *  4. 書き込みは「解決済みディレクトリ + 固定ファイル名」への temp+rename(アトミック)。
 *     writeFile がシンボリックリンクを辿って root 外へ書くことを避ける。
 *
 * これらにより、編集は対象チャンネルフォルダ配下に限定される。
 */

const SYSTEM_FILE = '.channel-system.json';
const ASSETS_DIR = 'assets';
const LIBRARY_FILE = 'library.json';
const CHANNEL_DIR = 'channel';
const BIBLE_FILE = 'bible.md';

/** bible.md の最大サイズ(バイト)。巨大入力による事故・DoS を防ぐ。 */
const MAX_BIBLE_BYTES = 1024 * 1024; // 1MB

// --- 公開 API ----------------------------------------------------------------

/**
 * エピソードを承認する。`.channel-system.json` の `approvedEpisodes` に episodeId を追加する。
 * 重複は無視(既に含まれていれば書き込みもしない)。既存の他キーは保全する。
 */
export async function approveEpisode(root: string, dir: string, episodeId: string): Promise<void> {
  await assertChannel(root, dir);
  if (typeof episodeId !== 'string' || episodeId.trim() === '') {
    throw new Error(`approveEpisode: 無効な episodeId です`);
  }

  const raw = await readGuarded(root, path.join(dir, SYSTEM_FILE));
  const system = parseJsonObject(raw, `${SYSTEM_FILE} の JSON が不正です`);

  const current = Array.isArray(system.approvedEpisodes)
    ? (system.approvedEpisodes as unknown[]).map((x) => String(x))
    : [];
  if (current.includes(episodeId)) {
    return; // 重複は無視(no-op)
  }
  system.approvedEpisodes = [...current, episodeId];

  await writeGuarded(root, dir, SYSTEM_FILE, jsonText(system));
}

/**
 * 素材ライブラリの1エントリを人間がキュレーションする。
 *  - approve: 該当エントリに `approvedBy: "human"` を付与(他フィールドは保全)。
 *  - reject : 該当エントリを `assets[]` から削除する。
 *
 * reject を「削除」にする理由:
 *  library.schema.json は top/asset とも `additionalProperties: false` のため、
 *  独自の rejected マーカーを足すとスキーマ違反になる。削除なら残エントリは妥当なままで、
 *  「approvedBy:"human" のエントリのみをショットから参照する」という工場の不変条件とも整合する。
 */
export async function curateLibraryEntry(
  root: string,
  dir: string,
  entryId: string,
  decision: 'approve' | 'reject',
): Promise<void> {
  await assertChannel(root, dir);
  if (typeof entryId !== 'string' || entryId.trim() === '') {
    throw new Error(`curateLibraryEntry: 無効な entryId です`);
  }
  if (decision !== 'approve' && decision !== 'reject') {
    throw new Error(`curateLibraryEntry: 無効な decision です: ${String(decision)}`);
  }

  const raw = await readGuarded(root, path.join(dir, ASSETS_DIR, LIBRARY_FILE));
  const lib = parseJsonObject(raw, `${LIBRARY_FILE} の JSON が不正です`);

  // 最低限のスキーマ検証(assets が配列であること)。
  if (!Array.isArray(lib.assets)) {
    throw new Error(`${LIBRARY_FILE}: 不正なスキーマ(assets が配列ではありません)`);
  }
  const assets = lib.assets as Array<Record<string, unknown>>;
  const index = assets.findIndex(
    (a) => a && typeof a === 'object' && (a as Record<string, unknown>).assetId === entryId,
  );
  if (index === -1) {
    throw new Error(`curateLibraryEntry: エントリが見つかりません: ${entryId}`);
  }

  if (decision === 'approve') {
    assets[index] = { ...assets[index], approvedBy: 'human' };
  } else {
    assets.splice(index, 1);
  }

  await writeGuarded(root, path.join(dir, ASSETS_DIR), LIBRARY_FILE, jsonText(lib));
}

/** channel/bible.md の中身(散文)を返す。 */
export async function readBible(root: string, dir: string): Promise<string> {
  await assertChannel(root, dir);
  return readGuarded(root, path.join(dir, CHANNEL_DIR, BIBLE_FILE));
}

/**
 * channel/bible.md を上書きする。
 *  - 空文字・空白のみ・巨大入力(> 1MB)は拒否(throw)。
 *  - 書き込み前に既存内容を `bible.md.bak` として残す。
 *  - 書き込みは temp+rename でアトミックに行う。
 */
export async function writeBible(root: string, dir: string, content: string): Promise<void> {
  await assertChannel(root, dir);

  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error(`writeBible: 空の内容は保存できません`);
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_BIBLE_BYTES) {
    throw new Error(`writeBible: 内容が大きすぎます(上限 ${MAX_BIBLE_BYTES} バイト)`);
  }

  // channel/ ディレクトリを safeResolve(シンボリックリンク脱出・禁止領域を弾く)。
  const channelDirAbs = await safeResolve(root, path.join(dir, CHANNEL_DIR));
  if (!channelDirAbs) {
    throw new Error(`writeBible: パスが解決できません: ${path.join(dir, CHANNEL_DIR)}`);
  }
  const bibleAbs = path.join(channelDirAbs, BIBLE_FILE);

  // 既存があれば、書き込み前に旧内容を .bak として残す。
  // 読み取りは safeResolve 経由(bible.md が root 外へ脱出する symlink なら null → バックアップしない)。
  // .bak の書き込みも writeFileAtomic(temp+rename)で行い、宛先に事前設置された symlink を辿って
  // root 外へ旧内容を書き出す経路を塞ぐ(rename は宛先の dentry を実ファイルで置換する)。
  const existingAbs = await safeResolve(root, path.join(dir, CHANNEL_DIR, BIBLE_FILE));
  if (existingAbs) {
    const previous = await fs.readFile(existingAbs, 'utf8');
    await writeFileAtomic(bibleAbs + '.bak', previous);
  }
  await writeFileAtomic(bibleAbs, content);
}

// --- 内部ヘルパ --------------------------------------------------------------

/**
 * dir が単一セグメントであることを検証し、チャンネルの実在を確認する。
 * どちらか不成立なら throw。
 */
async function assertChannel(root: string, dir: string): Promise<void> {
  assertSingleSegment(dir);
  const channel = await readChannel(root, dir);
  if (!channel) {
    throw new Error(`チャンネルが見つかりません: ${dir}`);
  }
}

/**
 * dir が単一のパスセグメントか検証する。
 * 空文字・`.`・`..`・セパレータ(`/`・`\`・path.sep)を含むものは不正で throw。
 */
function assertSingleSegment(dir: string): void {
  if (
    typeof dir !== 'string' ||
    dir === '' ||
    dir === '.' ||
    dir === '..' ||
    dir.includes('/') ||
    dir.includes('\\') ||
    dir.includes(path.sep)
  ) {
    throw new Error(`不正なチャンネル dir です: ${JSON.stringify(dir)}`);
  }
}

/**
 * safeResolve を通して存在するファイルを読む。null(脱出・禁止領域・不在)なら throw。
 * realpath 済みの実体パスから読むため、シンボリックリンク脱出は届かない。
 */
async function readGuarded(root: string, rel: string): Promise<string> {
  const abs = await safeResolve(root, rel);
  if (!abs) {
    throw new Error(`パスにアクセスできません: ${rel}`);
  }
  return fs.readFile(abs, 'utf8');
}

/**
 * 「解決済みディレクトリ + 固定ファイル名」へアトミック(temp+rename)に書き込む。
 * dirRel を safeResolve し、null(脱出・禁止領域・不在)なら throw。
 * filename は呼び出し側が渡す固定の定数(ユーザー入力ではない)。
 */
async function writeGuarded(
  root: string,
  dirRel: string,
  filename: string,
  data: string,
): Promise<void> {
  const dirAbs = await safeResolve(root, dirRel);
  if (!dirAbs) {
    throw new Error(`パスにアクセスできません: ${dirRel}`);
  }
  await writeFileAtomic(path.join(dirAbs, filename), data);
}

/**
 * temp ファイルへ書いてから rename する。中断時も元ファイルは壊れない。
 * temp は同一ディレクトリ内に作るため rename は同一FS上でアトミック。
 * temp 名はシンボリックリンクではない新規ファイルなので、書き込みが root 外を辿ることはない。
 */
async function writeFileAtomic(file: string, data: string): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.tmp.${randomBytes(8).toString('hex')}`);
  try {
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** JSON を object としてパースする。配列・非オブジェクト・パース失敗は throw。 */
function parseJsonObject(raw: string, message: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(message);
  }
  return parsed as Record<string, unknown>;
}

/** 2スペースインデント + 末尾改行(既存ファイルの体裁に合わせる)。 */
function jsonText(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + '\n';
}
