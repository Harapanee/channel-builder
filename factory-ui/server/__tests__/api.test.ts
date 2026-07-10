import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import type superagent from 'superagent';
import { Readable } from 'node:stream';
import { SessionManager, type PtyLike, type SpawnFn } from '../sessions';
import { JobManager, type SpawnClaude } from '../jobs';
import { RenderQueueManager } from '../render-queue';
import { createApiRouter } from '../api';

class FakePty implements PtyLike {
  dataCb?: (d: string) => void;
  exitCb?: (e: { exitCode: number }) => void;
  written: string[] = [];
  killed = false;
  onData(cb: (d: string) => void) { this.dataCb = cb; }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitCb = cb; }
  write(d: string) { this.written.push(d); }
  resize(_cols: number, _rows: number) {}
  kill() { this.killed = true; this.exitCb?.({ exitCode: 0 }); }
}

/** JobManager 用の FakeSpawn。stdout に流す行を制御し exit を手動発火する(実claude非起動) */
class FakeClaudeProc {
  stdout = new Readable({ read() {} });
  private exitCbs: ((c: number) => void)[] = [];
  killed = false;
  args: string[];
  cwd: string;
  constructor(args: string[], cwd: string) {
    this.args = args;
    this.cwd = cwd;
  }
  onExit(cb: (c: number) => void) { this.exitCbs.push(cb); }
  kill() { this.killed = true; this.exitCbs.forEach((cb) => cb(143)); }
  push(line: string) { this.stdout.push(line + '\n'); }
}

const jobInitLine = (sid: string, cwd: string) =>
  JSON.stringify({ type: 'system', subtype: 'init', session_id: sid, cwd });
const jobTextLine = (t: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const JOB_GATE =
  '<gate>{"gateId":"g1","question":"素材を承認?","options":[{"id":"yes","label":"承認","description":""}],"context":"5枚生成"}</gate>';

/** supertestでバイナリボディをBufferとして受け取るパーサ */
function binaryParser(res: superagent.Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  const stream = res as unknown as NodeJS.ReadableStream;
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
}

const MEDIA_BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

describe('createApiRouter', () => {
  let root: string;
  let app: express.Express;
  let ptys: FakePty[];
  let sessions: SessionManager;
  let jobs: JobManager;
  let renderQueue: RenderQueueManager;
  let jobProcs: FakeClaudeProc[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-api-'));

    // --- チャンネル ch1(フル装備) ---
    const ch1 = path.join(root, 'ch1');
    fs.mkdirSync(ch1);
    fs.writeFileSync(
      path.join(ch1, '.channel-system.json'),
      JSON.stringify({
        channelId: 'UC1', channelName: 'Ch One', status: 'building',
        systemVersion: '1.0', approvedEpisodes: [],
      }),
    );
    fs.writeFileSync(path.join(ch1, 'notes.md'), '# hello');
    fs.writeFileSync(path.join(ch1, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(ch1, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1));

    // episodes/ep001
    const ep = path.join(ch1, 'episodes', 'ep001');
    fs.mkdirSync(path.join(ep, 'out'), { recursive: true });
    fs.mkdirSync(path.join(ep, 'images'), { recursive: true });
    fs.writeFileSync(path.join(ep, 'episode.json'), JSON.stringify({ subject: 'Alpha', status: 'draft' }));
    fs.writeFileSync(path.join(ep, 'script.md'), '# script');
    fs.writeFileSync(path.join(ep, 'out', 'final.mp4'), MEDIA_BYTES);

    // 画像(mtimeを明示設定: a < c < b < d)
    fs.mkdirSync(path.join(ch1, 'assets', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(ch1, 'scratchpad_gen', 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(ch1, 'scratchpad_gen', '.git'), { recursive: true });
    const img = (rel: string, mtimeSec: number) => {
      const p = path.join(ch1, rel);
      fs.writeFileSync(p, 'x');
      fs.utimesSync(p, mtimeSec, mtimeSec);
    };
    img('assets/a.png', 1_000_000);
    img('scratchpad_gen/c.webp', 2_000_000);
    img('assets/sub/b.jpg', 3_000_000);
    img('episodes/ep001/images/d.jpeg', 4_000_000);
    img('scratchpad_gen/node_modules/skip.png', 5_000_000);
    img('scratchpad_gen/.git/skip2.png', 5_000_000);

    // voice-samples
    fs.mkdirSync(path.join(ch1, 'voice-samples'));
    fs.writeFileSync(path.join(ch1, 'voice-samples', 'v1.wav'), 'RIFF');
    fs.writeFileSync(path.join(ch1, 'voice-samples', 'v2.mp3'), 'ID3');
    fs.writeFileSync(path.join(ch1, 'voice-samples', 'ignore.txt'), 'no');

    // --- チャンネル ch2(最小)と非チャンネル ---
    const ch2 = path.join(root, 'ch2');
    fs.mkdirSync(ch2);
    fs.writeFileSync(
      path.join(ch2, '.channel-system.json'),
      JSON.stringify({ channelId: 'UC2', channelName: 'Ch Two', status: 'approved', systemVersion: '2.0' }),
    );
    fs.mkdirSync(path.join(root, 'not-a-channel'));

    ptys = [];
    const spawnFn: SpawnFn = () => {
      const p = new FakePty();
      ptys.push(p);
      return p;
    };
    sessions = new SessionManager(root, spawnFn);

    // jobs(FakeSpawn注入。実claudeは起動しない)
    jobProcs = [];
    const jobSpawn: SpawnClaude = (args, opts) => {
      const p = new FakeClaudeProc(args, opts.cwd);
      jobProcs.push(p);
      return { stdout: p.stdout, onExit: (cb) => p.onExit(cb), kill: () => p.kill() };
    };
    jobs = new JobManager(root, jobSpawn);

    renderQueue = new RenderQueueManager(root, {
      spawnFn: () => ({ pid: 4242 }),
      gitFn: () => Promise.resolve(),
      killFn: () => {},
      aliveFn: () => true,
      pollMs: 10,
    });

    app = express();
    app.use(express.json());
    app.use('/api', createApiRouter({ root, sessions, jobs, renderQueue }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- factory

  it('GET /api/factory はファクトリー名とチャンネル一覧を返す', async () => {
    const res = await request(app).get('/api/factory');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(path.basename(root));
    expect(res.body.channels.map((c: { dir: string }) => c.dir)).toEqual(['ch1', 'ch2']);
    expect(res.body.channels[0].channelName).toBe('Ch One');
    expect(res.body.channels[0].episodeCount).toBe(1);
  });

  // ---------------------------------------------------------------- channels/:dir

  it('GET /api/channels/:dir はsystemとepisodesを返す', async () => {
    const res = await request(app).get('/api/channels/ch1');
    expect(res.status).toBe(200);
    expect(res.body.system.channelId).toBe('UC1');
    expect(res.body.episodes).toHaveLength(1);
    expect(res.body.episodes[0].episodeId).toBe('ep001');
    expect(res.body.episodes[0].hasFinal).toBe(true);
    expect(res.body.episodes[0].hasScript).toBe(true);
  });

  it('GET /api/channels/:dir は不正dirで404(不在・非チャンネル・トラバーサル)', async () => {
    expect((await request(app).get('/api/channels/nope')).status).toBe(404);
    expect((await request(app).get('/api/channels/not-a-channel')).status).toBe(404);
    // デコード後に / を含む
    expect((await request(app).get('/api/channels/..%2Fch1')).status).toBe(404);
    expect((await request(app).get('/api/channels/ch1%2Fepisodes')).status).toBe(404);
  });

  // ---------------------------------------------------------------- file

  it('GET file は .md を text/plain で返す', async () => {
    const res = await request(app).get('/api/channels/ch1/file').query({ path: 'notes.md' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toBe('# hello');
  });

  it('GET file は .env を403で拒否する', async () => {
    const res = await request(app).get('/api/channels/ch1/file').query({ path: '.env' });
    expect(res.status).toBe(403);
  });

  it('GET file は許可外拡張子・トラバーサル・2MB超過を403、不在を404にする', async () => {
    expect((await request(app).get('/api/channels/ch1/file').query({ path: 'episodes/ep001/out/final.mp4' })).status).toBe(403);
    expect((await request(app).get('/api/channels/ch1/file').query({ path: '../ch2/.channel-system.json' })).status).toBe(403);
    expect((await request(app).get('/api/channels/ch1/file').query({ path: 'big.txt' })).status).toBe(403);
    expect((await request(app).get('/api/channels/ch1/file').query({ path: 'missing.md' })).status).toBe(404);
    expect((await request(app).get('/api/channels/nope/file').query({ path: 'notes.md' })).status).toBe(404);
  });

  it('GET file は path クエリ欠落で400', async () => {
    expect((await request(app).get('/api/channels/ch1/file')).status).toBe(400);
  });

  // ---------------------------------------------------------------- media

  it('GET media は mp4 の Range 指定で 206 + Content-Range を返す', async () => {
    const res = await request(app)
      .get('/api/channels/ch1/media')
      .query({ path: 'episodes/ep001/out/final.mp4' })
      .set('Range', 'bytes=0-99')
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-99/1000');
    expect(res.headers['content-length']).toBe('100');
    expect(res.headers['content-type']).toBe('video/mp4');
    expect((res.body as Buffer).equals(MEDIA_BYTES.subarray(0, 100))).toBe(true);
  });

  it('GET media は Range 末尾開放(bytes=950-)にも206で応える', async () => {
    const res = await request(app)
      .get('/api/channels/ch1/media')
      .query({ path: 'episodes/ep001/out/final.mp4' })
      .set('Range', 'bytes=950-')
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 950-999/1000');
    expect((res.body as Buffer).equals(MEDIA_BYTES.subarray(950))).toBe(true);
  });

  it('GET media は Range なしなら200で全体を返し Accept-Ranges を付ける', async () => {
    const res = await request(app)
      .get('/api/channels/ch1/media')
      .query({ path: 'episodes/ep001/out/final.mp4' })
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe('1000');
    expect((res.body as Buffer).equals(MEDIA_BYTES)).toBe(true);
  });

  it('GET media は充足不能な Range で416', async () => {
    const res = await request(app)
      .get('/api/channels/ch1/media')
      .query({ path: 'episodes/ep001/out/final.mp4' })
      .set('Range', 'bytes=2000-');
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */1000');
  });

  it('GET media は画像を200で返す(Range指定でも全体)', async () => {
    const res = await request(app)
      .get('/api/channels/ch1/media')
      .query({ path: 'assets/a.png' })
      .set('Range', 'bytes=0-0')
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('GET media は許可外拡張子・トラバーサルを403、不在を404にする', async () => {
    expect((await request(app).get('/api/channels/ch1/media').query({ path: 'notes.md' })).status).toBe(403);
    expect((await request(app).get('/api/channels/ch1/media').query({ path: '../ch2/x.mp4' })).status).toBe(403);
    expect((await request(app).get('/api/channels/ch1/media').query({ path: 'episodes/ep001/out/missing.mp4' })).status).toBe(404);
  });

  // ---------------------------------------------------------------- images

  it('GET images は mtime 降順で返し node_modules/.git を除外する', async () => {
    const res = await request(app).get('/api/channels/ch1/images');
    expect(res.status).toBe(200);
    const paths = res.body.images.map((i: { path: string }) => i.path);
    expect(paths).toEqual([
      'episodes/ep001/images/d.jpeg',
      'assets/sub/b.jpg',
      'scratchpad_gen/c.webp',
      'assets/a.png',
    ]);
    for (const e of res.body.images) {
      expect(typeof e.mtimeMs).toBe('number');
      expect(typeof e.size).toBe('number');
    }
  });

  it('GET images は limit を尊重する', async () => {
    const res = await request(app).get('/api/channels/ch1/images').query({ limit: '2' });
    expect(res.status).toBe(200);
    expect(res.body.images.map((i: { path: string }) => i.path)).toEqual([
      'episodes/ep001/images/d.jpeg',
      'assets/sub/b.jpg',
    ]);
  });

  it('GET images は画像フォルダのないチャンネルで空配列', async () => {
    const res = await request(app).get('/api/channels/ch2/images');
    expect(res.status).toBe(200);
    expect(res.body.images).toEqual([]);
  });

  // ---------------------------------------------------------------- voices

  it('GET voices は voice-samples/ の .wav/.mp3 を返す', async () => {
    const res = await request(app).get('/api/channels/ch1/voices');
    expect(res.status).toBe(200);
    expect(res.body.voices).toEqual([
      { path: 'voice-samples/v1.wav', name: 'v1' },
      { path: 'voice-samples/v2.mp3', name: 'v2' },
    ]);
  });

  it('GET voices は voice-samples/ 不在なら空配列', async () => {
    const res = await request(app).get('/api/channels/ch2/voices');
    expect(res.status).toBe(200);
    expect(res.body.voices).toEqual([]);
  });

  // ---------------------------------------------------------------- sessions

  it('POST /api/sessions はセッションを作成し、一覧に載る', async () => {
    const res = await request(app).post('/api/sessions').send({ cwd: 'ch1' });
    expect(res.status).toBe(200);
    expect(res.body.cwd).toBe('ch1');
    expect(res.body.status).toBe('running');
    const list = await request(app).get('/api/sessions');
    expect(list.status).toBe(200);
    expect(list.body.map((s: { id: string }) => s.id)).toContain(res.body.id);
  });

  it('POST /api/sessions は不正cwdで400', async () => {
    expect((await request(app).post('/api/sessions').send({ cwd: '../etc' })).status).toBe(400);
    expect((await request(app).post('/api/sessions').send({ cwd: 'nope' })).status).toBe(400);
  });

  it('POST /api/sessions はContent-Typeが非JSONなら415でセッションを作らない', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .set('Content-Type', 'text/plain')
      .send('cwd=');
    expect(res.status).toBe(415);
    const list = await request(app).get('/api/sessions');
    expect(list.body.length).toBe(0);
  });

  it('POST input(submit)で FakePty に text\\r が届く', async () => {
    const created = await request(app).post('/api/sessions').send({ cwd: 'ch1' });
    const id = created.body.id as string;
    const res = await request(app).post(`/api/sessions/${id}/input`).send({ text: 'hello', submit: true });
    expect(res.status).toBe(204);
    expect(ptys[0]!.written).toEqual(['hello\r']);
  });

  it('POST input(submitなし)は text がそのまま届く', async () => {
    const created = await request(app).post('/api/sessions').send({ cwd: '' });
    const id = created.body.id as string;
    await request(app).post(`/api/sessions/${id}/input`).send({ text: 'hi' });
    expect(ptys[0]!.written).toEqual(['hi']);
  });

  it('POST input は不明idで404、textが文字列でなければ400', async () => {
    expect((await request(app).post('/api/sessions/zzz/input').send({ text: 'x' })).status).toBe(404);
    const created = await request(app).post('/api/sessions').send({ cwd: '' });
    expect(
      (await request(app).post(`/api/sessions/${created.body.id}/input`).send({ text: 42 })).status,
    ).toBe(400);
  });

  it('POST kill は204でセッションをexitedにする', async () => {
    const created = await request(app).post('/api/sessions').send({ cwd: '' });
    const id = created.body.id as string;
    const res = await request(app).post(`/api/sessions/${id}/kill`);
    expect(res.status).toBe(204);
    expect(ptys[0]!.killed).toBe(true);
    expect(sessions.get(id)!.status).toBe('exited');
  });

  it('POST restart は SessionInfo を返し running に戻す', async () => {
    const created = await request(app).post('/api/sessions').send({ cwd: 'ch1' });
    const id = created.body.id as string;
    await request(app).post(`/api/sessions/${id}/kill`);
    const res = await request(app).post(`/api/sessions/${id}/restart`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.status).toBe('running');
    expect(ptys).toHaveLength(2);
  });

  it('POST kill/restart は不明idで404', async () => {
    expect((await request(app).post('/api/sessions/zzz/kill')).status).toBe(404);
    expect((await request(app).post('/api/sessions/zzz/restart')).status).toBe(404);
  });

  // ---------------------------------------------------------------- operations

  it('GET /api/operations は buildCommand を除いた OperationDef 配列を返す', async () => {
    const res = await request(app).get('/api/operations');
    expect(res.status).toBe(200);
    expect(res.body.map((o: { key: string }) => o.key)).toEqual([
      'video-create',
      'channel-refine',
      'theme-scout',
      'system-refine',
      'ask',
    ]);
    expect(res.body[0].label).toBe('新規動画を制作');
    expect(res.body[0].needsArg).toBe(true);
    // buildCommand はUIに漏らさない(任意コマンド実行口の遮断)
    for (const o of res.body) expect(o.buildCommand).toBeUndefined();
  });

  // ---------------------------------------------------------------- jobs

  it('POST /api/jobs は JobManager.create を呼び 201 で JobSummary を返し、一覧に載る', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .send({ dir: 'ch1', operation: 'video-create', arg: '織田信長' });
    expect(res.status).toBe(201);
    expect(res.body.dir).toBe('ch1');
    expect(res.body.operation).toBe('video-create');
    expect(res.body.status).toBe('running');
    expect(res.body.title).toBe('織田信長');
    // JobSummary(JobDetail固有のstages等は含めない)
    expect(res.body.stages).toBeUndefined();
    // 実際に(fake)claude が対象cwdでspawnされている
    expect(jobProcs).toHaveLength(1);
    expect(jobProcs[0]!.args[0]).toBe('-p');
    expect(jobProcs[0]!.cwd).toBe(path.join(root, 'ch1'));
    const list = await request(app).get('/api/jobs');
    expect(list.body.map((j: { id: string }) => j.id)).toContain(res.body.id);
  });

  it('POST /api/jobs は不正operation/不正dir/dir欠落で400、非JSONで415(いずれもspawnしない)', async () => {
    expect(
      (await request(app).post('/api/jobs').send({ dir: 'ch1', operation: 'nope', arg: 'x' })).status,
    ).toBe(400);
    expect(
      (await request(app).post('/api/jobs').send({ dir: 'missing', operation: 'theme-scout', arg: '' })).status,
    ).toBe(400);
    expect((await request(app).post('/api/jobs').send({ operation: 'theme-scout' })).status).toBe(400);
    const nonJson = await request(app)
      .post('/api/jobs')
      .set('Content-Type', 'text/plain')
      .send('dir=ch1');
    expect(nonJson.status).toBe(415);
    expect(jobProcs).toHaveLength(0);
  });

  it('GET /api/jobs は一覧、GET /api/jobs/:id は詳細、不明idは404', async () => {
    const empty = await request(app).get('/api/jobs');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);
    const created = await request(app)
      .post('/api/jobs')
      .send({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    const id = created.body.id as string;
    const detail = await request(app).get(`/api/jobs/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(id);
    expect(Array.isArray(detail.body.stages)).toBe(true); // JobDetail
    expect((await request(app).get('/api/jobs/zzz')).status).toBe(404);
  });

  it('POST /api/jobs/:id/cancel は 204 で cancelled にし、不明idは404', async () => {
    const created = await request(app)
      .post('/api/jobs')
      .send({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    const id = created.body.id as string;
    const res = await request(app).post(`/api/jobs/${id}/cancel`);
    expect(res.status).toBe(204);
    expect(jobs.get(id)!.status).toBe('cancelled');
    expect((await request(app).post('/api/jobs/zzz/cancel')).status).toBe(404);
  });

  it('POST /api/jobs/:id/gate は respondGate を呼び 204(不明id404・不正optionId400)', async () => {
    const created = await request(app)
      .post('/api/jobs')
      .send({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    const id = created.body.id as string;
    // fake claude が init + gate を出力 → awaiting_gate に遷移させる
    jobProcs[0]!.push(jobInitLine('sid-1', path.join(root, 'ch1')));
    jobProcs[0]!.push(jobTextLine(JOB_GATE));
    await new Promise((r) => setTimeout(r, 30));
    expect(jobs.get(id)!.status).toBe('awaiting_gate');
    // 不明id → 404
    expect((await request(app).post('/api/jobs/zzz/gate').send({ optionId: 'yes' })).status).toBe(404);
    // 不正optionId → 400(状態は保持)
    expect(
      (await request(app).post(`/api/jobs/${id}/gate`).send({ optionId: 'nope' })).status,
    ).toBe(400);
    expect(jobs.get(id)!.status).toBe('awaiting_gate');
    // 正常 → 204、respondGate が --resume 付きで再spawn
    const ok = await request(app).post(`/api/jobs/${id}/gate`).send({ optionId: 'yes' });
    expect(ok.status).toBe(204);
    expect(jobProcs).toHaveLength(2);
    expect(jobProcs[1]!.args).toContain('--resume');
    expect(jobs.get(id)!.status).toBe('running');
  });

  // ---------------------------------------------------- channels(直接編集)

  it('POST approve は edits.approveEpisode を呼び 204、不明チャンネル404・空episodeId400・非JSON415', async () => {
    const res = await request(app).post('/api/channels/ch1/episodes/ep001/approve').send({});
    expect(res.status).toBe(204);
    const sys = JSON.parse(fs.readFileSync(path.join(root, 'ch1', '.channel-system.json'), 'utf8'));
    expect(sys.approvedEpisodes).toContain('ep001');
    // 不明チャンネル → 404
    expect(
      (await request(app).post('/api/channels/nope/episodes/ep001/approve').send({})).status,
    ).toBe(404);
    // 空白episodeId(%20) → approveEpisode が throw → 400
    expect(
      (await request(app).post('/api/channels/ch1/episodes/%20/approve').send({})).status,
    ).toBe(400);
    // 非JSON → 415
    expect(
      (
        await request(app)
          .post('/api/channels/ch1/episodes/ep001/approve')
          .set('Content-Type', 'text/plain')
          .send('x')
      ).status,
    ).toBe(415);
  });

  it('POST curate は library を承認/却下し 204、不正decision・不明entryは400', async () => {
    fs.writeFileSync(
      path.join(root, 'ch1', 'assets', 'library.json'),
      JSON.stringify({ assets: [{ assetId: 'a1', kind: 'image' }] }),
    );
    const res = await request(app)
      .post('/api/channels/ch1/library/a1/curate')
      .send({ decision: 'approve' });
    expect(res.status).toBe(204);
    const lib = JSON.parse(fs.readFileSync(path.join(root, 'ch1', 'assets', 'library.json'), 'utf8'));
    expect(lib.assets[0].approvedBy).toBe('human');
    // 不正decision → 400
    expect(
      (await request(app).post('/api/channels/ch1/library/a1/curate').send({ decision: 'maybe' })).status,
    ).toBe(400);
    // 不明entry → 400
    expect(
      (await request(app).post('/api/channels/ch1/library/zzz/curate').send({ decision: 'reject' })).status,
    ).toBe(400);
  });

  it('GET/PUT bible は読み書きし、PUTは writeBible を呼ぶ(空content400・非JSON415)', async () => {
    fs.mkdirSync(path.join(root, 'ch1', 'channel'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ch1', 'channel', 'bible.md'), '# Old Bible');
    const got = await request(app).get('/api/channels/ch1/bible');
    expect(got.status).toBe(200);
    expect(got.body.content).toBe('# Old Bible');
    // PUT で更新
    const put = await request(app).put('/api/channels/ch1/bible').send({ content: '# New Bible' });
    expect(put.status).toBe(204);
    expect(fs.readFileSync(path.join(root, 'ch1', 'channel', 'bible.md'), 'utf8')).toBe('# New Bible');
    // 空(空白のみ)content → writeBible が throw → 400
    expect((await request(app).put('/api/channels/ch1/bible').send({ content: '   ' })).status).toBe(400);
    // 非JSON → 415
    expect(
      (
        await request(app)
          .put('/api/channels/ch1/bible')
          .set('Content-Type', 'text/plain')
          .send('x')
      ).status,
    ).toBe(415);
  });

  it('GET bible は bible.md 不在で404、不明チャンネルでも404', async () => {
    // ch1 に channel/bible.md を作らない
    expect((await request(app).get('/api/channels/ch1/bible')).status).toBe(404);
    expect((await request(app).get('/api/channels/nope/bible')).status).toBe(404);
  });
});
