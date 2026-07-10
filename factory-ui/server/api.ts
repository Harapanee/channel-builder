import fsp from 'node:fs/promises';
import path from 'node:path';
import express, { Router, type Request, type Response } from 'express';
import { safeResolve } from './pathguard';
import { scanFactory, readChannel } from './scanner';
import type { SessionManager } from './sessions';
import type { JobManager } from './jobs';
import type { RenderQueueManager } from './render-queue';
import type { StudioManager } from './studio';
import type { YoutubeManager } from './youtube';
import { OPERATIONS } from './operations';
import { approveEpisode, curateLibraryEntry, readBible, writeBible } from './edits';
import { sendMedia, listImages, listVoices, MEDIA_CONTENT_TYPES } from './media';
import { parseBacklog } from './backlog';
import { listSkills } from './skills';
import { getClientStatus, saveClientJson, deleteClientJson } from './youtube-client';

const TEXT_EXTS = new Set(['.md', '.json', '.txt']);
const TEXT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_IMAGE_LIMIT = 60;

/**
 * REST API ルーターファクトリ。index.ts からは
 * `app.use('/api', createApiRouter({ root, sessions }))` で組み込む。
 * エンドポイント契約は計画書のテーブルに準拠(フロントはこれだけに依存する)。
 */
export function createApiRouter(deps: {
  root: string;
  sessions: SessionManager;
  jobs: JobManager;
  renderQueue: RenderQueueManager;
  studio?: StudioManager;
  youtube?: YoutubeManager;
  youtubeRedirectUri?: string;
}): Router {
  const { root, sessions, jobs, renderQueue, studio, youtube, youtubeRedirectUri } = deps;
  const router = express.Router();

  // ---------------------------------------------------------------- factory

  router.get('/factory', async (_req, res) => {
    const channels = await scanFactory(root);
    res.json({ name: path.basename(root), channels });
  });

  // ---------------------------------------------------------------- channels

  router.get('/channels/:dir', async (req, res) => {
    // readChannel が単一セグメント検証+チャンネル実在確認を行う(不正は null)
    const channel = await readChannel(root, req.params.dir);
    if (!channel) {
      res.status(404).json({ error: 'channel not found' });
      return;
    }
    res.json(channel);
  });

  router.get('/channels/:dir/file', async (req, res) => {
    const channelDir = await resolveChannelDir(root, req.params.dir);
    if (!channelDir) {
      res.status(404).json({ error: 'channel not found' });
      return;
    }
    const rel = queryPath(req, res);
    if (rel === null) return;

    if (isForbiddenRel(rel)) {
      res.status(403).json({ error: 'forbidden path' });
      return;
    }
    if (!TEXT_EXTS.has(path.extname(rel).toLowerCase())) {
      res.status(403).json({ error: 'forbidden file type' });
      return;
    }
    // パス解決は必ずチャンネル絶対ディレクトリを root として行う
    const abs = await safeResolve(channelDir, rel);
    if (!abs) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (!stat.isFile()) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (stat.size > TEXT_MAX_BYTES) {
      res.status(403).json({ error: 'file too large' });
      return;
    }
    const content = await fsp.readFile(abs, 'utf8');
    res.type('text/plain').send(content);
  });

  router.get('/channels/:dir/media', async (req, res) => {
    const channelDir = await resolveChannelDir(root, req.params.dir);
    if (!channelDir) {
      res.status(404).json({ error: 'channel not found' });
      return;
    }
    const rel = queryPath(req, res);
    if (rel === null) return;

    if (isForbiddenRel(rel)) {
      res.status(403).json({ error: 'forbidden path' });
      return;
    }
    if (!(path.extname(rel).toLowerCase() in MEDIA_CONTENT_TYPES)) {
      res.status(403).json({ error: 'forbidden media type' });
      return;
    }
    const abs = await safeResolve(channelDir, rel);
    if (!abs) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    await sendMedia(req, res, abs);
  });

  router.get('/channels/:dir/images', async (req, res) => {
    const channelDir = await resolveChannelDir(root, req.params.dir);
    if (!channelDir) {
      res.status(404).json({ error: 'channel not found' });
      return;
    }
    const rawLimit = req.query.limit;
    let limit = DEFAULT_IMAGE_LIMIT;
    if (typeof rawLimit === 'string' && rawLimit !== '') {
      const n = Number(rawLimit);
      if (Number.isFinite(n) && n >= 1) limit = Math.floor(n);
    }
    res.json({ images: await listImages(channelDir, limit) });
  });

  router.get('/channels/:dir/voices', async (req, res) => {
    const channelDir = await resolveChannelDir(root, req.params.dir);
    if (!channelDir) {
      res.status(404).json({ error: 'channel not found' });
      return;
    }
    res.json({ voices: await listVoices(channelDir) });
  });

  router.get('/channels/:dir/backlog', async (req, res) => {
    const channelDir = await resolveChannelDir(root, req.params.dir);
    if (!channelDir) {
      res.status(404).json({ error: 'channel not found' });
      return;
    }
    try {
      const md = await fsp.readFile(path.join(channelDir, 'channel', 'backlog.md'), 'utf8');
      res.json({ candidates: parseBacklog(md) });
    } catch {
      res.json({ candidates: [] }); // ネタ帳未作成は空(エラーにしない)
    }
  });

  router.get('/channels/:dir/skills', async (req, res) => {
    const channelDir = await resolveChannelDir(root, req.params.dir);
    if (!channelDir) {
      res.status(404).json({ error: 'channel not found' });
      return;
    }
    res.json({ skills: await listSkills(channelDir) });
  });

  // ---------------------------------------------------------------- sessions

  router.get('/sessions', (_req, res) => {
    res.json(sessions.list());
  });

  router.post('/sessions', (req, res) => {
    // セッション生成はContent-Type: application/json必須(Originを送らない旧ブラウザの
    // text/plainフォームPOSTでの意図しないセッション生成を防ぐ防御多層化)
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Content-Type must be application/json' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cwd = body.cwd;
    if (cwd !== undefined && typeof cwd !== 'string') {
      res.status(400).json({ error: 'cwd must be a string' });
      return;
    }
    try {
      const info = sessions.create({ cwd: cwd ?? '', continue: body.continue === true });
      res.json(info);
    } catch (err) {
      res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  router.post('/sessions/:id/input', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.text !== 'string') {
      res.status(400).json({ error: 'text must be a string' });
      return;
    }
    const data = body.submit === true ? body.text + '\r' : body.text;
    try {
      sessions.write(req.params.id, data);
    } catch {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.status(204).end();
  });

  router.post('/sessions/:id/kill', (req, res) => {
    try {
      sessions.kill(req.params.id);
    } catch {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.status(204).end();
  });

  router.post('/sessions/:id/restart', (req, res) => {
    try {
      res.json(sessions.restart(req.params.id));
    } catch {
      res.status(404).json({ error: 'session not found' });
    }
  });

  // ---------------------------------------------------------------- operations

  router.get('/operations', (_req, res) => {
    // buildCommand はサーバー内専用(任意コマンド実行口を作らない)。UIにはメタのみ渡す。
    const ops = Object.values(OPERATIONS).map(({ buildCommand, ...meta }) => meta);
    res.json(ops);
  });

  // ---------------------------------------------------------------- jobs

  router.get('/jobs', (_req, res) => {
    res.json(jobs.list());
  });

  router.get('/jobs/:id', (req, res) => {
    const detail = jobs.get(req.params.id);
    if (!detail) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    res.json(detail);
  });

  router.post('/jobs', (req, res) => {
    if (!requireJson(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.dir !== 'string' || typeof body.operation !== 'string') {
      res.status(400).json({ error: 'dir and operation must be strings' });
      return;
    }
    const arg = typeof body.arg === 'string' ? body.arg : '';
    const mode = body.mode;
    if (mode !== undefined && mode !== 'manual' && mode !== 'semi' && mode !== 'auto') {
      res.status(400).json({ error: "mode must be 'manual' | 'semi' | 'auto'" });
      return;
    }
    const durationSec = body.durationSec === undefined ? undefined : Number(body.durationSec);
    if (durationSec !== undefined && !Number.isFinite(durationSec)) {
      res.status(400).json({ error: 'durationSec must be a number' });
      return;
    }
    try {
      // create は不正 operation / dir / model / effort / durationSec を throw する
      const summary = jobs.create({
        dir: body.dir,
        operation: body.operation,
        arg,
        mode,
        model: typeof body.model === 'string' ? body.model : undefined,
        effort: typeof body.effort === 'string' ? body.effort : undefined,
        durationSec,
        episodeId: typeof body.episodeId === 'string' && body.episodeId !== '' ? body.episodeId : undefined,
      });
      res.status(201).json(summary);
    } catch (err) {
      res.status(400).json({ error: errMessage(err) });
    }
  });

  router.post('/jobs/:id/cancel', (req, res) => {
    try {
      jobs.cancel(req.params.id); // 不明idは throw
    } catch {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    res.status(204).end();
  });

  router.post('/jobs/:id/resume', (req, res) => {
    if (!jobs.get(req.params.id)) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    try {
      // resume は「再開不能status / sessionId無し / チャンネル使用中」を throw
      res.json(jobs.resume(req.params.id));
    } catch (err) {
      const msg = errMessage(err);
      // sessionId欠落は「最初からの再試行」へフォールバックさせたいので409で区別する
      res.status(msg.includes('sessionId') ? 409 : 400).json({ error: msg });
    }
  });

  router.post('/jobs/:id/gate', (req, res) => {
    if (!requireJson(req, res)) return;
    // 不明id(404)と不正応答(400)を区別するため、先に存在確認する
    if (!jobs.get(req.params.id)) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.optionId !== 'string' || body.optionId === '') {
      res.status(400).json({ error: 'optionId must be a string' });
      return;
    }
    const feedback = typeof body.feedback === 'string' && body.feedback.trim() !== '' ? body.feedback : undefined;
    if (feedback !== undefined && feedback.length > 4000) {
      res.status(400).json({ error: 'feedback too long (max 4000 chars)' });
      return;
    }
    try {
      // respondGate は「ゲート待ちでない/不正optionId/sessionId無し」を throw
      jobs.respondGate(req.params.id, body.optionId, feedback);
    } catch (err) {
      res.status(400).json({ error: errMessage(err) });
      return;
    }
    // 目視確認が終わったのでStudioの消し忘れを防ぐ(該当チャンネルで稼働中のときだけ)
    const dir = jobs.get(req.params.id)?.dir;
    if (dir !== undefined) studio?.stopIfDir(dir);
    res.status(204).end();
  });

  // ---------------------------------------------------------------- studio

  router.get('/studio', (_req, res) => {
    res.json(studio ? studio.status() : { running: false });
  });

  router.post('/studio/start', async (req, res) => {
    if (!requireJson(req, res)) return;
    if (!studio) {
      res.status(500).json({ error: 'studio manager not configured' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.dir !== 'string' || body.dir === '') {
      res.status(400).json({ error: 'dir must be a string' });
      return;
    }
    // チャンネル実在確認(単一セグメント検証含む)。不正dirでの任意パスspawnを防ぐ
    if (!(await readChannel(root, body.dir))) {
      res.status(404).json({ error: 'channel not found' });
      return;
    }
    const episodeId =
      typeof body.episodeId === 'string' && /^[A-Za-z0-9._-]+$/.test(body.episodeId) ? body.episodeId : undefined;
    try {
      const url = await studio.start(body.dir, episodeId);
      res.json({ url });
    } catch (err) {
      res.status(500).json({ error: errMessage(err) });
    }
  });

  router.post('/studio/stop', (req, res) => {
    if (!requireJson(req, res)) return;
    studio?.stop();
    res.status(204).end();
  });

  // ---------------------------------------------------------- render-queue

  router.get('/render-queue', (_req, res) => {
    res.json({ items: renderQueue.list() });
  });

  router.post('/render-queue/start', (req, res) => {
    if (!requireJson(req, res)) return;
    try {
      renderQueue.start(); // busy/empty は throw(409)
    } catch (err) {
      sendRenderQueueError(res, err);
      return;
    }
    res.status(204).end();
  });

  router.post('/render-queue/enqueue', (req, res) => {
    if (!requireJson(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.dir !== 'string' || typeof body.epId !== 'string' || body.epId === '') {
      res.status(400).json({ error: 'dir and epId must be strings' });
      return;
    }
    try {
      // 手動登録は render_ready 以降のみ(承認前のレンダー突入を防ぐ)
      const item = renderQueue.enqueue(body.dir, body.epId, { requireReady: true });
      res.status(201).json(item);
    } catch (err) {
      sendRenderQueueError(res, err);
    }
  });

  router.post('/render-queue/:id/cancel', (req, res) => {
    if (!requireJson(req, res)) return;
    try {
      renderQueue.cancel(req.params.id); // unknown/invalid は throw
    } catch (err) {
      sendRenderQueueError(res, err);
      return;
    }
    res.status(204).end();
  });

  // ---------------------------------------------------- channels(直接編集)

  router.post('/channels/:dir/episodes/:episodeId/approve', async (req, res) => {
    if (!requireJson(req, res)) return;
    const channelDir = await resolveChannelDir(root, req.params.dir);
    if (!channelDir) {
      res.status(404).json({ error: 'channel not found' });
      return;
    }
    try {
      await approveEpisode(root, req.params.dir, req.params.episodeId);
    } catch (err) {
      res.status(400).json({ error: errMessage(err) });
      return;
    }
    res.status(204).end();
  });

  router.post('/channels/:dir/library/:entryId/curate', async (req, res) => {
    if (!requireJson(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.decision !== 'approve' && body.decision !== 'reject') {
      res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
      return;
    }
    try {
      // curateLibraryEntry は 不正dir/不明entry/不正decision を throw(契約上いずれも400)
      await curateLibraryEntry(root, req.params.dir, req.params.entryId, body.decision);
    } catch (err) {
      res.status(400).json({ error: errMessage(err) });
      return;
    }
    res.status(204).end();
  });

  router.get('/channels/:dir/bible', async (req, res) => {
    const channelDir = await resolveChannelDir(root, req.params.dir);
    if (!channelDir) {
      res.status(404).json({ error: 'channel not found' });
      return;
    }
    try {
      const content = await readBible(root, req.params.dir);
      res.json({ content });
    } catch {
      // チャンネルは在るが channel/bible.md が未作成 等
      res.status(404).json({ error: 'bible not found' });
    }
  });

  router.put('/channels/:dir/bible', async (req, res) => {
    if (!requireJson(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.content !== 'string') {
      res.status(400).json({ error: 'content must be a string' });
      return;
    }
    try {
      // writeBible は 不正dir/空内容/巨大入力 を throw(契約上いずれも400)
      await writeBible(root, req.params.dir, body.content);
    } catch (err) {
      res.status(400).json({ error: errMessage(err) });
      return;
    }
    res.status(204).end();
  });

  // ---------------------------------------------------------------- youtube

  // channelクエリを検証して返す(不在は404を送ってnull)
  const resolveYtChannel = async (req: Request, res: Response): Promise<string | null> => {
    const channel = req.query.channel ?? (req.body as Record<string, unknown> | undefined)?.channel;
    if (typeof channel !== 'string' || !(await resolveChannelDir(root, channel))) {
      res.status(404).json({ error: 'channel not found' });
      return null;
    }
    return channel;
  };

  if (youtube) {
    const yt = youtube;

    // クライアントJSON(factory-ui/youtube-client.json)のUI設置。
    // GETは設定タブの状態表示用 — client_secret は絶対に返さない
    router.get('/youtube/client', (_req, res) => {
      res.json({
        ...getClientStatus(root),
        redirectUri: youtubeRedirectUri ?? '',
      });
    });

    router.put('/youtube/client', async (req, res) => {
      if (!requireJson(req, res)) return;
      try {
        await saveClientJson(root, req.body);
      } catch (err) {
        res.status(400).json({ error: errMessage(err) });
        return;
      }
      res.status(204).end();
    });

    router.delete('/youtube/client', async (_req, res) => {
      await deleteClientJson(root);
      res.status(204).end();
    });

    router.get('/youtube/status', async (req, res) => {
      const channel = await resolveYtChannel(req, res);
      if (channel === null) return;
      try {
        res.json(await yt.status(channel));
      } catch (err) {
        res.status(500).json({ error: errMessage(err) });
      }
    });

    router.post('/youtube/auth', async (req, res) => {
      if (!requireJson(req, res)) return;
      const channel = await resolveYtChannel(req, res);
      if (channel === null) return;
      try {
        res.json({ url: yt.authUrl(channel) });
      } catch (err) {
        sendYoutubeError(res, err);
      }
    });

    router.get('/youtube/callback', async (req, res) => {
      const { code, state } = req.query;
      if (typeof code !== 'string' || typeof state !== 'string' || code === '' || state === '') {
        res.status(400).type('text/plain').send('code / state がありません');
        return;
      }
      if (!(await resolveChannelDir(root, state))) {
        res.status(404).type('text/plain').send('channel not found');
        return;
      }
      try {
        await yt.handleCallback(code, state);
      } catch (err) {
        res.status(400).type('text/plain').send(`連携に失敗しました: ${errMessage(err)}`);
        return;
      }
      // ブラウザの認可リダイレクト着地点。UIには戻さずタブを閉じてもらう
      res.type('html').send('<meta charset="utf-8"><p>YouTube連携が完了しました。このタブは閉じてください。</p>');
    });

    router.get('/youtube/videos', async (req, res) => {
      const channel = await resolveYtChannel(req, res);
      if (channel === null) return;
      const ep = req.query.ep;
      if (typeof ep !== 'string' || ep === '') {
        res.status(400).json({ error: 'ep query is required' });
        return;
      }
      try {
        res.json({ files: await yt.listVideoFiles(channel, ep) });
      } catch (err) {
        sendYoutubeError(res, err);
      }
    });

    router.post('/youtube/upload', async (req, res) => {
      if (!requireJson(req, res)) return;
      const channel = await resolveYtChannel(req, res);
      if (channel === null) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.epId !== 'string' || typeof body.videoFile !== 'string') {
        res.status(400).json({ error: 'epId and videoFile must be strings' });
        return;
      }
      try {
        const job = await yt.startUpload({
          dir: channel,
          epId: body.epId,
          videoFile: body.videoFile,
          force: body.force === true,
        });
        res.status(201).json(job);
      } catch (err) {
        sendYoutubeError(res, err);
      }
    });

    router.get('/youtube/uploads', (_req, res) => {
      res.json({ jobs: yt.list() });
    });
  }

  return router;
}

// -------------------------------------------------------------------- 内部

/**
 * `:dir` を検証してチャンネルの絶対ディレクトリを返す。
 * デコード後に `/`(および `\`)を含まないこと+scan結果に存在することを確認。
 * 不正・不在は null(呼び出し側で 404)。
 */
async function resolveChannelDir(root: string, dir: string): Promise<string | null> {
  if (dir === '' || dir === '.' || dir === '..') return null;
  if (dir.includes('/') || dir.includes('\\')) return null;
  const channels = await scanFactory(root);
  if (!channels.some((c) => c.dir === dir)) return null;
  return path.join(root, dir);
}

/**
 * Content-Type が application/json でなければ 415 を送って false を返す。
 * 非対話フォームからの意図しないPOST/PUT(text/plain)を弾く防御多層化(既存POST /sessions と同方針)。
 */
function requireJson(req: Request, res: Response): boolean {
  if (!req.is('application/json')) {
    res.status(415).json({ error: 'Content-Type must be application/json' });
    return false;
  }
  return true;
}

/** Error から表示用メッセージを取り出す。 */
function errMessage(err: unknown): string {
  return String(err instanceof Error ? err.message : err);
}

/**
 * RenderQueueManager の throw メッセージ(先頭トークン)を HTTP コードへ写す。
 * duplicate/not_ready/busy/empty → 409、unknown → 404、その他(invalid等)→ 400。
 */
function sendRenderQueueError(res: Response, err: unknown): void {
  const msg = errMessage(err);
  if (msg.startsWith('unknown:')) {
    res.status(404).json({ error: msg });
    return;
  }
  if (/^(duplicate|not_ready|busy|empty):/.test(msg)) {
    res.status(409).json({ error: msg });
    return;
  }
  res.status(400).json({ error: msg });
}

/**
 * YoutubeManager の throw メッセージ(先頭トークン)を HTTP コードへ写す。
 * duplicate → 409、not_found → 404、no_auth → 認可の問題(auth未設置は503/未連携は401)、他 → 400。
 */
function sendYoutubeError(res: Response, err: unknown): void {
  const msg = errMessage(err);
  if (msg.startsWith('duplicate:')) {
    res.status(409).json({ error: msg });
    return;
  }
  if (msg.startsWith('not_found:')) {
    res.status(404).json({ error: msg });
    return;
  }
  if (msg.startsWith('no_auth:')) {
    res.status(msg.includes('youtube-client.json') ? 503 : 401).json({ error: msg });
    return;
  }
  res.status(400).json({ error: msg });
}

/** `path` クエリを取り出す。欠落・非文字列なら 400 を送って null を返す。 */
function queryPath(req: Request, res: Response): string | null {
  const rel = req.query.path;
  if (typeof rel !== 'string' || rel === '') {
    res.status(400).json({ error: 'path query is required' });
    return null;
  }
  return rel;
}

/**
 * safeResolve に渡す前の字句チェック。該当は 403 で拒否する
 * (safeResolve は「禁止」と「不在」を区別しないため、契約上の 403 をここで確定する)。
 *  - 絶対パス・`..` セグメント(トラバーサル)
 *  - `.git` / `node_modules` セグメント
 *  - `.env*` ファイル名
 */
function isForbiddenRel(rel: string): boolean {
  if (path.isAbsolute(rel) || rel.startsWith('\\')) return true;
  const segments = rel.split(/[\\/]+/).filter((s) => s !== '');
  for (const seg of segments) {
    if (seg === '..') return true;
    const lower = seg.toLowerCase();
    if (lower === '.git' || lower === 'node_modules') return true;
  }
  const base = segments.at(-1)?.toLowerCase() ?? '';
  return base.startsWith('.env');
}
