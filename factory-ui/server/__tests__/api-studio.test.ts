import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApiRouter } from '../api';
import { JobManager, type SpawnClaude } from '../jobs';
import { RenderQueueManager } from '../render-queue';
import { StudioManager } from '../studio';
import type { SessionManager } from '../sessions';

class FakeProc {
  stdout = new Readable({ read() {} });
  private cbs: ((c: number) => void)[] = [];
  onExit(cb: (c: number) => void) {
    this.cbs.push(cb);
  }
  kill() {
    this.cbs.forEach((cb) => cb(143));
  }
  push(line: string) {
    this.stdout.push(line + '\n');
  }
}

describe('api routes (studio)', () => {
  let root: string;
  let jobs: JobManager;
  let studio: StudioManager;
  let studioSpawns: string[];
  let killed: number;
  let procs: FakeProc[];
  let server: http.Server;
  let url: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-studio-'));
    fs.mkdirSync(path.join(root, 'ch1'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'ch1', '.channel-system.json'),
      JSON.stringify({ channelId: 'ch1', channelName: 'ch1', status: 'building', systemVersion: '1', approvedEpisodes: [] }),
    );
    procs = [];
    const spawnFn: SpawnClaude = () => {
      const p = new FakeProc();
      procs.push(p);
      return { stdout: p.stdout, onExit: (cb) => p.onExit(cb), kill: () => p.kill() };
    };
    jobs = new JobManager(root, spawnFn);
    studioSpawns = [];
    killed = 0;
    studio = new StudioManager(root, {
      spawnFn: (cwd) => {
        studioSpawns.push(cwd);
        return {
          kill: () => {
            killed++;
          },
          onExit: () => {},
        };
      },
      probe: async () => true,
      probeIntervalMs: 1,
      probeTimeoutMs: 100,
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
      createApiRouter({ root, sessions: { list: () => [] } as unknown as SessionManager, jobs, renderQueue, studio }),
    );
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(() => server.close());

  const post = (p: string, body: unknown) =>
    fetch(`${url}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('start はチャンネルフォルダでspawnしてURLを返し、statusに反映される', async () => {
    const res = await post('/api/studio/start', { dir: 'ch1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain('4710');
    expect(studioSpawns).toEqual([path.join(root, 'ch1')]);
    const st = (await (await fetch(`${url}/api/studio`)).json()) as { running: boolean; dir?: string };
    expect(st).toMatchObject({ running: true, dir: 'ch1', status: 'ready' });
  });

  it('未知チャンネルは404、dir欠落は400', async () => {
    expect((await post('/api/studio/start', { dir: 'nope' })).status).toBe(404);
    expect((await post('/api/studio/start', {})).status).toBe(400);
  });

  it('stop で停止し status が running:false になる', async () => {
    await post('/api/studio/start', { dir: 'ch1' });
    expect((await post('/api/studio/stop', {})).status).toBe(204);
    expect(killed).toBe(1);
    const st = (await (await fetch(`${url}/api/studio`)).json()) as { running: boolean };
    expect(st.running).toBe(false);
  });

  it('ゲート応答すると同一チャンネルのstudioが自動停止する', async () => {
    // ジョブ作成 → init(sessionId)とゲートを流して awaiting_gate にする
    const created = await post('/api/jobs', { dir: 'ch1', operation: 'video-create', arg: 'x' });
    const j = (await created.json()) as { id: string };
    procs[0].push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess1' }));
    procs[0].push(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: '<gate>{"gateId":"g1","kind":"render-check","question":"q","options":[{"id":"approve","label":"承認"},{"id":"revise","label":"修正"}]}</gate>',
            },
          ],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    await post('/api/studio/start', { dir: 'ch1' });
    const res = await post(`/api/jobs/${j.id}/gate`, { optionId: 'approve' });
    expect(res.status).toBe(204);
    expect(killed).toBe(1);
  });
});
