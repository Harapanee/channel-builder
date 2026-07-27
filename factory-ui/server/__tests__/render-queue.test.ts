import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RenderQueueManager, type SpawnRender, type RunGit } from '../render-queue';

// FakeSpawn: 呼び出しを記録してpidを返すだけ。完了はテストがステータスファイルを書いて模擬する
type SpawnCall = { cmd: string; args: string[]; cwd: string; logPath: string };

function makeChannel(root: string, dir: string, eps: Array<{ epId: string; status: string }>): void {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(
    path.join(root, dir, '.channel-system.json'),
    JSON.stringify({ channelId: dir, metrics: [] }, null, 2),
  );
  for (const e of eps) {
    const d = path.join(root, dir, 'episodes', e.epId);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, 'episode.json'),
      JSON.stringify({ episodeId: e.epId, subject: e.epId, status: e.status }, null, 2),
    );
  }
}

function writeStatus(root: string, dir: string, epId: string, obj: Record<string, unknown>): void {
  const out = path.join(root, dir, 'episodes', epId, 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, '.render-status-final.json'), JSON.stringify(obj));
}

function makeShort(
  root: string,
  dir: string,
  shorts: Array<{ shortId: string; status: string }>,
): void {
  for (const s of shorts) {
    const d = path.join(root, dir, 'shorts', s.shortId);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, 'short.json'),
      JSON.stringify(
        { shortId: s.shortId, formatId: 'f1', sourceEpisodeId: 'ep001-a', title: s.shortId, status: s.status },
        null,
        2,
      ),
    );
  }
}

function writeShortStatus(root: string, dir: string, shortId: string, obj: Record<string, unknown>): void {
  const out = path.join(root, dir, 'shorts', shortId, 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, '.render-status-final.json'), JSON.stringify(obj));
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('RenderQueueManager', () => {
  let root: string;
  let spawns: SpawnCall[];
  let gitCalls: Array<{ cwd: string; args: string[] }>;
  let kills: number[];
  let m: RenderQueueManager;

  const newManager = (opts: { alive?: boolean } = {}) => {
    const spawnFn: SpawnRender = (cmd, args, o) => {
      spawns.push({ cmd, args, cwd: o.cwd, logPath: o.logPath });
      return { pid: 4242 };
    };
    const gitFn: RunGit = (cwd, args) => {
      gitCalls.push({ cwd, args });
      return Promise.resolve();
    };
    return new RenderQueueManager(root, {
      spawnFn,
      gitFn,
      killFn: (pid) => kills.push(pid),
      aliveFn: () => opts.alive ?? true,
      pollMs: 10,
    });
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-rq-'));
    makeChannel(root, 'ch1', [
      { epId: 'ep001-a', status: 'render_ready' },
      { epId: 'ep002-b', status: 'render_ready' },
      { epId: 'ep003-packaged', status: 'packaged' },
    ]);
    makeShort(root, 'ch1', [
      { shortId: 'sh001-t', status: 'studio_checked' },
      { shortId: 'sh002-t', status: 'implemented' },
    ]);
    spawns = [];
    gitCalls = [];
    kills = [];
    m = newManager();
  });

  it('enqueue: waitingで登録され list とrender-queue.json に載る', () => {
    const item = m.enqueue('ch1', 'ep001-a');
    expect(item.status).toBe('waiting');
    expect(m.list().map((i) => i.epId)).toEqual(['ep001-a']);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(root, 'factory-ui', 'render-queue.json'), 'utf8'),
    ) as { items: Array<{ epId: string }> };
    expect(persisted.items[0]!.epId).toBe('ep001-a');
  });

  it('二重登録: 同dir+epIdのwaiting/running有りは duplicate: throw。不明チャンネル/エピソードは unknown:', () => {
    m.enqueue('ch1', 'ep001-a');
    expect(() => m.enqueue('ch1', 'ep001-a')).toThrow(/^duplicate:/);
    expect(() => m.enqueue('nope', 'ep001-a')).toThrow(/^unknown:/);
    expect(() => m.enqueue('ch1', 'ep999-nope')).toThrow(/^unknown:/);
    expect(() => m.enqueue('../etc', 'ep001-a')).toThrow(/^(unknown|invalid):/);
  });

  it('requireReady: render_ready未満は not_ready:、render_readyは通る', () => {
    expect(() => m.enqueue('ch1', 'ep003-packaged', { requireReady: true })).toThrow(/^not_ready:/);
    expect(m.enqueue('ch1', 'ep001-a', { requireReady: true }).status).toBe('waiting');
  });

  it('enqueueFromGate: 登録成功と既登録はtrue、不明はfalse', () => {
    expect(m.enqueueFromGate('ch1', 'ep001-a')).toBe(true);
    expect(m.enqueueFromGate('ch1', 'ep001-a')).toBe(true); // dup=登録済み扱い
    expect(m.enqueueFromGate('ch1', 'ep999-nope')).toBe(false);
    expect(m.list()).toHaveLength(1);
  });

  it('直列消化: 1本ずつspawnし、完了検知で次へ進む。実行中のstartはbusy、空のstartはempty', async () => {
    m.enqueue('ch1', 'ep001-a');
    m.enqueue('ch1', 'ep002-b');
    m.start();
    expect(() => m.start()).toThrow(/^busy:/);
    await waitFor(() => spawns.length === 1);
    expect(spawns[0]!.cmd).toBe('bash');
    expect(spawns[0]!.args).toEqual(['scripts/render-episode.sh', 'episodes/ep001-a', 'final']);
    expect(spawns[0]!.cwd).toBe(path.join(root, 'ch1'));
    expect(spawns[0]!.logPath).toBe(path.join(root, 'ch1', 'episodes', 'ep001-a', 'out', 'render-final.log'));
    // 1本目が完了するまで2本目はspawnされない
    await new Promise((r) => setTimeout(r, 50));
    expect(spawns).toHaveLength(1);
    writeStatus(root, 'ch1', 'ep001-a', { out: 'final', ok: true, durationSec: 300.5, qaExit: 0 });
    await waitFor(() => spawns.length === 2);
    expect(m.list().find((i) => i.epId === 'ep001-a')?.status).toBe('done');
    writeStatus(root, 'ch1', 'ep002-b', { out: 'final', ok: true, durationSec: 100, qaExit: 0 });
    await waitFor(() => m.list().every((i) => i.status === 'done'));
    // 消化完了後は再startできる(waitingが無いのでempty)
    expect(() => m.start()).toThrow(/^empty:/);
  });

  it('成功時の完了処理: episode.json final・metrics renderMinutes・git add/commit', async () => {
    m.enqueue('ch1', 'ep001-a');
    m.start();
    await waitFor(() => spawns.length === 1);
    writeStatus(root, 'ch1', 'ep001-a', { out: 'final', ok: true, durationSec: 321, qaExit: 0 });
    await waitFor(() => m.list()[0]?.status === 'done');
    const item = m.list()[0]!;
    expect(item.durationSec).toBe(321);
    expect(item.qaExit).toBe(0);
    const ep = JSON.parse(
      fs.readFileSync(path.join(root, 'ch1', 'episodes', 'ep001-a', 'episode.json'), 'utf8'),
    ) as { status: string };
    expect(ep.status).toBe('final');
    const sys = JSON.parse(fs.readFileSync(path.join(root, 'ch1', '.channel-system.json'), 'utf8')) as {
      metrics: Array<{ episodeId: string; renderMinutes: number }>;
    };
    const entry = sys.metrics.find((e) => e.episodeId === 'ep001-a');
    expect(entry?.renderMinutes).toBeGreaterThanOrEqual(1);
    expect(gitCalls[0]!.args).toEqual(['add', '-A', 'episodes/ep001-a', '.channel-system.json']);
    expect(gitCalls[1]!.args).toEqual(['commit', '-m', 'render(ep001-a): final render + QA pass [factory-ui]']);
    expect(gitCalls[0]!.cwd).toBe(path.join(root, 'ch1'));
  });

  it('失敗継続: ゲート落ちは reason 転記・QA落ちは qa_failed。いずれも次のアイテムへ進み、episode.jsonは触らない', async () => {
    m.enqueue('ch1', 'ep001-a');
    m.enqueue('ch1', 'ep002-b');
    m.start();
    await waitFor(() => spawns.length === 1);
    writeStatus(root, 'ch1', 'ep001-a', { out: 'final', ok: false, reason: 'infinity_gate' });
    await waitFor(() => spawns.length === 2); // 失敗してもキューは止めない
    writeStatus(root, 'ch1', 'ep002-b', { out: 'final', ok: true, durationSec: 100, qaExit: 2 });
    await waitFor(() => m.list().every((i) => i.status === 'failed'));
    const [a, b] = m.list();
    expect(a?.reason).toBe('infinity_gate');
    expect(b?.reason).toBe('qa_failed');
    expect(b?.qaExit).toBe(2);
    // 失敗時は episode.json は render_ready のまま・gitコミットなし
    const ep = JSON.parse(
      fs.readFileSync(path.join(root, 'ch1', 'episodes', 'ep002-b', 'episode.json'), 'utf8'),
    ) as { status: string };
    expect(ep.status).toBe('render_ready');
    expect(gitCalls).toHaveLength(0);
    // 失敗後は同じエピソードを再キューできる
    expect(m.enqueue('ch1', 'ep001-a').status).toBe('waiting');
  });

  it('キャンセル: waitingは削除、runningはkillしてcanceled(キューは次へ)', async () => {
    const w = m.enqueue('ch1', 'ep001-a');
    m.cancel(w.id);
    expect(m.list()).toHaveLength(0);

    const r1 = m.enqueue('ch1', 'ep001-a');
    m.enqueue('ch1', 'ep002-b');
    m.start();
    await waitFor(() => spawns.length === 1);
    m.cancel(r1.id);
    expect(kills).toEqual([4242]);
    expect(m.list().find((i) => i.id === r1.id)?.status).toBe('canceled');
    await waitFor(() => spawns.length === 2); // キャンセルしても次のwaitingへ進む
    writeStatus(root, 'ch1', 'ep002-b', { out: 'final', ok: true, durationSec: 10, qaExit: 0 });
    await waitFor(() => m.list().find((i) => i.epId === 'ep002-b')?.status === 'done');
    expect(() => m.cancel(r1.id)).toThrow(/^invalid:/); // 確定済みはキャンセル不可
    expect(() => m.cancel('no-such-id')).toThrow(/^unknown:/);
  });

  it('clearFinished: 終了済み(done/failed)だけ消して件数を返す。waitingは残り、永続化とupdate通知が走る', async () => {
    m.enqueue('ch1', 'ep001-a');
    m.enqueue('ch1', 'ep002-b');
    m.start();
    await waitFor(() => spawns.length === 1);
    writeStatus(root, 'ch1', 'ep001-a', { out: 'final', ok: true, durationSec: 10, qaExit: 0 });
    await waitFor(() => spawns.length === 2);
    writeStatus(root, 'ch1', 'ep002-b', { out: 'final', ok: false, reason: 'infinity_gate' });
    await waitFor(() => m.list().every((i) => i.status === 'done' || i.status === 'failed'));
    const waiting = m.enqueue('ch1', 'ep001-a'); // 再キュー(waiting)は消えない対象
    let updates = 0;
    m.on('update', () => updates++);

    expect(m.clearFinished()).toBe(2);
    expect(m.list().map((i) => i.id)).toEqual([waiting.id]);
    expect(updates).toBe(1);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(root, 'factory-ui', 'render-queue.json'), 'utf8'),
    ) as { items: Array<{ id: string }> };
    expect(persisted.items.map((i) => i.id)).toEqual([waiting.id]);

    // 0件のときは何もしない(永続化もupdateも走らない)
    fs.rmSync(path.join(root, 'factory-ui', 'render-queue.json'));
    expect(m.clearFinished()).toBe(0);
    expect(updates).toBe(1);
    expect(fs.existsSync(path.join(root, 'factory-ui', 'render-queue.json'))).toBe(false);
  });

  it('startOne: 選んだ1本だけ実行し、他のwaitingへは進まない。実行中はstart/startOneともbusy', async () => {
    const a = m.enqueue('ch1', 'ep001-a');
    m.enqueue('ch1', 'ep002-b');
    m.startOne(a.id);
    // 単発実行中は一括開始も別の単発開始もbusy
    expect(() => m.start()).toThrow(/^busy:/);
    expect(() => m.startOne(a.id)).toThrow(/^busy:/);
    await waitFor(() => spawns.length === 1);
    expect(spawns[0]!.args).toEqual(['scripts/render-episode.sh', 'episodes/ep001-a', 'final']);
    writeStatus(root, 'ch1', 'ep001-a', { out: 'final', ok: true, durationSec: 60, qaExit: 0 });
    await waitFor(() => m.list().find((i) => i.id === a.id)?.status === 'done');
    // 完了しても次のwaiting(ep002-b)には進まない
    await new Promise((r) => setTimeout(r, 50));
    expect(spawns).toHaveLength(1);
    expect(m.list().find((i) => i.epId === 'ep002-b')?.status).toBe('waiting');
    // 単発完了後は通常のstart()が使える(consumingが解放されている)
    m.start();
    await waitFor(() => spawns.length === 2);
    writeStatus(root, 'ch1', 'ep002-b', { out: 'final', ok: true, durationSec: 10, qaExit: 0 });
    await waitFor(() => m.list().every((i) => i.status === 'done'));
  });

  it('startOne: 不明IDはunknown、非waitingはconflict、キュー消化中はbusy', async () => {
    expect(() => m.startOne('no-such-id')).toThrow(/^unknown:/);
    const a = m.enqueue('ch1', 'ep001-a');
    const b = m.enqueue('ch1', 'ep002-b');
    m.start();
    await waitFor(() => spawns.length === 1);
    // 消化ループ稼働中: runningのaはconflictより先にbusy、waitingのbもbusy
    expect(() => m.startOne(b.id)).toThrow(/^busy:/);
    writeStatus(root, 'ch1', 'ep001-a', { out: 'final', ok: true, durationSec: 10, qaExit: 0 });
    // bが実際にspawnされてから書く(先書きするとrunOneの残骸クリアで消される)
    await waitFor(() => spawns.length === 2);
    writeStatus(root, 'ch1', 'ep002-b', { out: 'final', ok: true, durationSec: 10, qaExit: 0 });
    await waitFor(() => m.list().every((i) => i.status === 'done'));
    // 確定済み(done)アイテムの単発開始はconflict
    expect(() => m.startOne(a.id)).toThrow(/^conflict:/);
  });

  it('復元: runningアイテムはステータスファイルで確定し、waitingの消化を続ける', async () => {
    // 前世代のサーバーが残した状態を模擬(runningのpidは死んでいる)
    const stateDir = path.join(root, 'factory-ui');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'render-queue.json'),
      JSON.stringify({
        items: [
          {
            id: 'restored-1', dir: 'ch1', epId: 'ep001-a', status: 'running',
            enqueuedAt: new Date(Date.now() - 60000).toISOString(),
            startedAt: new Date(Date.now() - 30000).toISOString(), pid: 99999,
          },
          {
            id: 'restored-2', dir: 'ch1', epId: 'ep002-b', status: 'waiting',
            enqueuedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    writeStatus(root, 'ch1', 'ep001-a', { out: 'final', ok: true, durationSec: 200, qaExit: 0 });
    const m2 = newManager({ alive: false });
    m2.restore();
    await waitFor(() => m2.list().find((i) => i.id === 'restored-1')?.status === 'done');
    await waitFor(() => spawns.length === 1); // waitingだったep002-bの消化が続く
    expect(spawns[0]!.args[1]).toBe('episodes/ep002-b');
    writeStatus(root, 'ch1', 'ep002-b', { out: 'final', ok: true, durationSec: 10, qaExit: 0 });
    await waitFor(() => m2.list().every((i) => i.status === 'done'));
  });

  describe('kind=short', () => {
    it('enqueue: short.jsonを参照して登録されkindが保存される。requireReadyはstudio_checked未満を弾く', () => {
      const item = m.enqueue('ch1', 'sh001-t', { kind: 'short', requireReady: true });
      expect(item.kind).toBe('short');
      expect(item.status).toBe('waiting');
      expect(() => m.enqueue('ch1', 'sh002-t', { kind: 'short', requireReady: true })).toThrow(/^not_ready:/);
      expect(() => m.enqueue('ch1', 'sh999-none', { kind: 'short' })).toThrow(/^unknown:/);
      // kindごとに参照先が異なる: 同じIDをエピソードとして探すと見つからない
      expect(() => m.enqueue('ch1', 'sh001-t')).toThrow(/^unknown:/);
    });

    it('start: shortは scripts/render-episode.sh shorts/<id> final でspawnされ、成功で short.json が rendered になる', async () => {
      m.enqueue('ch1', 'sh001-t', { kind: 'short' });
      m.start();
      await waitFor(() => spawns.length === 1);
      expect(spawns[0].args).toEqual(['scripts/render-episode.sh', 'shorts/sh001-t', 'final']);
      writeShortStatus(root, 'ch1', 'sh001-t', { out: 'final', ok: true, qaExit: 0, durationSec: 55 });
      await waitFor(() => m.list()[0].status === 'done');
      const meta = JSON.parse(
        fs.readFileSync(path.join(root, 'ch1', 'shorts', 'sh001-t', 'short.json'), 'utf8'),
      ) as { status: string };
      expect(meta.status).toBe('rendered');
      // metrics(renderMinutes)はエピソード専用 — shortでは書かない
      const sys = JSON.parse(
        fs.readFileSync(path.join(root, 'ch1', '.channel-system.json'), 'utf8'),
      ) as { metrics: unknown[] };
      expect(sys.metrics).toEqual([]);
      // git commit は shorts/ 配下を対象にする
      expect(gitCalls.some((c) => c.args.join(' ').includes('shorts/sh001-t'))).toBe(true);
    });

    it('start: short失敗時は short.json を触らず failed にする', async () => {
      m.enqueue('ch1', 'sh001-t', { kind: 'short' });
      m.start();
      await waitFor(() => spawns.length === 1);
      writeShortStatus(root, 'ch1', 'sh001-t', { out: 'final', ok: false, reason: 'all_attempts_failed' });
      await waitFor(() => m.list()[0].status === 'failed');
      const meta = JSON.parse(
        fs.readFileSync(path.join(root, 'ch1', 'shorts', 'sh001-t', 'short.json'), 'utf8'),
      ) as { status: string };
      expect(meta.status).toBe('studio_checked');
    });
  });
});
