import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import type {
  AnalyticsData,
  RetentionPoint,
  ThumbTestData,
  UploadKind,
  YoutubeAuthStatus,
  YoutubeMetadata,
  YoutubeUploadJob,
} from '../shared/types';
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
export type FetchAnalyticsParams = {
  token: StoredToken;
  onToken: (t: StoredToken) => void;
  videoId: string;
};

export type FetchAnalyticsResult = {
  metrics: Record<string, number>;
  retentionCurve: RetentionPoint[];
};

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
  fetchAnalytics(params: FetchAnalyticsParams): Promise<FetchAnalyticsResult>;
}

/**
 * チャンネル別のYouTube連携+アップロードジョブ管理。
 * - トークン: <root>/<dir>/channel/youtube-oauth.json(保存時に .gitignore へ追記)
 * - api === null は factory-ui/youtube-client.json 未設置(status: no_client)
 */
/** 永続化するアップロード履歴の上限件数(新しい順) */
const MAX_PERSISTED_JOBS = 200;

export class YoutubeManager extends EventEmitter {
  private readonly jobs = new Map<string, YoutubeUploadJob>();
  /** preflight開始〜アップロード完了まで占有するエピソードスロット(`dir/kind/epId`)。
   *  最初のawaitより前に同期予約し、同時startUploadのTOCTOU競合(二重アップロード)を防ぐ */
  private readonly pending = new Set<string>();
  private readonly storePath: string;

  constructor(
    private readonly root: string,
    private readonly apiProvider: () => YoutubeApi | null,
  ) {
    super();
    this.storePath = path.join(this.root, 'factory-ui', 'youtube-uploads.json');
    this.restore();
  }

  /** 起動時にアップロード履歴を復元する。実行中断していたジョブはfailedに落とす */
  private restore(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.storePath, 'utf8');
    } catch {
      return; // ファイル無し(初回起動)。空から開始
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const job of parsed as YoutubeUploadJob[]) {
        if (job.status === 'uploading' || job.status === 'setting_thumbnail') {
          job.status = 'failed';
          job.error = 'サーバー再起動により中断されました';
          if (!job.finishedAt) job.finishedAt = new Date().toISOString();
        }
        this.jobs.set(job.id, job);
      }
    } catch (err) {
      console.error('youtube-uploads.json の読み込みに失敗しました(空から開始):', err);
    }
  }

  /** アップロード履歴を新しい順に上限件数まで書き出す。低頻度な状態遷移でのみ呼ぶ(同期I/O) */
  private persistJobs(): void {
    // 履歴は表示用。書き込み失敗でアップロード本体を止めない
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      const jobs = [...this.jobs.values()]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, MAX_PERSISTED_JOBS);
      fs.writeFileSync(this.storePath, JSON.stringify(jobs, null, 2));
    } catch (e) {
      console.error('youtube-uploads.json 書き込み失敗:', e);
    }
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

  /** 対象フォルダ。kind省略=episode(episodes/ 配下)、'short' は shorts/ 配下 */
  private targetDir(dir: string, id: string, kind: UploadKind = 'episode'): string {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`invalid: 不正なID: ${id}`);
    return path.join(this.channelDir(dir), kind === 'short' ? 'shorts' : 'episodes', id);
  }

  /** out/ 直下のmp4一覧(UIのファイル選択用)。既定候補は final.mp4 */
  async listVideoFiles(dir: string, id: string, kind: UploadKind = 'episode'): Promise<{ file: string; size: number }[]> {
    const outDir = path.join(this.targetDir(dir, id, kind), 'out');
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

  /**
   * YouTube Analytics APIから実測値を取得し episodes/<epId>/analytics.json へ保存する。
   * videoId は publish/upload-result.json から得る(無ければ not_found:)。
   * 既存 analytics.json に manual があれば保持する。スコープ不足(insufficient*)は needs_reauth: へ写す
   * (getChannelTitleのinvalid_grant判定と同じ、raw provider errorをここで契約エラーへ変換する流儀)。
   */
  async fetchAnalytics(dir: string, epId: string): Promise<AnalyticsData> {
    const api = this.api;
    if (!api) throw new Error('no_auth: youtube-client.json が未設置です');
    const token = this.readToken(dir);
    if (!token) throw new Error('no_auth: このチャンネルはYouTube未連携です');
    const epDir = this.targetDir(dir, epId);

    let videoId: string;
    try {
      const raw = await fsp.readFile(path.join(epDir, 'publish', 'upload-result.json'), 'utf8');
      const parsed = JSON.parse(raw) as { videoId?: unknown };
      if (typeof parsed.videoId !== 'string' || parsed.videoId === '') throw new Error('bad videoId');
      videoId = parsed.videoId;
    } catch {
      throw new Error('not_found: まだアップロードされていません');
    }

    const onToken = (t: StoredToken) => void this.saveToken(dir, t).catch(() => {});
    let result: FetchAnalyticsResult;
    try {
      result = await api.fetchAnalytics({ token, onToken, videoId });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      // insufficient*: yt-analytics.readonlyスコープを持たない旧トークン。invalid_grant: getChannelTitleと同じ失効判定
      if (/insufficient/i.test(msg) || msg.includes('invalid_grant')) {
        throw new Error(`needs_reauth: YouTube Analyticsの権限が不足しています(再連携が必要です): ${msg}`);
      }
      throw err;
    }

    const analyticsPath = path.join(epDir, 'analytics.json');
    let manual: AnalyticsData['manual'];
    try {
      const prev = JSON.parse(await fsp.readFile(analyticsPath, 'utf8')) as AnalyticsData;
      manual = prev.manual;
    } catch {
      /* 初回取得。manual無し */
    }

    const m = result.metrics;
    const data: AnalyticsData = {
      videoId,
      fetchedAt: new Date().toISOString(),
      // additionalProperties:false のスキーマ準拠。metricsを盲目にspreadせずキーを明示する
      views: m.views ?? 0,
      estimatedMinutesWatched: m.estimatedMinutesWatched ?? 0,
      averageViewDuration: m.averageViewDuration ?? 0,
      averageViewPercentage: m.averageViewPercentage ?? 0,
      subscribersGained: m.subscribersGained ?? 0,
      likes: m.likes ?? 0,
      comments: m.comments ?? 0,
      retentionCurve: result.retentionCurve,
      ...(manual !== undefined ? { manual } : {}),
    };

    validateAgainstSchema(this.channelDir(dir), 'analytics.schema.json', data);
    await fsp.mkdir(epDir, { recursive: true });
    await fsp.writeFile(analyticsPath, JSON.stringify(data, null, 2) + '\n');
    return data;
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
    kind?: UploadKind;
    force?: boolean;
  }): Promise<YoutubeUploadJob> {
    const { dir, epId, videoFile } = req;
    const kind: UploadKind = req.kind ?? 'episode';
    const epDir = this.targetDir(dir, epId, kind);
    const api = this.api;
    if (!api) throw new Error('no_auth: youtube-client.json が未設置です');
    const token = this.readToken(dir);
    if (!token) throw new Error('no_auth: このチャンネルはYouTube未連携です');

    if (!isSafeRel(videoFile) || !videoFile.startsWith('out/') || !videoFile.endsWith('.mp4')) {
      throw new Error(`invalid: videoFile は out/ 配下のmp4を指定してください: ${videoFile}`);
    }

    // 最初のawaitより前に同期でスロット予約(同時呼び出しのTOCTOU競合防止)。
    // preflight失敗時はここで解放、成功時は runUpload 完了まで占有する。
    // kindを含めるのは、同名IDのエピソードとショートが互いを塞がないようにするため。
    const slot = `${dir}/${kind}/${epId}`;
    if (this.pending.has(slot)) throw new Error('duplicate: このエピソードは既にアップロード中です');
    this.pending.add(slot);
    try {
      return await this.preflightAndStart(req, { epDir, token, slot, api, kind });
    } catch (err) {
      this.pending.delete(slot);
      throw err;
    }
  }

  /** preflight本体(await含む)。成功時はスロットを保持したままジョブを開始する */
  private async preflightAndStart(
    req: { dir: string; epId: string; videoFile: string; kind?: UploadKind; force?: boolean },
    opts: { epDir: string; token: StoredToken; slot: string; api: YoutubeApi; kind: UploadKind },
  ): Promise<YoutubeUploadJob> {
    const { dir, epId, videoFile } = req;
    const { epDir, token, slot, kind } = opts;
    const videoPath = path.join(epDir, videoFile);
    let videoStat;
    try {
      videoStat = await fsp.stat(videoPath);
    } catch (err) {
      // ENOENT以外(EACCES・EMFILE等)を not_found: に写すと一過性エラーが誤404になるためrethrow
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      throw new Error(`not_found: 動画ファイルがありません: ${videoFile}`);
    }

    let rawMeta: string;
    try {
      rawMeta = await fsp.readFile(path.join(epDir, 'publish', 'metadata.json'), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
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
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        throw new Error(`not_found: サムネイルがありません: ${meta.thumbnail}`);
      }
    }

    // 二重アップロード防止: 過去の成功記録 or 実行中ジョブ
    const resultPath = path.join(epDir, 'publish', 'upload-result.json');
    if (!req.force && fs.existsSync(resultPath)) {
      throw new Error('duplicate: upload-result.json が既にあります(force指定で再アップロード可)');
    }
    const active = [...this.jobs.values()].some(
      (j) =>
        j.dir === dir &&
        j.epId === epId &&
        (j.kind ?? 'episode') === kind &&
        (j.status === 'uploading' || j.status === 'setting_thumbnail'),
    );
    if (active) throw new Error('duplicate: このエピソードは既にアップロード中です');

    const job: YoutubeUploadJob = {
      id: randomUUID(),
      dir,
      epId,
      ...(kind === 'short' ? { kind: 'short' as const } : {}),
      videoFile,
      status: 'uploading',
      bytesSent: 0,
      bytesTotal: videoStat.size,
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.persistJobs();
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
        this.persistJobs();
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
    this.persistJobs();
    this.emitUpdate(job);
  }
}

// ---------------------------------------------------------------------------
// アナリティクス還流+thumb-test記録: 純粋なファイル操作(Google API・トークン不要)。
// YoutubeManagerに紐付けない理由: youtube-client.json未設置/未連携でも、Studioから
// 手動転記する運用(manual・thumb-test)は独立して使えて良いため(メインルーターに配線)。
// ---------------------------------------------------------------------------

/** dir が単一パスセグメントか検証する。空・`.`・`..`・セパレータ入りは invalid: throw */
function assertDirSegment(dir: string): void {
  if (dir === '' || dir === '.' || dir === '..' || dir.includes('/') || dir.includes('\\')) {
    throw new Error(`invalid: 不正なチャンネルディレクトリです: ${JSON.stringify(dir)}`);
  }
}

/** epId が YoutubeManager.targetDir と同じ形式か検証する */
function assertEpisodeId(epId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(epId)) {
    throw new Error(`invalid: 不正なepisodeIdです: ${JSON.stringify(epId)}`);
  }
}

/**
 * `<channelDirAbs>/src/schemas/<schemaFile>` でdataをAjv検証する。
 * スキーマ読込失敗・検証失敗はいずれも `invalid:` prefixでthrowする(sendYoutubeError流儀)。
 */
function validateAgainstSchema(channelDirAbs: string, schemaFile: string, data: unknown): void {
  let schema: object;
  try {
    schema = JSON.parse(
      fs.readFileSync(path.join(channelDirAbs, 'src', 'schemas', schemaFile), 'utf8'),
    ) as object;
  } catch (err) {
    throw new Error(
      `invalid: スキーマ(${schemaFile})を読み込めません: ${String(err instanceof Error ? err.message : err)}`,
    );
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    throw new Error(`invalid: ${schemaFile} の検証に失敗しました: ${ajv.errorsText(validate.errors)}`);
  }
}

/** episodes/<epId>/analytics.json を読む。無ければ null。 */
export async function readAnalytics(root: string, dir: string, epId: string): Promise<AnalyticsData | null> {
  assertDirSegment(dir);
  assertEpisodeId(epId);
  try {
    const raw = await fsp.readFile(path.join(root, dir, 'episodes', epId, 'analytics.json'), 'utf8');
    return JSON.parse(raw) as AnalyticsData;
  } catch {
    return null;
  }
}

/**
 * 既存 analytics.json へ manual(impressions/impressionsCtr)をマージ保存する。
 * analytics.json自体が無ければ throw(スキーマのrequired: videoId/fetchedAtを満たせないため)。
 */
export async function saveManualAnalytics(
  root: string,
  dir: string,
  epId: string,
  patch: { impressions?: number; impressionsCtr?: number },
): Promise<AnalyticsData> {
  assertDirSegment(dir);
  assertEpisodeId(epId);
  const analyticsPath = path.join(root, dir, 'episodes', epId, 'analytics.json');
  let existing: AnalyticsData;
  try {
    existing = JSON.parse(await fsp.readFile(analyticsPath, 'utf8')) as AnalyticsData;
  } catch {
    throw new Error('not_found: 先に分析取得してください');
  }
  const merged: AnalyticsData = { ...existing, manual: { ...existing.manual, ...patch } };
  validateAgainstSchema(path.join(root, dir), 'analytics.schema.json', merged);
  await fsp.writeFile(analyticsPath, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

/** episodes/<epId>/publish/thumb-test.json を読む。無ければ null。 */
export async function readThumbTest(root: string, dir: string, epId: string): Promise<ThumbTestData | null> {
  assertDirSegment(dir);
  assertEpisodeId(epId);
  try {
    const raw = await fsp.readFile(
      path.join(root, dir, 'episodes', epId, 'publish', 'thumb-test.json'),
      'utf8',
    );
    return JSON.parse(raw) as ThumbTestData;
  } catch {
    return null;
  }
}

const THUMB_KEYS = new Set(['thumb-1', 'thumb-2', 'thumb-3']);

/**
 * サムネABテスト結果を記録する。recordedAtはサーバーがYYYY-MM-DDで付与する。
 * winner/sharesのキーはthumb-1/2/3のみ受理(それ以外は invalid: throw → APIルートで400)。
 */
export async function saveThumbTest(
  root: string,
  dir: string,
  epId: string,
  body: { winner: string; shares?: Record<string, number>; note?: string },
): Promise<ThumbTestData> {
  assertDirSegment(dir);
  assertEpisodeId(epId);
  if (!THUMB_KEYS.has(body.winner)) {
    throw new Error(`invalid: winner は thumb-1/thumb-2/thumb-3 のいずれかです: ${JSON.stringify(body.winner)}`);
  }
  if (body.shares !== undefined) {
    for (const key of Object.keys(body.shares)) {
      if (!THUMB_KEYS.has(key)) {
        throw new Error(`invalid: shares のキーは thumb-1/thumb-2/thumb-3 のみ受理します: ${key}`);
      }
    }
  }
  const data: ThumbTestData = {
    winner: body.winner as ThumbTestData['winner'],
    // JSTのYYYY-MM-DD(UTCだと日本時間の日付と最大9時間ずれる。運用は日本時間基準のため)
    recordedAt: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }),
    ...(body.shares !== undefined ? { shares: body.shares } : {}),
    ...(body.note !== undefined ? { note: body.note } : {}),
  };
  validateAgainstSchema(path.join(root, dir), 'thumb-test.schema.json', data);
  const publishDirAbs = path.join(root, dir, 'episodes', epId, 'publish');
  await fsp.mkdir(publishDirAbs, { recursive: true });
  await fsp.writeFile(path.join(publishDirAbs, 'thumb-test.json'), JSON.stringify(data, null, 2) + '\n');
  return data;
}
