import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import type { ChannelSummary, EpisodeSummary } from '../shared/types';
import { buildVideoCreateStages } from './progress';

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
): Promise<{ system: Record<string, unknown>; episodes: EpisodeSummary[] } | null> {
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
      stages: buildVideoCreateStages({ status, hasPreview, hasFinal }),
    });
  }

  episodes.sort((a, b) => (a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0));
  return { system, episodes };
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

/** JSON ファイルを読んでオブジェクトを返す。不在・パース不能・非オブジェクトなら null。 */
async function readJson(file: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
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

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}
