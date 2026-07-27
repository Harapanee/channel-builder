import fs from 'node:fs';
import path from 'node:path';
import type { ChannelMetrics, MetricsResponse, MetricsTotals } from '../shared/types';

const SYSTEM_FILE = '.channel-system.json';

const ZERO_TOTALS: MetricsTotals = {
  episodeCount: 0,
  finalCount: 0,
  renderMinutesTotal: 0,
  wallClockHoursTotal: 0,
  imageGenTotal: 0,
};

/**
 * ファクトリールート直下のチャンネル(`.channel-system.json` を持つディレクトリ)を走査し、
 * 各チャンネルの制作メトリクスを集計する。ダッシュボード表示時のみ呼ばれる想定のため
 * 同期readdirでよい(scanner.tsの非同期流儀とは別に、ここは同期で完結させる)。
 *
 * `.channel-system.json` を持たないディレクトリ(factory-ui / node_modules / 隠しディレクトリ等)は
 * 「そもそもチャンネルでない」ため黙って除外する。一方、`.channel-system.json` は在るが
 * 読み込み・パースに失敗したチャンネルは console.error でログした上でスキップする
 * (全体の集計を止めない)。
 */
export function collectMetrics(root: string): MetricsResponse {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const channels: ChannelMetrics[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = entry.name;
    const channelDir = path.join(root, dir);
    const systemPath = path.join(channelDir, SYSTEM_FILE);

    if (!fs.existsSync(systemPath)) continue; // .channel-system.json 不在 = チャンネルでない

    try {
      channels.push(readChannelMetrics(channelDir, dir, systemPath));
    } catch (err) {
      console.error(`[metrics] failed to read channel "${dir}":`, err);
    }
  }

  channels.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));

  const totals = channels.reduce<MetricsTotals>(
    (acc, c) => ({
      episodeCount: acc.episodeCount + c.episodeCount,
      finalCount: acc.finalCount + c.finalCount,
      renderMinutesTotal: acc.renderMinutesTotal + c.renderMinutesTotal,
      wallClockHoursTotal: acc.wallClockHoursTotal + c.wallClockHoursTotal,
      imageGenTotal: acc.imageGenTotal + c.imageGenTotal,
    }),
    { ...ZERO_TOTALS },
  );

  return { channels, totals };
}

/** 1チャンネル分のメトリクスを構築する。system読み込み・パース失敗はthrowして呼び出し側でスキップさせる。 */
function readChannelMetrics(channelDir: string, dir: string, systemPath: string): ChannelMetrics {
  const system = readJsonObject(systemPath); // 失敗はthrow(呼び出し側でスキップ)
  const channelName = typeof system.channelName === 'string' ? system.channelName : '';

  const metricsArr = Array.isArray(system.metrics) ? system.metrics : [];
  let renderMinutesTotal = 0;
  let wallClockHoursTotal = 0;
  let imageGenTotal = 0;
  for (const m of metricsArr) {
    if (!m || typeof m !== 'object') continue;
    const rec = m as Record<string, unknown>;
    renderMinutesTotal += asNumber(rec.renderMinutes);
    wallClockHoursTotal += asNumber(rec.wallClockHours);
    imageGenTotal += asNumber(rec.imageGenCount);
  }

  const { episodeCount, finalCount } = countEpisodes(channelDir);

  return { dir, channelName, episodeCount, finalCount, renderMinutesTotal, wallClockHoursTotal, imageGenTotal };
}

/**
 * episodes/<episodeId>/episode.json からepisodeCount(episode.jsonを持つディレクトリ数)と
 * finalCount(status==='final'の数)を数える。episodes/ 不在や個々のepisode.jsonの
 * 読み込み・パース失敗はそのエピソードを対象外にするだけで、チャンネル全体はスキップしない。
 */
function countEpisodes(channelDir: string): { episodeCount: number; finalCount: number } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(channelDir, 'episodes'), { withFileTypes: true });
  } catch {
    return { episodeCount: 0, finalCount: 0 };
  }

  let episodeCount = 0;
  let finalCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let meta: Record<string, unknown>;
    try {
      meta = readJsonObject(path.join(channelDir, 'episodes', entry.name, 'episode.json'));
    } catch {
      continue; // episode.json 不在・パース不能はカウント対象外
    }
    episodeCount++;
    if (meta.status === 'final') finalCount++;
  }
  return { episodeCount, finalCount };
}

/** JSONファイルを読んでオブジェクトを返す。不在・パース不能・非オブジェクトはthrow。 */
function readJsonObject(file: string): Record<string, unknown> {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`not an object: ${file}`);
  }
  return parsed as Record<string, unknown>;
}

/** 数値でなければ0扱い(NaN/Infinityも0扱い)。 */
function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
