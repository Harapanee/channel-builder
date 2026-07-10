import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pty from 'node-pty';
import type { SessionInfo } from '../shared/types';
import { RingBuffer } from './ringbuffer';

/** node-pty差し替え用の最小インターフェース(テストではFakeを注入する) */
export type PtyLike = {
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

export type SpawnFn = (
  args: string[],
  opts: { cwd: string; cols: number; rows: number },
) => PtyLike;

const SCROLLBACK_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

// PTYで起動するコマンドは claude 固定。引数は --continue の有無のみ(任意コマンド実行口を作らない)
const defaultSpawn: SpawnFn = (args, opts) =>
  pty.spawn('claude', args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: process.env as Record<string, string>,
  });

type Internal = {
  info: SessionInfo;
  pty: PtyLike;
  buf: RingBuffer;
  continueFlag: boolean;
  /** restartのたびに増える世代番号。旧世代PTYの遅延コールバックを無効化する */
  generation: number;
};

/**
 * claude CLIのPTYセッションを管理する。
 * emit: 'data'(id, chunk) / 'status'(SessionInfo)
 */
export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Internal>();

  private readonly root: string;

  constructor(
    root: string,
    private readonly spawnFn: SpawnFn = defaultSpawn,
  ) {
    super();
    this.root = path.resolve(root);
  }

  /** cwdは '' (=ファクトリールート) または root直下の実在ディレクトリ名。不正はthrow */
  create(opts: { cwd?: string; continue?: boolean } = {}): SessionInfo {
    const cwd = opts.cwd ?? '';
    const absCwd = this.resolveCwd(cwd);
    const id = randomUUID();
    const internal: Internal = {
      info: { id, cwd, status: 'running', createdAt: Date.now() },
      pty: null as unknown as PtyLike,
      buf: new RingBuffer(SCROLLBACK_MAX_BYTES),
      continueFlag: opts.continue === true,
      generation: 0,
    };
    this.sessions.set(id, internal);
    this.attachPty(internal, absCwd);
    this.emit('status', { ...internal.info });
    return { ...internal.info };
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }));
  }

  get(id: string): SessionInfo | undefined {
    const internal = this.sessions.get(id);
    return internal ? { ...internal.info } : undefined;
  }

  write(id: string, data: string): void {
    this.mustGet(id).pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.mustGet(id).pty.resize(cols, rows);
  }

  kill(id: string): void {
    const internal = this.mustGet(id);
    if (internal.info.status === 'running') {
      internal.pty.kill();
    }
  }

  /** 同id・同cwd・同フラグで再spawnする。スクロールバックはクリアされる */
  restart(id: string): SessionInfo {
    const internal = this.mustGet(id);
    internal.generation++; // 旧PTYのコールバックを即時無効化
    if (internal.info.status === 'running') {
      try {
        internal.pty.kill();
      } catch {
        // 旧PTYの停止失敗は無視(すでに死んでいる場合など)
      }
    }
    internal.buf = new RingBuffer(SCROLLBACK_MAX_BYTES);
    internal.info.status = 'running';
    delete internal.info.exitCode;
    this.attachPty(internal, this.resolveCwd(internal.info.cwd));
    this.emit('status', { ...internal.info });
    return { ...internal.info };
  }

  scrollback(id: string): string {
    return this.mustGet(id).buf.read();
  }

  private mustGet(id: string): Internal {
    const internal = this.sessions.get(id);
    if (!internal) throw new Error(`unknown session: ${id}`);
    return internal;
  }

  private resolveCwd(cwd: string): string {
    if (cwd === '') return this.root;
    if (
      path.isAbsolute(cwd) ||
      cwd.includes('/') ||
      cwd.includes(path.sep) ||
      cwd === '.' ||
      cwd === '..'
    ) {
      throw new Error(`invalid session cwd: ${cwd}`);
    }
    const abs = path.resolve(this.root, cwd);
    if (path.dirname(abs) !== this.root) {
      throw new Error(`invalid session cwd: ${cwd}`);
    }
    let stat: fs.Stats;
    let real: string;
    try {
      stat = fs.statSync(abs);
      real = fs.realpathSync(abs);
    } catch {
      throw new Error(`session cwd not found: ${cwd}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`session cwd is not a directory: ${cwd}`);
    }
    // シンボリックリンク経由でroot外のディレクトリをcwdにしない
    const realRoot = fs.realpathSync(this.root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new Error(`invalid session cwd: ${cwd}`);
    }
    return abs;
  }

  private attachPty(internal: Internal, absCwd: string): void {
    const gen = ++internal.generation;
    const args = internal.continueFlag ? ['--continue'] : [];
    const p = this.spawnFn(args, { cwd: absCwd, cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
    internal.pty = p;
    p.onData((d) => {
      if (internal.generation !== gen) return;
      internal.buf.push(d);
      this.emit('data', internal.info.id, d);
    });
    p.onExit(({ exitCode }) => {
      if (internal.generation !== gen) return;
      internal.info.status = 'exited';
      internal.info.exitCode = exitCode;
      this.emit('status', { ...internal.info });
    });
  }
}
