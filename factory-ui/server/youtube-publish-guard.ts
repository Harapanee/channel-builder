import fs from 'node:fs';
import path from 'node:path';
import type { YoutubeMetadata } from '../shared/types';

/**
 * 自動アップロード(youtube-publish CLI)の安全装置。理由の配列を返す(空=可)。
 * 自動で上げるのは「非公開+公開予約」だけで、予約までに目視の猶予(minLeadHours)を残す。
 */
export function checkAutoPublish(meta: YoutubeMetadata, now: Date, minLeadHours: number): string[] {
  const errs: string[] = [];
  if (meta.privacyStatus !== 'private') {
    errs.push(`privacyStatus は private のみ自動アップロードできます(現在 ${meta.privacyStatus})`);
  }
  if (!meta.publishAt) {
    errs.push('publishAt(公開予約日時)がありません。自動アップロードは予約投稿だけです');
  } else {
    const leadH = (Date.parse(meta.publishAt) - now.getTime()) / 3_600_000;
    if (leadH < minLeadHours) {
      errs.push(
        `publishAt が近すぎます(あと${leadH.toFixed(1)}時間)。目視の時間として${minLeadHours}時間以上先にしてください`,
      );
    }
  }
  return errs;
}

const KNOWN_FLAGS = new Set([
  '--file',
  '--short',
  '--playlist-only',
  '--list-playlists',
  '--auto-slot',
  '--show-slot',
  '--min-lead-hours',
]);

/** 未知の `--` 引数(打ち間違い)を理由として返す。黙って通常アップロードへ進ませない */
export function checkArgs(args: string[]): string[] {
  return args.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a)).map((a) => `未知のオプション: ${a}`);
}

/**
 * metadata.json を書き換える前に、ローカルでわかるアップロード不可の理由を返す
 * (startUpload の preflight と同じ判定を前に出す。止まったのに metadata だけ変わるのを防ぐ)。
 */
export function checkLocalPreflight(epDir: string, videoFile: string): string[] {
  const errs: string[] = [];
  if (fs.existsSync(path.join(epDir, 'publish', 'upload-result.json'))) {
    errs.push('publish/upload-result.json が既にあります(アップロード済み。再生リストだけなら --playlist-only)');
  }
  if (!fs.existsSync(path.join(epDir, videoFile))) errs.push(`動画ファイルがありません: ${videoFile}`);
  return errs;
}
