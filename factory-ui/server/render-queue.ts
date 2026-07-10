import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RenderQueueItem } from '../shared/types';

// レンダープロセスの最小インターフェース(テストでFakeを注入する)。
// 実装は detached + unref: サーバーが再起動してもレンダー本体は生き残り、
// 完了検知はステータスファイルのポーリングで行う。
export type SpawnRender = (
  cmd: string,
  args: string[],
  opts: { cwd: string; logPath: string },
) => { pid: number };

export type RunGit = (cwd: string, args: string[]) => Promise<void>;

const defaultSpawnRender: SpawnRender = (cmd, args, opts) => {
  const out = fs.openSync(opts.logPath, 'a');
  const p = spawn(cmd, args, { cwd: opts.cwd, detached: true, stdio: ['ignore', out, out] });
  p.unref();
  fs.closeSync(out); // fdは子が継承済み
  return { pid: p.pid ?? -1 };
};

const defaultRunGit: RunGit = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err) => (err ? reject(err) : resolve()));
  });

// detachedで起動した子はプロセスグループリーダー。グループごとSIGTERMで止める
const defaultKill = (pid: number): void => {
  process.kill(-pid, 'SIGTERM');
};

const defaultAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** render-episode.sh が全終了経路で書くステータスマーカー(out/.render-status-final.json) */
type RenderStatusFile = {
  out?: string;
  ok?: boolean;
  reason?: string;
  durationSec?: number;
  qaExit?: number;
};

export type RenderQueueOpts = {
  spawnFn?: SpawnRender;
  gitFn?: RunGit;
  killFn?: (pid: number) => void;
  aliveFn?: (pid: number) => boolean;
  pollMs?: number;
};

/**
 * 夜間レンダーキュー。承認済み(render_ready)エピソードを溜め、「夜間レンダー開始」で
 * 全チャンネル横断・enqueuedAt順に1本ずつ render-episode.sh final を直列消化する。
 * - 実行主体はサーバー(Claudeセッション不使用)。レンダー本体は detached で切り離す
 * - 完了検知は out/.render-status-final.json のポーリング(サーバー再起動に耐える)
 * - 失敗してもキューは止めない。成功時は episode.json final / metrics renderMinutes / git commit を機械的に行う
 * - 永続化: factory-ui/render-queue.json
 * emit: 'update'(RenderQueueItem[])
 */
export class RenderQueueManager extends EventEmitter {
  private readonly root: string;
  private readonly spawnFn: SpawnRender;
  private readonly gitFn: RunGit;
  private readonly killFn: (pid: number) => void;
  private readonly aliveFn: (pid: number) => boolean;
  private readonly pollMs: number;
  private items: RenderQueueItem[] = [];
  private consuming = false;

  constructor(root: string, opts: RenderQueueOpts = {}) {
    super();
    this.root = path.resolve(root);
    this.spawnFn = opts.spawnFn ?? defaultSpawnRender;
    this.gitFn = opts.gitFn ?? defaultRunGit;
    this.killFn = opts.killFn ?? defaultKill;
    this.aliveFn = opts.aliveFn ?? defaultAlive;
    this.pollMs = opts.pollMs ?? 5000;
  }

  list(): RenderQueueItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  /**
   * キューへ登録する。throwメッセージの先頭トークンでAPI層がHTTPコードへ写す:
   * duplicate: / not_ready: → 409、unknown: → 404、invalid: → 400
   */
  enqueue(dir: string, epId: string, opts: { requireReady?: boolean } = {}): RenderQueueItem {
    const cwd = this.resolveChannel(dir);
    if (!isSingleSegment(epId)) throw new Error(`invalid: bad epId: ${epId}`);
    let meta: Record<string, unknown>;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(cwd, 'episodes', epId, 'episode.json'), 'utf8'),
      ) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad json');
      meta = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`unknown: episode not found: ${epId}`);
    }
    const dup = this.items.find(
      (i) => i.dir === dir && i.epId === epId && (i.status === 'waiting' || i.status === 'running'),
    );
    if (dup) throw new Error(`duplicate: already queued: ${dir}/${epId}`);
    if (opts.requireReady) {
      const status = typeof meta.status === 'string' ? meta.status : '';
      if (status !== 'render_ready' && status !== 'final') {
        throw new Error(`not_ready: episode status is ${status || '(none)'}(render_ready 以降のみ登録できます)`);
      }
    }
    const item: RenderQueueItem = {
      id: randomUUID(),
      dir,
      epId,
      status: 'waiting',
      enqueuedAt: new Date().toISOString(),
    };
    this.items.push(item);
    this.persist();
    this.emitUpdate();
    return item;
  }

  /** jobs.ts のrender-check承認から呼ぶ登録口。既登録は「登録済み」としてtrue */
  enqueueFromGate(dir: string, epId: string): boolean {
    try {
      this.enqueue(dir, epId);
      return true;
    } catch (e) {
      return e instanceof Error && e.message.startsWith('duplicate:');
    }
  }

  /** 夜間消化を開始する(寝る前の手動ボタン)。busy: 実行中 / empty: waiting無し */
  start(): void {
    if (this.consuming) throw new Error('busy: render queue is already running');
    if (!this.items.some((i) => i.status === 'waiting')) throw new Error('empty: no waiting items');
    this.consuming = true;
    void this.consumeLoop();
  }

  cancel(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error(`unknown: item not found: ${id}`);
    if (item.status === 'waiting') {
      this.items = this.items.filter((i) => i.id !== id);
      this.persist();
      this.emitUpdate();
      return;
    }
    if (item.status !== 'running') throw new Error(`invalid: cannot cancel ${item.status} item`);
    if (item.pid !== undefined) {
      try {
        this.killFn(item.pid);
      } catch {
        /* already dead */
      }
    }
    this.finish(item, 'canceled', {});
  }

  /**
   * 起動時に永続化状態を復元する。running残留はレンダー本体が生きている前提で
   * ステータスファイルのポーリングを再開し(二重起動はしない)、完了後にwaitingの消化を続ける。
   */
  restore(): void {
    const p = this.queuePath();
    if (!fs.existsSync(p)) return;
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8')) as { items?: RenderQueueItem[] };
      if (Array.isArray(data.items)) this.items = data.items;
    } catch {
      return; // 壊れた永続化は無視(空キューで開始)
    }
    const running = this.items.find((i) => i.status === 'running');
    if (!running || this.consuming) return;
    this.consuming = true;
    void this.consumeLoop(running);
  }

  // ---- internals ----

  /** waiting を enqueuedAt順(=配列順)に1本ずつ消化する。resumeFirst は復元したrunningアイテム */
  private async consumeLoop(resumeFirst?: RenderQueueItem): Promise<void> {
    try {
      if (resumeFirst) {
        let cwd: string | null = null;
        try {
          cwd = this.resolveChannel(resumeFirst.dir);
        } catch {
          /* チャンネル消失 */
        }
        if (cwd === null) {
          this.finish(resumeFirst, 'failed', { reason: 'lost' });
        } else {
          await this.pollUntilDone(resumeFirst, cwd);
        }
      }
      for (;;) {
        const item = this.items.find((i) => i.status === 'waiting');
        if (!item) break;
        await this.runOne(item);
      }
    } finally {
      this.consuming = false;
      this.persist();
      this.emitUpdate();
    }
  }

  private async runOne(item: RenderQueueItem): Promise<void> {
    let cwd: string;
    try {
      cwd = this.resolveChannel(item.dir);
    } catch {
      this.finish(item, 'failed', { reason: 'invalid_dir' });
      return;
    }
    const outDir = path.join(cwd, 'episodes', item.epId, 'out');
    try {
      fs.mkdirSync(outDir, { recursive: true });
      // 前回レンダーの残骸を先に消す(スクリプト起動前の誤検知防止)
      fs.rmSync(this.statusPath(cwd, item.epId), { force: true });
    } catch {
      /* ignore */
    }
    item.status = 'running';
    item.startedAt = new Date().toISOString();
    try {
      const { pid } = this.spawnFn(
        'bash',
        ['scripts/render-episode.sh', `episodes/${item.epId}`, 'final'],
        { cwd, logPath: path.join(outDir, 'render-final.log') },
      );
      item.pid = pid;
    } catch {
      this.finish(item, 'failed', { reason: 'spawn_failed' });
      return;
    }
    this.persist();
    this.emitUpdate();
    await this.pollUntilDone(item, cwd);
  }

  private async pollUntilDone(item: RenderQueueItem, cwd: string): Promise<void> {
    const statusPath = this.statusPath(cwd, item.epId);
    let deadTicks = 0;
    for (;;) {
      await sleep(this.pollMs);
      if (item.status !== 'running') return; // キャンセル等で外部確定済み
      const st = readStatusFile(statusPath);
      if (st) {
        if (st.ok === true && st.qaExit === 0) {
          await this.applySuccess(item, cwd);
          this.finish(item, 'done', { durationSec: st.durationSec, qaExit: st.qaExit });
        } else {
          // 失敗時は episode.json を触らない(render_readyのまま → 修正後に再キューできる)
          this.finish(item, 'failed', {
            durationSec: st.durationSec,
            qaExit: st.qaExit,
            reason: st.reason ?? (st.qaExit !== undefined && st.qaExit !== 0 ? 'qa_failed' : 'render_failed'),
          });
        }
        return;
      }
      // ステータスファイル未出現のままプロセスも死んでいる → 2tick連続でfailed(キューのハング防止)
      if (item.pid === undefined || !this.aliveFn(item.pid)) {
        if (++deadTicks >= 2) {
          this.finish(item, 'failed', { reason: 'process_died' });
          return;
        }
      } else {
        deadTicks = 0;
      }
    }
  }

  /**
   * レンダー+QA成功時の機械的な完了処理。episode.json → final、metrics へ renderMinutes、
   * チャンネルリポジトリへ git commit。各段は失敗してもキューを止めない(ログのみ)。
   */
  private async applySuccess(item: RenderQueueItem, cwd: string): Promise<void> {
    try {
      const epJsonPath = path.join(cwd, 'episodes', item.epId, 'episode.json');
      const meta = JSON.parse(fs.readFileSync(epJsonPath, 'utf8')) as Record<string, unknown>;
      meta.status = 'final';
      fs.writeFileSync(epJsonPath, JSON.stringify(meta, null, 2) + '\n');
    } catch (e) {
      console.error(`render-queue: episode.json更新失敗 ${item.dir}/${item.epId}:`, e);
    }
    try {
      const sysPath = path.join(cwd, '.channel-system.json');
      const sys = JSON.parse(fs.readFileSync(sysPath, 'utf8')) as {
        metrics?: Array<Record<string, unknown>>;
      };
      const started = item.startedAt ? Date.parse(item.startedAt) : Date.now();
      const renderMinutes = Math.max(1, Math.round((Date.now() - started) / 60000));
      if (!Array.isArray(sys.metrics)) sys.metrics = [];
      const entry = sys.metrics.find((m) => m.episodeId === item.epId);
      if (entry) entry.renderMinutes = renderMinutes;
      else sys.metrics.push({ episodeId: item.epId, renderMinutes });
      fs.writeFileSync(sysPath, JSON.stringify(sys, null, 2) + '\n');
    } catch (e) {
      console.error(`render-queue: metrics更新失敗 ${item.dir}/${item.epId}:`, e);
    }
    try {
      await this.gitFn(cwd, ['add', '-A', `episodes/${item.epId}`, '.channel-system.json']);
      await this.gitFn(cwd, ['commit', '-m', `render(${item.epId}): final render + QA pass [factory-ui]`]);
    } catch (e) {
      console.error(`render-queue: git commit失敗 ${item.dir}/${item.epId}:`, e);
    }
  }

  private finish(
    item: RenderQueueItem,
    status: 'done' | 'failed' | 'canceled',
    extra: { durationSec?: number; qaExit?: number; reason?: string },
  ): void {
    item.status = status;
    item.finishedAt = new Date().toISOString();
    if (extra.durationSec !== undefined) item.durationSec = extra.durationSec;
    if (extra.qaExit !== undefined) item.qaExit = extra.qaExit;
    if (extra.reason !== undefined) item.reason = extra.reason;
    item.pid = undefined;
    this.persist();
    this.emitUpdate();
  }

  /** dir を検証してチャンネル絶対パスを返す(jobs.ts の resolveCwd と同じ封じ込め) */
  private resolveChannel(dir: string): string {
    if (!isSingleSegment(dir)) throw new Error(`invalid: bad channel dir: ${dir}`);
    const abs = path.resolve(this.root, dir);
    if (path.dirname(abs) !== this.root) throw new Error(`invalid: bad channel dir: ${dir}`);
    if (!fs.existsSync(path.join(abs, '.channel-system.json'))) {
      throw new Error(`unknown: not a channel dir: ${dir}`);
    }
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(this.root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new Error(`invalid: bad channel dir: ${dir}`);
    }
    return abs;
  }

  private statusPath(cwd: string, epId: string): string {
    return path.join(cwd, 'episodes', epId, 'out', '.render-status-final.json');
  }

  private queuePath(): string {
    return path.join(this.root, 'factory-ui', 'render-queue.json');
  }

  private persist(): void {
    const p = this.queuePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ items: this.items }, null, 2));
  }

  private emitUpdate(): void {
    this.emit('update', this.list());
  }
}

function isSingleSegment(s: string): boolean {
  if (s === '' || s === '.' || s === '..') return false;
  return !s.includes('/') && !s.includes('\\') && !s.includes(path.sep);
}

function readStatusFile(p: string): RenderStatusFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as RenderStatusFile;
  } catch {
    return null; // 不在 or 書き込み途中 → 次のtickで再試行
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
