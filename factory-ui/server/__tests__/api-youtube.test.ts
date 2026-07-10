import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import { createApiRouter } from '../api';
import { YoutubeManager, type YoutubeApi } from '../youtube';

// 既存 api.test.ts と同様に sessions/jobs/renderQueue はダミーで満たす
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

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-api-'));
  fs.mkdirSync(path.join(root, 'ch-a', 'channel'), { recursive: true });
  fs.mkdirSync(path.join(root, 'factory-ui'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'ch-a', '.channel-system.json'),
    JSON.stringify({ projectType: 'channel-video-factory', channelId: 'a', channelName: 'A', status: 'building', systemVersion: '0' }),
  );
  const ep = path.join(root, 'ch-a', 'episodes', 'ep001');
  fs.mkdirSync(path.join(ep, 'out'), { recursive: true });
  fs.mkdirSync(path.join(ep, 'publish'), { recursive: true });
  fs.writeFileSync(path.join(ep, 'out', 'final.mp4'), Buffer.alloc(64));
  fs.writeFileSync(
    path.join(ep, 'publish', 'metadata.json'),
    JSON.stringify({ title: 't', description: 'd', tags: [], categoryId: '24' }),
  );
  return root;
}

const fakeApi: YoutubeApi = {
  generateAuthUrl: (state) => `https://auth.example/?state=${state}`,
  exchangeCode: async () => ({ refresh_token: 'rt' }),
  getChannelTitle: async () => 'ch-title',
  upload: async () => 'vid-1',
  setThumbnail: async () => {},
};

describe('YouTube API ルート', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });

  it('status: 未連携チャンネルは no_token、不在チャンネルは404', async () => {
    const app = makeApp(new YoutubeManager(root, () => fakeApi), root);
    const ok = await request(app).get('/api/youtube/status?channel=ch-a');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ connected: false, reason: 'no_token' });
    expect((await request(app).get('/api/youtube/status?channel=nope')).status).toBe(404);
  });

  it('auth: 200で認可URL、クライアント未設置は503', async () => {
    const app = makeApp(new YoutubeManager(root, () => fakeApi), root);
    const res = await request(app).post('/api/youtube/auth').send({ channel: 'ch-a' });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('state=ch-a');
    const app2 = makeApp(new YoutubeManager(root, () => null), root);
    expect((await request(app2).post('/api/youtube/auth').send({ channel: 'ch-a' })).status).toBe(503);
  });

  it('callback: トークン保存して完了ページ、code欠落は400', async () => {
    const m = new YoutubeManager(root, () => fakeApi);
    const app = makeApp(m, root);
    const res = await request(app).get('/api/youtube/callback?code=c1&state=ch-a');
    expect(res.status).toBe(200);
    expect(res.text).toContain('連携');
    expect(fs.existsSync(path.join(root, 'ch-a', 'channel', 'youtube-oauth.json'))).toBe(true);
    expect((await request(app).get('/api/youtube/callback?state=ch-a')).status).toBe(400);
  });

  it('callback: 不在チャンネルのstateは404', async () => {
    const app = makeApp(new YoutubeManager(root, () => fakeApi), root);
    const res = await request(app).get('/api/youtube/callback?code=c1&state=nope');
    expect(res.status).toBe(404);
    expect(res.type).toBe('text/plain');
  });

  it('videos: out/のmp4一覧', async () => {
    const app = makeApp(new YoutubeManager(root, () => fakeApi), root);
    const res = await request(app).get('/api/youtube/videos?channel=ch-a&ep=ep001');
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([{ file: 'out/final.mp4', size: 64 }]);
  });

  it('upload: 未連携は401、連携後は201でジョブ、重複は409、uploads一覧に出る', async () => {
    const m = new YoutubeManager(root, () => fakeApi);
    const app = makeApp(m, root);
    const body = { channel: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' };
    expect((await request(app).post('/api/youtube/upload').send(body)).status).toBe(401);

    await m.handleCallback('c1', 'ch-a');
    const created = await request(app).post('/api/youtube/upload').send(body);
    expect(created.status).toBe(201);
    expect(created.body.epId).toBe('ep001');

    // 完了を待ってから重複(upload-result.json)を確認
    await new Promise<void>((resolve) => m.on('update', (j) => j.status === 'done' && resolve()));
    expect((await request(app).post('/api/youtube/upload').send(body)).status).toBe(409);

    const list = await request(app).get('/api/youtube/uploads');
    expect(list.body.jobs).toHaveLength(1);
  });

  it('upload: metadata不在は404相当のnot_found、Content-Type必須(415)', async () => {
    const m = new YoutubeManager(root, () => fakeApi);
    await m.handleCallback('c1', 'ch-a');
    const app = makeApp(m, root);
    fs.rmSync(path.join(root, 'ch-a', 'episodes', 'ep001', 'publish', 'metadata.json'));
    const res = await request(app)
      .post('/api/youtube/upload')
      .send({ channel: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' });
    expect(res.status).toBe(404);
    const raw = await request(app)
      .post('/api/youtube/upload')
      .set('Content-Type', 'text/plain')
      .send('x');
    expect(raw.status).toBe(415);
  });

  it('youtube未配線(deps省略)でも既存ルートは壊れない・youtube系は404', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createApiRouter({
        root,
        sessions: { list: () => [] } as never,
        jobs: { list: () => [] } as never,
        renderQueue: { list: () => [] } as never,
      }),
    );
    expect((await request(app).get('/api/youtube/status?channel=ch-a')).status).toBe(404);
  });
});

describe('クライアントJSON設置API', () => {
  const VALID = { installed: { client_id: '123456789012-abc.apps.googleusercontent.com', client_secret: 's' } };
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });

  it('GET: 未設置は configured:false+redirectUri、PUT後はマスク済みclientId', async () => {
    const app = makeApp(new YoutubeManager(root, () => fakeApi), root);
    const before = await request(app).get('/api/youtube/client');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({
      configured: false,
      redirectUri: 'http://127.0.0.1:4700/api/youtube/callback',
    });

    expect((await request(app).put('/api/youtube/client').send(VALID)).status).toBe(204);
    const after = await request(app).get('/api/youtube/client');
    expect(after.body.configured).toBe(true);
    expect(after.body.clientId).toBe('123456789012…');
    expect(JSON.stringify(after.body)).not.toContain('client_secret');
  });

  it('PUT: 不正JSONは400で具体的理由、text/plainは415、ファイルは作られない', async () => {
    const app = makeApp(new YoutubeManager(root, () => fakeApi), root);
    const bad = await request(app).put('/api/youtube/client').send({ installed: { client_id: 'x' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('client_secret');
    expect((await request(app).put('/api/youtube/client').set('Content-Type', 'text/plain').send('x')).status).toBe(415);
    expect((await request(app).get('/api/youtube/client')).body.configured).toBe(false);
  });

  it('DELETE: 設置済みを削除して204、未設置でも204', async () => {
    const app = makeApp(new YoutubeManager(root, () => fakeApi), root);
    await request(app).put('/api/youtube/client').send(VALID);
    expect((await request(app).delete('/api/youtube/client')).status).toBe(204);
    expect((await request(app).get('/api/youtube/client')).body.configured).toBe(false);
    expect((await request(app).delete('/api/youtube/client')).status).toBe(204);
  });

  it('PUT保存後、プロバイダ経由のstatusがno_clientでなくなる(ホットリロード結線)', async () => {
    // 実プロバイダ(loadYoutubeApi)で結線した場合の統合確認
    const { loadYoutubeApi } = await import('../youtube-google');
    const m = new YoutubeManager(root, () => loadYoutubeApi(root, 'http://127.0.0.1:4700/api/youtube/callback'));
    const app = makeApp(m, root);
    expect((await request(app).get('/api/youtube/status?channel=ch-a')).body).toEqual({
      connected: false,
      reason: 'no_client',
    });
    await request(app).put('/api/youtube/client').send(VALID);
    expect((await request(app).get('/api/youtube/status?channel=ch-a')).body).toEqual({
      connected: false,
      reason: 'no_token', // クライアントは認識された(次はチャンネル連携)
    });
  });
});
