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
import type { SessionManager } from '../sessions';

// FakeSpawn(jobs.test.tsと同型・最小)
class FakeProc {
  stdout = new Readable({ read() {} });
  private cbs: ((c: number) => void)[] = [];
  args: string[];
  constructor(args: string[]) {
    this.args = args;
  }
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

describe('api routes (wave2)', () => {
  let root: string;
  let procs: FakeProc[];
  let jobs: JobManager;
  let renderQueue: RenderQueueManager;
  let renderSpawns: string[][];
  let server: http.Server;
  let url: string;

  function writeApiEpisode(epId: string, status: string): void {
    const d = path.join(root, 'ch1', 'episodes', epId);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'episode.json'), JSON.stringify({ episodeId: epId, subject: epId, status }));
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-api-'));
    fs.mkdirSync(path.join(root, 'ch1', 'channel'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'ch1', '.channel-system.json'),
      JSON.stringify({ channelId: 'ch1', channelName: 'ch1', status: 'building', systemVersion: '1', approvedEpisodes: [] }),
    );
    fs.writeFileSync(
      path.join(root, 'ch1', 'channel', 'backlog.md'),
      '| 順位 | 題材 | 計 | 状態 |\n|---|---|---|---|\n| 1 | マンボウ | 37 | 候補 |\n',
    );
    const sk = path.join(root, 'ch1', '.claude', 'skills', 'video-create');
    fs.mkdirSync(sk, { recursive: true });
    fs.writeFileSync(path.join(sk, 'SKILL.md'), '---\ndescription: 動画を作る。詳細。\n---\n');
    procs = [];
    const spawnFn: SpawnClaude = (args) => {
      const p = new FakeProc(args);
      procs.push(p);
      return { stdout: p.stdout, onExit: (cb) => p.onExit(cb), kill: () => p.kill() };
    };
    jobs = new JobManager(root, spawnFn);
    renderSpawns = [];
    renderQueue = new RenderQueueManager(root, {
      spawnFn: (cmd, args) => {
        renderSpawns.push([cmd, ...args]);
        return { pid: 4242 };
      },
      gitFn: () => Promise.resolve(),
      killFn: () => {},
      aliveFn: () => true,
      pollMs: 10,
    });
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter({ root, sessions: { list: () => [] } as unknown as SessionManager, jobs, renderQueue }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(() => server.close());

  const post = (p: string, body: unknown) =>
    fetch(`${url}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('POST /jobs は mode/model/effort/durationSec を受理し、不正modelは400', async () => {
    const ok = await post('/api/jobs', {
      dir: 'ch1', operation: 'video-create', arg: '', mode: 'semi', model: 'sonnet', effort: 'high', durationSec: 180,
    });
    expect(ok.status).toBe(201);
    const j = (await ok.json()) as { model: string; mode: string };
    expect(j.model).toBe('sonnet');
    expect(j.mode).toBe('semi');
    const bad = await post('/api/jobs', { dir: 'ch1', operation: 'ask', arg: 'q', model: 'gpt-5' });
    expect(bad.status).toBe(400);
  });

  it('POST /jobs/:id/resume: 未知id=404 / sessionId無し=409', async () => {
    const res = await post('/api/jobs', { dir: 'ch1', operation: 'theme-scout' });
    const j = (await res.json()) as { id: string };
    await post(`/api/jobs/${j.id}/cancel`, {});
    const r = await post(`/api/jobs/${j.id}/resume`, {});
    expect(r.status).toBe(409); // initを流していないのでsessionId無し
    const r2 = await post('/api/jobs/nope/resume', {});
    expect(r2.status).toBe(404);
  });

  it('GET /channels/:dir/backlog は候補一覧、無いチャンネルは404', async () => {
    const r = await fetch(`${url}/api/channels/ch1/backlog`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ candidates: [{ rank: 1, subject: 'マンボウ', score: 37 }] });
    expect((await fetch(`${url}/api/channels/nope/backlog`)).status).toBe(404);
  });

  it('GET /channels/:dir/skills はスキルヒント一覧', async () => {
    const r = await fetch(`${url}/api/channels/ch1/skills`);
    expect(await r.json()).toEqual({ skills: [{ name: 'video-create', description: '動画を作る。' }] });
  });

  it('POST /jobs/:id/gate は feedback を受理し、--resume再spawnに渡す', async () => {
    const res = await post('/api/jobs', { dir: 'ch1', operation: 'video-create', arg: 'x' });
    const j = (await res.json()) as { id: string };
    procs[0]!.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', cwd: path.join(root, 'ch1') }));
    procs[0]!.push(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '<gate>{"gateId":"g1","question":"?","options":[{"id":"yes","label":"承認","description":""}],"context":""}</gate>' }] },
      }),
    );
    await new Promise((r2) => setTimeout(r2, 50));
    const r = await post(`/api/jobs/${j.id}/gate`, { optionId: 'yes', feedback: '修正して' });
    expect(r.status).toBe(204);
    // HTTP配線検証: gate応答後、FakeSpawnの procs[1](--resume再spawn)が生成されることをassert
    await new Promise((r2) => setTimeout(r2, 50));
    expect(procs.length).toBe(2);
    expect(procs[1]!.args.join(' ')).toContain('修正して');
  });

  it('POST /jobs/:id/gate は feedback 4000字上限を検証する', async () => {
    const res = await post('/api/jobs', { dir: 'ch1', operation: 'video-create', arg: 'x' });
    const j = (await res.json()) as { id: string };
    procs[0]!.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', cwd: path.join(root, 'ch1') }));
    procs[0]!.push(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '<gate>{"gateId":"g1","question":"?","options":[{"id":"yes","label":"承認","description":""}],"context":""}</gate>' }] },
      }),
    );
    await new Promise((r2) => setTimeout(r2, 50));
    // 4001字: 400を返す(ゲートを消費しない)
    const r1 = await post(`/api/jobs/${j.id}/gate`, { optionId: 'yes', feedback: 'あ'.repeat(4001) });
    expect(r1.status).toBe(400);
    // 同じゲートへ4000字ちょうど: 204を返す
    const r2 = await post(`/api/jobs/${j.id}/gate`, { optionId: 'yes', feedback: 'あ'.repeat(4000) });
    expect(r2.status).toBe(204);
  });

  // ---- 夜間レンダーキュー ----

  it('render-queue: enqueueは201で一覧に載る。重複/render_ready未満は409、未知は404、不正ボディは400', async () => {
    writeApiEpisode('ep001-a', 'render_ready');
    writeApiEpisode('ep003-packaged', 'packaged');
    const ok = await post('/api/render-queue/enqueue', { dir: 'ch1', epId: 'ep001-a' });
    expect(ok.status).toBe(201);
    const item = (await ok.json()) as { id: string; status: string };
    expect(item.status).toBe('waiting');
    const list = (await (await fetch(`${url}/api/render-queue`)).json()) as { items: Array<{ epId: string }> };
    expect(list.items.map((i) => i.epId)).toEqual(['ep001-a']);
    expect((await post('/api/render-queue/enqueue', { dir: 'ch1', epId: 'ep001-a' })).status).toBe(409);
    expect((await post('/api/render-queue/enqueue', { dir: 'ch1', epId: 'ep003-packaged' })).status).toBe(409);
    expect((await post('/api/render-queue/enqueue', { dir: 'nope', epId: 'ep001-a' })).status).toBe(404);
    expect((await post('/api/render-queue/enqueue', { dir: 'ch1', epId: 'ep999-none' })).status).toBe(404);
    expect((await post('/api/render-queue/enqueue', { dir: 'ch1' })).status).toBe(400);
  });

  it('render-queue: startは204(空/実行中は409)、cancelは204(未知は404)。startでrender-episode.shがspawnされる', async () => {
    expect((await post('/api/render-queue/start', {})).status).toBe(409); // empty
    writeApiEpisode('ep001-a', 'render_ready');
    const created = await post('/api/render-queue/enqueue', { dir: 'ch1', epId: 'ep001-a' });
    const item = (await created.json()) as { id: string };
    expect((await post('/api/render-queue/start', {})).status).toBe(204);
    expect((await post('/api/render-queue/start', {})).status).toBe(409); // busy
    await new Promise((r) => setTimeout(r, 30));
    expect(renderSpawns[0]).toEqual(['bash', 'scripts/render-episode.sh', 'episodes/ep001-a', 'final']);
    expect((await post(`/api/render-queue/${item.id}/cancel`, {})).status).toBe(204);
    expect((await post('/api/render-queue/no-such-id/cancel', {})).status).toBe(404);
  });
});
