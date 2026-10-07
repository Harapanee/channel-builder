#!/usr/bin/env tsx
/**
 * 完成動画を「非公開+公開予約」でアップロードし、再生リストへ追加する(video-create 工程12)。
 *   tsx factory-ui/scripts/youtube-publish.ts <channelDir> <epId> [--file out/final.mp4] [--short]
 *   ... <channelDir> <epId> --playlist-only   再生リストの追加だけをやり直す(動画は上げ直さない)
 *   ... <channelDir> --list-playlists          連携チャンネルの再生リスト一覧
 *   --auto-slot           公開日時を自動で決める: API で公開済み・予約中の時刻を読み、毎日の公開枠
 *                         (youtube-publish.json の dailySlotHourJst)のうち空いている最も早い日を metadata.json に書く
 *   --show-slot           空き枠を表示するだけ(何も書かない・アップロードしない)
 *   --min-lead-hours <n>  猶予(youtube-publish.json の minLeadHours)をこの実行だけ上書き。人間が明示したときだけ使う
 * exit 0=成功 / 1=実行時の失敗(再生リストの失敗を含む)/ 2=安全装置・入力不正で停止(YouTubeへ何も送っていない)
 * factory-ui のサーバーは不要。トークンは <ch>/channel/youtube-oauth.json(factory-ui で連携済みのもの)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { YoutubeManager, type PlaylistResult } from '../server/youtube';
import { loadYoutubeApi } from '../server/youtube-google';
import { validateMetadata } from '../server/youtube-metadata';
import { readPublishConfig } from '../server/youtube-publish-config';
import { checkArgs, checkAutoPublish, checkLocalPreflight } from '../server/youtube-publish-guard';
import { applySlot, localPublishTimes, nextFreeSlot, toJstIso } from '../server/youtube-slot';
import type { YoutubeUploadJob } from '../shared/types';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const fileIdx = args.indexOf('--file');
const leadIdx = args.indexOf('--min-lead-hours');
const valueIdx = new Set([fileIdx, leadIdx].filter((i) => i >= 0).map((i) => i + 1));
const positional = args.filter((a, i) => !a.startsWith('--') && !valueIdx.has(i));
const [channelArg, epId] = positional;
const USAGE =
  'usage: youtube-publish <channelDir> <epId> [--file out/final.mp4] [--short] [--playlist-only] [--auto-slot|--show-slot] [--min-lead-hours <n>] | <channelDir> --list-playlists';

const argErrors = checkArgs(args);
if (!channelArg || argErrors.length) {
  argErrors.forEach((e) => console.error(`STOP: ${e}`));
  console.error(USAGE);
  process.exit(2);
}

const channelDir = path.resolve(channelArg);
const root = path.dirname(channelDir);
const dir = path.basename(channelDir);
const kind = flag('--short') ? ('short' as const) : ('episode' as const);
// redirectUri は認可フロー用。アップロードでは使わない
const m = new YoutubeManager(root, () => loadYoutubeApi(root, 'http://127.0.0.1:4700/api/youtube/callback'));

function report(r: PlaylistResult[]): number {
  if (r.length === 0) console.log('再生リスト: 設定なし(channel/youtube-publish.json)');
  r.forEach((p) => console.log(`再生リスト ${p.id}\t${p.status}${p.error ? `\t${p.error}` : ''}`));
  return r.some((p) => p.status === 'failed') ? 1 : 0;
}

async function main(): Promise<number> {
  if (flag('--list-playlists')) {
    for (const p of await m.listPlaylists(dir)) console.log(`${p.id}\t${p.title}`);
    return 0;
  }
  if (!epId) {
    console.error(USAGE);
    return 2;
  }
  if (flag('--playlist-only')) return report(await m.addToPlaylists(dir, epId, kind));

  const epDir = path.join(channelDir, kind === 'short' ? 'shorts' : 'episodes', epId);
  const metaPath = path.join(epDir, 'publish', 'metadata.json');
  if (!fs.existsSync(metaPath)) throw new Error(`not_found: ${metaPath} がありません`);
  const cfg = readPublishConfig(channelDir);
  let minLead = cfg.minLeadHours;
  if (leadIdx >= 0) {
    minLead = Number(args[leadIdx + 1]);
    if (!Number.isFinite(minLead) || minLead < 0) throw new Error('invalid: --min-lead-hours は0以上の数値が必要です');
    console.log(`猶予を上書き: ${minLead}時間`);
  }

  const videoFile = (fileIdx >= 0 ? args[fileIdx + 1] : undefined) ?? 'out/final.mp4';
  if (!flag('--show-slot')) {
    // metadata.json を書き換える前に止める(止まったのに metadata だけ変わるのを防ぐ)
    const local = checkLocalPreflight(epDir, videoFile);
    if (local.length) {
      local.forEach((e) => console.error(`STOP: ${e}`));
      return 2;
    }
  }

  if (flag('--auto-slot') || flag('--show-slot')) {
    if (cfg.dailySlotHourJst === undefined) {
      throw new Error('invalid: channel/youtube-publish.json に dailySlotHourJst(毎日の公開時刻)がありません');
    }
    const now = new Date();
    // API の時刻に、自分で予約した回のローカル記録を足す(API の返し方に左右されない保険)
    const occupied = [...(await m.listPublishTimes(dir)), ...localPublishTimes(channelDir)];
    const slot = nextFreeSlot(occupied, now, { hourJst: cfg.dailySlotHourJst, minLeadHours: minLead });
    console.log(`空き枠: ${toJstIso(slot)}`);
    if (flag('--show-slot')) return 0;
    const { meta: next, notes } = applySlot(JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>, slot, now);
    validateMetadata(next); // 書く前に契約を確かめる
    fs.writeFileSync(metaPath, JSON.stringify(next, null, 2) + '\n');
    console.log(`metadata.json の publishAt を ${toJstIso(slot)} にした`);
    notes.forEach((n) => console.log(`NOTE: ${n}`));
  }

  const meta = validateMetadata(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
  const stop = checkAutoPublish(meta, new Date(), minLead);
  if (stop.length) {
    stop.forEach((e) => console.error(`STOP: ${e}`));
    return 2;
  }

  const job = await m.startUpload({ dir, epId, kind, videoFile });
  const end: YoutubeUploadJob = await new Promise((resolve) => {
    m.on('update', (j: YoutubeUploadJob) => {
      if (j.id !== job.id) return;
      if (j.status === 'uploading' && j.bytesTotal > 0) {
        process.stdout.write(`\rupload ${Math.round((j.bytesSent / j.bytesTotal) * 100)}%`);
      }
      if (j.status === 'done' || j.status === 'failed') resolve(j);
    });
  });
  console.log('');
  if (end.status === 'failed') {
    console.error(`FAILED: ${end.error}`);
    return 1;
  }
  console.log(`uploaded: ${end.url}(非公開・公開予約 ${meta.publishAt})`);
  const result = JSON.parse(fs.readFileSync(path.join(epDir, 'publish', 'upload-result.json'), 'utf8')) as {
    playlists?: PlaylistResult[];
  };
  report(result.playlists ?? []);
  // サムネ・再生リストなど後段の失敗(動画と upload-result は残っている)
  end.warnings?.forEach((w) => console.error(`WARN: ${w}`));
  if (end.warnings?.length) {
    console.error(`動画はアップロード済み。再生リストのやり直し: youtube-publish ${channelArg} ${epId} --playlist-only`);
    return 1;
  }
  return 0;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    const msg = String(e instanceof Error ? e.message : e);
    console.error(msg);
    process.exit(/^(invalid|duplicate|not_found|no_auth):/.test(msg) ? 2 : 1);
  },
);
