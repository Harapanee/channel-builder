import fs from 'node:fs';
import path from 'node:path';

/**
 * チャンネルの公開設定 <ch>/channel/youtube-publish.json。
 * - playlists: アップロード後に追加する再生リストID(本編/ショート別)
 * - minLeadHours: 自動アップロードで許す公開予約までの最短時間(目視の猶予)
 * - dailySlotHourJst: 毎日投稿の公開時刻(JST の時)。--auto-slot が空き枠を選ぶ。省略=自動枠なし
 */
export type PublishConfig = {
  playlists: { episode: string[]; short: string[] };
  minLeadHours: number;
  dailySlotHourJst?: number;
};

const ID = /^[A-Za-z0-9_-]+$/;

function ids(v: unknown, key: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !ID.test(x))) {
    throw new Error(`invalid: youtube-publish.json の playlists.${key} は再生リストIDの配列が必要です`);
  }
  return v as string[];
}

/** 無ければ既定値(再生リストなし・24時間)。不正は `invalid:` を throw */
export function readPublishConfig(channelDir: string): PublishConfig {
  const p = path.join(channelDir, 'channel', 'youtube-publish.json');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { playlists: { episode: [], short: [] }, minLeadHours: 24 };
    }
    throw new Error(`invalid: youtube-publish.json が読めません: ${String(err)}`);
  }
  const pl = (raw.playlists ?? {}) as Record<string, unknown>;
  const lead = raw.minLeadHours ?? 24;
  if (typeof lead !== 'number' || !Number.isFinite(lead) || lead < 0) {
    throw new Error('invalid: minLeadHours は0以上の数値が必要です');
  }
  const hour = raw.dailySlotHourJst;
  if (hour !== undefined && (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23)) {
    throw new Error('invalid: dailySlotHourJst は0〜23の整数が必要です');
  }
  return {
    playlists: { episode: ids(pl.episode, 'episode'), short: ids(pl.short, 'short') },
    minLeadHours: lead,
    ...(hour !== undefined ? { dailySlotHourJst: hour } : {}),
  };
}
