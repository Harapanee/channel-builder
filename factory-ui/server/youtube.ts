import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { YoutubeAuthStatus, YoutubeMetadata, YoutubeUploadJob } from '../shared/types';
import { validateMetadata, isSafeRel } from './youtube-metadata';

export type StoredToken = {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
};

export type UploadParams = {
  videoPath: string;               // 絶対パス
  thumbnailPath?: string;          // 絶対パス
  meta: YoutubeMetadata;
  token: StoredToken;
  onToken: (t: StoredToken) => void;   // リフレッシュ時に永続化させる
  onProgress: (bytesSent: number) => void;
};

/**
 * YouTube Data API の抽象。実装は youtube-google.ts(googleapis)。
 * テストはFakeを注入する(render-queue の SpawnRender と同じ流儀)。
 */
export interface YoutubeApi {
  generateAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<StoredToken>;
  getChannelTitle(token: StoredToken, onToken: (t: StoredToken) => void): Promise<string>;
  upload(params: UploadParams): Promise<string>; // 成功時 videoId
  setThumbnail(
    token: StoredToken,
    videoId: string,
    thumbnailPath: string,
    onToken: (t: StoredToken) => void,
  ): Promise<void>;
}

/**
 * チャンネル別のYouTube連携+アップロードジョブ管理。
 * - トークン: <root>/<dir>/channel/youtube-oauth.json(保存時に .gitignore へ追記)
 * - api === null は factory-ui/youtube-client.json 未設置(status: no_client)
 */
export class YoutubeManager extends EventEmitter {
  private readonly jobs = new Map<string, YoutubeUploadJob>();
  /** preflight開始〜アップロード完了まで占有するエピソードスロット(`dir/epId`)。
   *  最初のawaitより前に同期予約し、同時startUploadのTOCTOU競合(二重アップロード)を防ぐ */
  private readonly pending = new Set<string>();

  constructor(
    private readonly root: string,
    private readonly apiProvider: () => YoutubeApi | null,
  ) {
    super();
  }

  /** API実装を毎回プロバイダから取得する(youtube-client.json 設置直後から再起動なしで有効) */
  private get api(): YoutubeApi | null {
    return this.apiProvider();
  }

  private channelDir(dir: string): string {
    if (dir === '' || dir === '.' || dir === '..' || dir.includes('/') || dir.includes('\\')) {
      throw new Error('invalid: 不正なチャンネルディレクトリです');
    }
    return path.join(this.root, dir);
  }

  private tokenPath(dir: string): string {
    return path.join(this.channelDir(dir), 'channel', 'youtube-oauth.json');
  }

  private readToken(dir: string): StoredToken | null {
    try {
      return JSON.parse(fs.readFileSync(this.tokenPath(dir), 'utf8')) as StoredToken;
    } catch {
      return null;
    }
  }

  /** トークンを保存し、チャンネルの .gitignore に(あれば・未記載なら)追記する */
  private async saveToken(dir: string, token: StoredToken): Promise<void> {
    const p = this.tokenPath(dir);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, JSON.stringify(token, null, 2));
    const gi = path.join(this.channelDir(dir), '.gitignore');
    const entry = 'channel/youtube-oauth.json';
    try {
      const cur = await fsp.readFile(gi, 'utf8');
      if (!cur.split('\n').includes(entry)) {
        await fsp.appendFile(gi, (cur.endsWith('\n') ? '' : '\n') + entry + '\n');
      }
    } catch {
      /* .gitignore 無しのチャンネルは追記しない(独立repoでない可能性) */
    }
  }

  async status(dir: string): Promise<YoutubeAuthStatus> {
    const api = this.api;
    if (!api) return { connected: false, reason: 'no_client' };
    const token = this.readToken(dir);
    if (!token) return { connected: false, reason: 'no_token' };
    try {
      // onTokenは同期契約(ブリーフ準拠)。保存Promiseを捕捉し、応答前に完了を待つ
      let pendingSave: Promise<void> | undefined;
      const channelTitle = await api.getChannelTitle(token, (t) => {
        pendingSave = this.saveToken(dir, t);
      });
      if (pendingSave) await pendingSave;
      return { connected: true, channelTitle };
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (msg.includes('invalid_grant')) return { connected: false, reason: 'needs_reauth' };
      throw err;
    }
  }

  authUrl(dir: string): string {
    this.channelDir(dir); // dir検証
    const api = this.api;
    if (!api) throw new Error('no_auth: youtube-client.json が未設置です');
    return api.generateAuthUrl(dir);
  }

  /** OAuthコールバック。state=dir。トークンを交換して保存する */
  async handleCallback(code: string, state: string): Promise<void> {
    this.channelDir(state); // state(dir)検証
    const api = this.api;
    if (!api) throw new Error('no_auth: youtube-client.json が未設置です');
    const token = await api.exchangeCode(code);
    await this.saveToken(state, token);
  }

  list(): YoutubeUploadJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private episodeDir(dir: string, epId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(epId)) throw new Error(`invalid: 不正なepisodeId: ${epId}`);
    return path.join(this.channelDir(dir), 'episodes', epId);
  }

  /** out/ 直下のmp4一覧(UIのファイル選択用)。既定候補は final.mp4 */
  async listVideoFiles(dir: string, epId: string): Promise<{ file: string; size: number }[]> {
    const outDir = path.join(this.episodeDir(dir, epId), 'out');
    let names: string[];
    try {
      names = await fsp.readdir(outDir);
    } catch {
      return [];
    }
    const result: { file: string; size: number }[] = [];
    for (const name of names.filter((n) => n.endsWith('.mp4')).sort()) {
      const st = await fsp.stat(path.join(outDir, name));
      if (st.isFile()) result.push({ file: `out/${name}`, size: st.size });
    }
    return result;
  }

  private emitUpdate(job: YoutubeUploadJob): void {
    this.emit('update', { ...job });
  }

  /**
   * アップロード開始。preflight(連携・動画・メタデータ・二重投稿)を検証してから
   * ジョブを返し、転送本体は非同期で続行する。進捗・完了は 'update' イベント。
   */
  async startUpload(req: {
    dir: string;
    epId: string;
    videoFile: string;
    force?: boolean;
  }): Promise<YoutubeUploadJob> {
    const { dir, epId, videoFile } = req;
    const epDir = this.episodeDir(dir, epId);
    const api = this.api;
    if (!api) throw new Error('no_auth: youtube-client.json が未設置です');
    const token = this.readToken(dir);
    if (!token) throw new Error('no_auth: このチャンネルはYouTube未連携です');

    if (!isSafeRel(videoFile) || !videoFile.startsWith('out/') || !videoFile.endsWith('.mp4')) {
      throw new Error(`invalid: videoFile は out/ 配下のmp4を指定してください: ${videoFile}`);
    }

    // 最初のawaitより前に同期でスロット予約(同時呼び出しのTOCTOU競合防止)。
    // preflight失敗時はここで解放、成功時は runUpload 完了まで占有する。
    const slot = `${dir}/${epId}`;
    if (this.pending.has(slot)) throw new Error('duplicate: このエピソードは既にアップロード中です');
    this.pending.add(slot);
    try {
      return await this.preflightAndStart(req, { epDir, token, slot, api });
    } catch (err) {
      this.pending.delete(slot);
      throw err;
    }
  }

  /** preflight本体(await含む)。成功時はスロットを保持したままジョブを開始する */
  private async preflightAndStart(
    req: { dir: string; epId: string; videoFile: string; force?: boolean },
    opts: { epDir: string; token: StoredToken; slot: string; api: YoutubeApi },
  ): Promise<YoutubeUploadJob> {
    const { dir, epId, videoFile } = req;
    const { epDir, token, slot } = opts;
    const videoPath = path.join(epDir, videoFile);
    let videoStat;
    try {
      videoStat = await fsp.stat(videoPath);
    } catch {
      throw new Error(`not_found: 動画ファイルがありません: ${videoFile}`);
    }

    let rawMeta: string;
    try {
      rawMeta = await fsp.readFile(path.join(epDir, 'publish', 'metadata.json'), 'utf8');
    } catch {
      throw new Error('not_found: publish/metadata.json がありません');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMeta);
    } catch {
      throw new Error('invalid: publish/metadata.json がJSONとして不正です');
    }
    const meta = validateMetadata(parsed); // invalid: を素通し

    let thumbnailPath: string | undefined;
    if (meta.thumbnail) {
      thumbnailPath = path.join(epDir, meta.thumbnail);
      try {
        await fsp.stat(thumbnailPath);
      } catch {
        throw new Error(`not_found: サムネイルがありません: ${meta.thumbnail}`);
      }
    }

    // 二重アップロード防止: 過去の成功記録 or 実行中ジョブ
    const resultPath = path.join(epDir, 'publish', 'upload-result.json');
    if (!req.force && fs.existsSync(resultPath)) {
      throw new Error('duplicate: upload-result.json が既にあります(force指定で再アップロード可)');
    }
    const active = [...this.jobs.values()].some(
      (j) => j.dir === dir && j.epId === epId && (j.status === 'uploading' || j.status === 'setting_thumbnail'),
    );
    if (active) throw new Error('duplicate: このエピソードは既にアップロード中です');

    const job: YoutubeUploadJob = {
      id: randomUUID(),
      dir,
      epId,
      videoFile,
      status: 'uploading',
      bytesSent: 0,
      bytesTotal: videoStat.size,
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.emitUpdate(job);
    void this.runUpload(job, { videoPath, thumbnailPath, meta, token, resultPath, slot, api: opts.api });
    return { ...job };
  }

  private async runUpload(
    job: YoutubeUploadJob,
    ctx: {
      videoPath: string;
      thumbnailPath?: string;
      meta: YoutubeMetadata;
      token: StoredToken;
      resultPath: string;
      slot: string;
      api: YoutubeApi;
    },
  ): Promise<void> {
    const api = ctx.api;
    // onTokenは同期契約。保存失敗はアップロード本体を止めない(次回リフレッシュで再保存される)
    const onToken = (t: StoredToken) => void this.saveToken(job.dir, t).catch(() => {});
    try {
      // 進捗は約500ms間隔に間引く(WSを進捗イベントで溢れさせない)
      let lastEmit = 0;
      const videoId = await api.upload({
        videoPath: ctx.videoPath,
        thumbnailPath: ctx.thumbnailPath,
        meta: ctx.meta,
        token: ctx.token,
        onToken,
        onProgress: (bytesSent) => {
          job.bytesSent = bytesSent;
          const now = Date.now();
          if (now - lastEmit >= 500 || bytesSent >= job.bytesTotal) {
            lastEmit = now;
            this.emitUpdate(job);
          }
        },
      });
      job.videoId = videoId;
      job.url = `https://www.youtube.com/watch?v=${videoId}`;
      if (ctx.thumbnailPath) {
        job.status = 'setting_thumbnail';
        this.emitUpdate(job);
        await api.setThumbnail(ctx.token, videoId, ctx.thumbnailPath, onToken);
      }
      await fsp.writeFile(
        ctx.resultPath,
        JSON.stringify(
          {
            videoId,
            url: job.url,
            privacyStatus: ctx.meta.privacyStatus,
            uploadedAt: new Date().toISOString(),
            videoFile: job.videoFile,
          },
          null,
          2,
        ),
      );
      job.status = 'done';
    } catch (err) {
      job.status = 'failed';
      job.error = String(err instanceof Error ? err.message : err);
    }
    this.pending.delete(ctx.slot); // 完了/失敗でスロット解放(以降は upload-result.json / force で制御)
    job.finishedAt = new Date().toISOString();
    this.emitUpdate(job);
  }
}
