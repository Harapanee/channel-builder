import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiRouter } from '../api';
import { JobManager } from '../jobs';
import { RenderQueueManager } from '../render-queue';
import type { SessionManager } from '../sessions';

describe('api shorts', () => {
  let root: string;
  let server: http.Server;
  let url: string;

  function writeShort(shortId: string, status: string): void {
    const d = path.join(root, 'ch1', 'shorts', shortId);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, 'short.json'),
      JSON.stringify({ shortId, formatId: 'f1', sourceEpisodeId: 'ep1', title: 't', status }, null, 2) + '\n',
    );
  }

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fui-api-shorts-')));
    fs.mkdirSync(path.join(root, 'ch1'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'ch1', '.channel-system.json'),
      JSON.stringify({ channelId: 'ch1', channelName: 'ch1', status: 'building', systemVersion: '1', approvedEpisodes: [] }),
    );
    const jobs = new JobManager(root, () => {
      throw new Error('このテストでは spawn しない');
    });
    const renderQueue = new RenderQueueManager(root, {
      spawnFn: () => ({ pid: 1 }),
      gitFn: () => Promise.resolve(),
      killFn: () => {},
      aliveFn: () => true,
      pollMs: 10,
    });
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createApiRouter({ root, sessions: { list: () => [] } as unknown as SessionManager, jobs, renderQueue }),
    );
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const post = (p: string) =>
    fetch(`${url}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  it('GET /channels/:dir に shorts と shortFormats が乗る', async () => {
    writeShort('sh001', 'implemented');
    const res = await fetch(`${url}/api/channels/ch1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shorts: { shortId: string; status: string }[]; shortFormats: unknown[] };
    expect(body.shorts).toHaveLength(1);
    expect(body.shorts[0]!.shortId).toBe('sh001');
    expect(body.shortFormats).toEqual([]);
  });

  it('studio-checked: implemented なら 204 で studio_checked に更新', async () => {
    writeShort('sh001', 'implemented');
    const res = await post('/api/channels/ch1/shorts/sh001/studio-checked');
    expect(res.status).toBe(204);
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'ch1', 'shorts', 'sh001', 'short.json'), 'utf8'));
    expect(meta.status).toBe('studio_checked');
  });

  it('studio-checked: implemented 以外は 409', async () => {
    writeShort('sh001', 'voiced');
    expect((await post('/api/channels/ch1/shorts/sh001/studio-checked')).status).toBe(409);
  });

  it('studio-checked: short 不在は 404、チャンネル不在も 404', async () => {
    expect((await post('/api/channels/ch1/shorts/nope/studio-checked')).status).toBe(404);
    expect((await post('/api/channels/nochan/shorts/sh001/studio-checked')).status).toBe(404);
  });

  it('studio-checked: Content-Type が application/json でなければ 415', async () => {
    writeShort('sh001', 'implemented');
    const res = await fetch(`${url}/api/channels/ch1/shorts/sh001/studio-checked`, { method: 'POST', body: 'x' });
    expect(res.status).toBe(415);
  });
});
