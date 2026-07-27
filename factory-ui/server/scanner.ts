import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import type { ChannelSummary, EpisodeSummary, ShortSummary, ShortFormatSummary } from '../shared/types';
import { buildVideoCreateStages, buildShortStages } from './progress';

const SYSTEM_FILE = '.channel-system.json';

/**
 * ファクトリールート直下で `.channel-system.json` を持つディレクトリのみをチャンネルとして列挙する。
 * JSON のパースに失敗したディレクトリはスキップする。結果は dir 名でソート済み。
 */
export async function scanFactory(root: string): Promise<ChannelSummary[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const channels: ChannelSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = entry.name;

    const system = await readSystem(path.join(root, dir));
    if (!system) continue; // .channel-system.json 不在 or パース失敗 → スキップ

    channels.push({
      dir,
      channelId: asString(system.channelId),
      channelName: asString(system.channelName),
      status: asString(system.status),
      systemVersion: asString(system.systemVersion),
      stage: typeof system.stage === 'number' ? system.stage : undefined,
      approvedEpisodes: asStringArray(system.approvedEpisodes),
      episodeCount: await countEpisodes(path.join(root, dir)),
    });
  }

  channels.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return channels;
}

/**
 * 指定チャンネルの system(.channel-system.json)と episodes を読む。
 * `.channel-system.json` が不在・パース不能なら null。
 * episodes は各 `episodes/<id>/episode.json` から構築し、episode.json 不在のフォルダも
 * ファイル存在フラグのみで含める。episodeId でソート済み。
 */
export async function readChannel(
  root: string,
  dir: string,
): Promise<{
  system: Record<string, unknown>;
  episodes: EpisodeSummary[];
  shorts: ShortSummary[];
  shortFormats: ShortFormatSummary[];
} | null> {
  // HTTP層がリクエスト値をそのまま渡しても root 外に出られないよう、
  // dir は「単一のパスセグメント」のみ許可する。
  if (!isSingleSegment(dir)) return null;
  const channelDir = path.join(root, dir);
  const system = await readSystem(channelDir);
  if (!system) return null;

  const episodesDir = path.join(channelDir, 'episodes');
  let epEntries: Dirent[] = [];
  try {
    epEntries = await fs.readdir(episodesDir, { withFileTypes: true });
  } catch {
    epEntries = [];
  }

  const episodes: EpisodeSummary[] = [];
  for (const entry of epEntries) {
    if (!entry.isDirectory()) continue;
    const episodeId = entry.name;
    const epDir = path.join(episodesDir, episodeId);

    const meta = (await readJson(path.join(epDir, 'episode.json'))) ?? {};

    const status = typeof meta.status === 'string' ? meta.status : undefined;
    const hasPreview = await exists(path.join(epDir, 'out', 'preview.mp4'));
    const hasFinal = await exists(path.join(epDir, 'out', 'final.mp4'));
    episodes.push({
      episodeId,
      subject: typeof meta.subject === 'string' ? meta.subject : undefined,
      status,
      targetDurationSec: typeof meta.targetDurationSec === 'number' ? meta.targetDurationSec : undefined,
      hasPreview,
      hasFinal,
      hasScript: await exists(path.join(epDir, 'script.md')),
      reviewFiles: await listReviewFiles(path.join(epDir, 'review')),
      thumbnailFiles: await listThumbnailFiles(path.join(epDir, 'publish')),
      selectedThumbnail: await readSelectedThumbnail(epDir),
      stages: buildVideoCreateStages({ status, hasPreview, hasFinal }),
    });
  }

  episodes.sort((a, b) => (a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0));

  const shorts = await listShorts(channelDir);
  const shortFormats = await listShortFormats(channelDir);
  return { system, episodes, shorts, shortFormats };
}

// --- 内部ヘルパ ---------------------------------------------------------------

/**
 * dir が単一のパスセグメントか検証する(readChannel のハードニング)。
 * 空文字・`.`・`..`・セパレータ(`/`・`\`・path.sep)を含むものは不正。
 */
function isSingleSegment(dir: string): boolean {
  if (dir === '' || dir === '.' || dir === '..') return false;
  if (dir.includes('/') || dir.includes('\\') || dir.includes(path.sep)) return false;
  return true;
}

/** `.channel-system.json` を読んでオブジェクトを返す。不在・パース不能なら null。 */
async function readSystem(channelDir: string): Promise<Record<string, unknown> | null> {
  return readJson(path.join(channelDir, SYSTEM_FILE));
}

/**
 * JSON ファイルを読んでオブジェクトを返す。不在(ENOENT)・パース不能・非オブジェクトなら null。
 * ENOENT以外のfsエラー(EACCES・EMFILE等の一過性/権限エラー)はrethrowする。
 * 「読めない」を「無い」と同一視すると、負荷時の一過性エラーが誤って404(スキップ)に化けるため
 * (parse失敗はJSON.parseのSyntaxErrorであり、ここのfs失敗とは別に扱う)。
 */
async function readJson(file: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** episodes/ 直下のディレクトリ数を数える(不在なら 0)。 */
async function countEpisodes(channelDir: string): Promise<number> {
  try {
    const entries = await fs.readdir(path.join(channelDir, 'episodes'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

/** review/ 直下のファイル名(ソート済み)。不在なら空配列。 */
async function listReviewFiles(reviewDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(reviewDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

const THUMBNAIL_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** publish/ 直下の画像ファイル名(ソート済み)。不在なら空配列。 */
async function listThumbnailFiles(publishDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(publishDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && THUMBNAIL_EXTS.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** publish/metadata.json の thumbnail(エピソード相対パス)。不在・不正なら undefined。 */
async function readSelectedThumbnail(epDir: string): Promise<string | undefined> {
  const meta = await readJson(path.join(epDir, 'publish', 'metadata.json'));
  const t = meta?.thumbnail;
  return typeof t === 'string' ? t : undefined;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * shorts/ 配下を列挙し、各 shorts/<shortId>/short.json からサマリを構築する。
 * episodes と同じ流儀: short.json 不在・パース不能のフォルダもフラグのみで含める。
 */
async function listShorts(channelDir: string): Promise<ShortSummary[]> {
  const shortsDir = path.join(channelDir, 'shorts');
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(shortsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const shorts: ShortSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const shortId = entry.name;
    const shDir = path.join(shortsDir, shortId);
    const meta = (await readJson(path.join(shDir, 'short.json'))) ?? {};
    const status = typeof meta.status === 'string' ? meta.status : undefined;
    const hasFinal = await exists(path.join(shDir, 'out', 'final.mp4'));
    const hasMetadata = await exists(path.join(shDir, 'publish', 'metadata.json'));
    shorts.push({
      shortId,
      title: typeof meta.title === 'string' ? meta.title : undefined,
      formatId: typeof meta.formatId === 'string' ? meta.formatId : undefined,
      sourceEpisodeId: typeof meta.sourceEpisodeId === 'string' ? meta.sourceEpisodeId : undefined,
      status,
      hasScript: await exists(path.join(shDir, 'script.md')),
      hasFinal,
      hasMetadata,
      reviewFiles: await listReviewFiles(path.join(shDir, 'review')),
      stages: buildShortStages({ status, hasFinal, hasMetadata }),
    });
  }
  shorts.sort((a, b) => (a.shortId < b.shortId ? -1 : a.shortId > b.shortId ? 1 : 0));
  return shorts;
}

/** channel/short-formats/*.json を列挙する(パース不能・非objectはスキップ)。 */
async function listShortFormats(channelDir: string): Promise<ShortFormatSummary[]> {
  const fmtDir = path.join(channelDir, 'channel', 'short-formats');
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(fmtDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const formats: ShortFormatSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const meta = await readJson(path.join(fmtDir, entry.name));
    if (!meta) continue; // 教義(.md)や壊れたJSONは表示対象外
    formats.push({
      formatId: typeof meta.formatId === 'string' ? meta.formatId : entry.name.replace(/\.json$/, ''),
      name: typeof meta.name === 'string' ? meta.name : undefined,
      targetDurationSec: typeof meta.targetDurationSec === 'number' ? meta.targetDurationSec : undefined,
    });
  }
  formats.sort((a, b) => (a.formatId < b.formatId ? -1 : a.formatId > b.formatId ? 1 : 0));
  return formats;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}
