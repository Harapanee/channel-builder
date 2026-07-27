import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { createApiRouter } from '../api';
import { YoutubeManager, type YoutubeApi } from '../youtube';

// アナリティクス還流+thumb-test記録(Phase 3 Task 7)のREDテスト。
// 実スキーマ(人物転生/src/schemas/*.json)を一時rootへコピーして使う(Ajv検証の実効性を担保)。

const here = path.dirname(fileURLToPath(import.meta.url));
const youtubeRoot = path.resolve(here, '..', '..', '..'); // .../youtube
const REAL_SCHEMAS_DIR = path.join(youtubeRoot, '人物転生', 'src', 'schemas');

function makeApp(youtube: YoutubeManager, root: string) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createApiRouter({
      root,
      sessions: { list: () => [] } as never,
      jobs: { list: () => [] } as never,
      renderQueue: { list: () => [] } as never,
      youtube,
      youtubeRedirectUri: 'http://127.0.0.1:4700/api/youtube/callback',
    }),
  );
  return app;
}

/** ch-a チャンネル+ep001エピソードを持つ一時rootを作る。スキーマも実物からコピーする。 */
function makeRoot(opts: { withUploadResult?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-analytics-'));
  const channelDir = path.join(root, 'ch-a');
  fs.mkdirSync(path.join(channelDir, 'channel'), { recursive: true });
  fs.mkdirSync(path.join(root, 'factory-ui'), { recursive: true });
  fs.writeFileSync(
    path.join(channelDir, '.channel-system.json'),
    JSON.stringify({ projectType: 'channel-video-factory', channelId: 'a', channelName: 'A', status: 'building', systemVersion: '0' }),
  );

  const schemasDir = path.join(channelDir, 'src', 'schemas');
  fs.mkdirSync(schemasDir, { recursive: true });
  fs.copyFileSync(
    path.join(REAL_SCHEMAS_DIR, 'analytics.schema.json'),
    path.join(schemasDir, 'analytics.schema.json'),
  );
  fs.copyFileSync(
    path.join(REAL_SCHEMAS_DIR, 'thumb-test.schema.json'),
    path.join(schemasDir, 'thumb-test.schema.json'),
  );

  const epDir = path.join(channelDir, 'episodes', 'ep001');
  fs.mkdirSync(path.join(epDir, 'publish'), { recursive: true });
  if (opts.withUploadResult ?? true) {
    fs.writeFileSync(
      path.join(epDir, 'publish', 'upload-result.json'),
      JSON.stringify({ videoId: 'vid-1', url: 'https://www.youtube.com/watch?v=vid-1' }),
    );
  }
  return root;
}

const fakeApi: YoutubeApi = {
  generateAuthUrl: (state) => `https://auth.example/?state=${state}`,
  exchangeCode: async () => ({ refresh_token: 'rt' }),
  getChannelTitle: async () => 'ch-title',
  upload: async () => 'vid-1',
  setThumbnail: async () => {},
  fetchAnalytics: async () => ({
    metrics: {
      views: 1000,
      estimatedMinutesWatched: 500,
      averageViewDuration: 30,
      averageViewPercentage: 55.5,
      subscribersGained: 12,
      likes: 40,
      comments: 3,
    },
    retentionCurve: [
      { elapsedRatio: 0, watchRatio: 1 },
      { elapsedRatio: 0.12, watchRatio: 0.84 },
      { elapsedRatio: 0.17, watchRatio: 0.61 },
      { elapsedRatio: 1, watchRatio: 0.2 },
    ],
  }),
};

describe('アナリティクス取得 POST /api/youtube/analytics/fetch', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });

  it('成功: 200でanalyticsを返し、ファイルがスキーマ適合の内容で生成される', async () => {
    const m = new YoutubeManager(root, () => fakeApi);
    await m.handleCallback('code-1', 'ch-a');
    const app = makeApp(m, root);

    const res = await request(app)
      .post('/api/youtube/analytics/fetch')
      .send({ channel: 'ch-a', epId: 'ep001' });
    expect(res.status).toBe(200);
    expect(res.body.videoId).toBe('vid-1');
    expect(res.body.views).toBe(1000);
    expect(res.body.retentionCurve).toHaveLength(4);

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(root, 'ch-a', 'episodes', 'ep001', 'analytics.json'), 'utf8'),
    );
    expect(onDisk.videoId).toBe('vid-1');
    expect(onDisk.fetchedAt).toBeTypeOf('string');
    expect(onDisk.views).toBe(1000);
    // スキーマは additionalProperties:false。余計なキーが無いことを軽く確認
    expect(Object.keys(onDisk).every((k) =>
      ['videoId', 'fetchedAt', 'views', 'estimatedMinutesWatched', 'averageViewDuration',
       'averageViewPercentage', 'subscribersGained', 'likes', 'comments', 'retentionCurve', 'manual']
        .includes(k)
    )).toBe(true);
  });

  it('再取得時、既存analytics.jsonのmanualを保持する', async () => {
    const m = new YoutubeManager(root, () => fakeApi);
    await m.handleCallback('code-1', 'ch-a');
    const app = makeApp(m, root);

    await request(app).post('/api/youtube/analytics/fetch').send({ channel: 'ch-a', epId: 'ep001' });
    const putRes = await request(app)
      .put('/api/channels/ch-a/episodes/ep001/analytics/manual')
      .send({ impressions: 5000, impressionsCtr: 4.2 });
    expect(putRes.status).toBe(204);

    const res2 = await request(app)
      .post('/api/youtube/analytics/fetch')
      .send({ channel: 'ch-a', epId: 'ep001' });
    expect(res2.status).toBe(200);
    expect(res2.body.manual).toEqual({ impressions: 5000, impressionsCtr: 4.2 });
  });

  it('upload-result.json 無しは404 not_found', async () => {
    root = makeRoot({ withUploadResult: false });
    const m = new YoutubeManager(root, () => fakeApi);
    await m.handleCallback('code-1', 'ch-a');
    const app = makeApp(m, root);

    const res = await request(app)
      .post('/api/youtube/analytics/fetch')
      .send({ channel: 'ch-a', epId: 'ep001' });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not_found');
  });

  it('スコープ不足(insufficient)は401 needs_reauth', async () => {
    const scopeShortApi: YoutubeApi = {
      ...fakeApi,
      fetchAnalytics: async () => {
        throw new Error('insufficientPermissions: Request had insufficient authentication scopes.');
      },
    };
    const m = new YoutubeManager(root, () => scopeShortApi);
    await m.handleCallback('code-1', 'ch-a');
    const app = makeApp(m, root);

    const res = await request(app)
      .post('/api/youtube/analytics/fetch')
      .send({ channel: 'ch-a', epId: 'ep001' });
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('needs_reauth');
    // ドメイン401にはWWW-Authenticateを付けない(factory-ui認証の401=全画面ログアウトとの区別。
    // フロントのhandleUnauthorizedはこのヘッダが無い401でclearTokenしない)
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it('未連携は401', async () => {
    const m = new YoutubeManager(root, () => fakeApi);
    const app = makeApp(m, root);
    const res = await request(app)
      .post('/api/youtube/analytics/fetch')
      .send({ channel: 'ch-a', epId: 'ep001' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/channels/:dir/episodes/:epId/analytics', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });

  it('未取得は404', async () => {
    const app = makeApp(new YoutubeManager(root, () => fakeApi), root);
    const res = await request(app).get('/api/channels/ch-a/episodes/ep001/analytics');
    expect(res.status).toBe(404);
  });

  it('取得済みはファイル内容を返す', async () => {
    const m = new YoutubeManager(root, () => fakeApi);
    await m.handleCallback('code-1', 'ch-a');
    const app = makeApp(m, root);
    await request(app).post('/api/youtube/analytics/fetch').send({ channel: 'ch-a', epId: 'ep001' });
    const res = await request(app).get('/api/channels/ch-a/episodes/ep001/analytics');
    expect(res.status).toBe(200);
    expect(res.body.videoId).toBe('vid-1');
  });
});

describe('PUT /api/channels/:dir/episodes/:epId/analytics/manual', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });

  it('analytics.json が無ければ404', async () => {
    const app = makeApp(new YoutubeManager(root, () => fakeApi), root);
    const res = await request(app)
      .put('/api/channels/ch-a/episodes/ep001/analytics/manual')
      .send({ impressions: 100 });
    expect(res.status).toBe(404);
  });

  it('マージして保存(204)。既存の他フィールドは保全される', async () => {
    const m = new YoutubeManager(root, () => fakeApi);
    await m.handleCallback('code-1', 'ch-a');
    const app = makeApp(m, root);
    await request(app).post('/api/youtube/analytics/fetch').send({ channel: 'ch-a', epId: 'ep001' });

    const res = await request(app)
      .put('/api/channels/ch-a/episodes/ep001/analytics/manual')
      .send({ impressions: 5000 });
    expect(res.status).toBe(204);

    const res2 = await request(app)
      .put('/api/channels/ch-a/episodes/ep001/analytics/manual')
      .send({ impressionsCtr: 3.3 });
    expect(res2.status).toBe(204);

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(root, 'ch-a', 'episodes', 'ep001', 'analytics.json'), 'utf8'),
    );
    expect(onDisk.manual).toEqual({ impressions: 5000, impressionsCtr: 3.3 });
    expect(onDisk.views).toBe(1000); // 既存フィールドは保全
  });
});

describe('サムネAB結果 thumb-test', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });

  it('GET: 未記録は404', async () => {
    const app = makeApp(new YoutubeManager(root, () => fakeApi), root);
    const res = await request(app).get('/api/channels/ch-a/episodes/ep001/thumb-test');
    expect(res.status).toBe(404);
  });

  it('PUT: 正常に保存され(204)、recordedAtがYYYY-MM-DD形式で付与される', async () => {
    const app = makeApp(new YoutubeManager(root, () => fakeApi), root);
    const res = await request(app)
      .put('/api/channels/ch-a/episodes/ep001/thumb-test')
      .send({ winner: 'thumb-2', shares: { 'thumb-1': 30, 'thumb-2': 70 }, note: 'サムネ2が強かった' });
    expect(res.status).toBe(204);

    const getRes = await request(app).get('/api/channels/ch-a/episodes/ep001/thumb-test');
    expect(getRes.status).toBe(200);
    expect(getRes.body.winner).toBe('thumb-2');
    expect(getRes.body.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // UTC日付ではなくJST(Asia/Tokyo)基準の日付であること(UTC-JSTの日跨ぎ時間帯でも運用は日本時間基準)
    expect(getRes.body.recordedAt).toBe(new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }));
    expect(getRes.body.note).toBe('サムネ2が強かった');
  });

  it('PUT: winner不正は400', async () => {
    const app = makeApp(new YoutubeManager(root, () => fakeApi), root);
    const res = await request(app)
      .put('/api/channels/ch-a/episodes/ep001/thumb-test')
      .send({ winner: 'thumb-9' });
    expect(res.status).toBe(400);
  });

  it('PUT: sharesの不正キーは400', async () => {
    const app = makeApp(new YoutubeManager(root, () => fakeApi), root);
    const res = await request(app)
      .put('/api/channels/ch-a/episodes/ep001/thumb-test')
      .send({ winner: 'thumb-1', shares: { 'thumb-1': 100, other: 0 } });
    expect(res.status).toBe(400);
  });
});
