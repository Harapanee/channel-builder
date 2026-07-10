import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionInfo } from '../../shared/types';
import { SessionManager, type PtyLike, type SpawnFn } from '../sessions';

class FakePty implements PtyLike {
  dataCb?: (d: string) => void;
  exitCb?: (e: { exitCode: number }) => void;
  written: string[] = [];
  resized: Array<{ cols: number; rows: number }> = [];
  killed = false;
  onData(cb: (d: string) => void) { this.dataCb = cb; }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitCb = cb; }
  write(d: string) { this.written.push(d); }
  resize(cols: number, rows: number) { this.resized.push({ cols, rows }); }
  kill() { this.killed = true; this.exitCb?.({ exitCode: 0 }); }
  emitData(d: string) { this.dataCb?.(d); }
  emitExit(exitCode: number) { this.exitCb?.({ exitCode }); }
}

describe('SessionManager', () => {
  let root: string;
  let ptys: FakePty[];
  let spawnCalls: Array<{ args: string[]; opts: { cwd: string; cols: number; rows: number } }>;
  let spawnFn: SpawnFn;
  let m: SessionManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-sess-'));
    fs.mkdirSync(path.join(root, 'ch1'));
    ptys = [];
    spawnCalls = [];
    spawnFn = (args, opts) => {
      const p = new FakePty();
      ptys.push(p);
      spawnCalls.push({ args, opts });
      return p;
    };
    m = new SessionManager(root, spawnFn);
  });

  it('createはrunningのセッションを返し、cwdは相対のまま・spawnには絶対cwdを渡す', () => {
    const s = m.create({ cwd: 'ch1' });
    expect(s.status).toBe('running');
    expect(s.cwd).toBe('ch1');
    expect(spawnCalls[0]!.opts.cwd).toBe(path.join(root, 'ch1'));
    expect(m.list().map((x) => x.id)).toContain(s.id);
  });

  it("cwd '' はファクトリールートで起動する(省略時も同じ)", () => {
    m.create({ cwd: '' });
    m.create({});
    expect(spawnCalls[0]!.opts.cwd).toBe(root);
    expect(spawnCalls[1]!.opts.cwd).toBe(root);
  });

  it('continue指定で引数に--continueが付き、未指定なら引数なし', () => {
    m.create({ cwd: '', continue: true });
    m.create({ cwd: '' });
    expect(spawnCalls[0]!.args).toEqual(['--continue']);
    expect(spawnCalls[1]!.args).toEqual([]);
  });

  it('不正なcwd(親方向・不在・絶対パス・区切り文字入り)はthrow', () => {
    expect(() => m.create({ cwd: '../etc' })).toThrow();
    expect(() => m.create({ cwd: 'nope' })).toThrow();
    expect(() => m.create({ cwd: '/tmp' })).toThrow();
    expect(() => m.create({ cwd: 'ch1/sub' })).toThrow();
    expect(spawnCalls.length).toBe(0);
  });

  it('ptyの出力はdataイベントで流れ、scrollbackに蓄積される', () => {
    const s = m.create({ cwd: '' });
    const got: string[] = [];
    m.on('data', (id: string, chunk: string) => got.push(`${id}:${chunk}`));
    ptys[0]!.emitData('hello');
    ptys[0]!.emitData(' world');
    expect(got).toEqual([`${s.id}:hello`, `${s.id}: world`]);
    expect(m.scrollback(s.id)).toBe('hello world');
  });

  it('スクロールバックは2MB上限で古い分から破棄される', () => {
    const s = m.create({ cwd: '' });
    const mb = 'x'.repeat(1024 * 1024);
    ptys[0]!.emitData(mb);
    ptys[0]!.emitData(mb);
    ptys[0]!.emitData(mb);
    expect(Buffer.byteLength(m.scrollback(s.id))).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(m.scrollback(s.id).length).toBeGreaterThan(0);
  });

  it('exitでstatus=exited/exitCodeが記録され、statusイベントが飛ぶ', () => {
    const s = m.create({ cwd: '' });
    const events: SessionInfo[] = [];
    m.on('status', (info: SessionInfo) => events.push({ ...info }));
    ptys[0]!.emitExit(3);
    expect(m.get(s.id)!.status).toBe('exited');
    expect(m.get(s.id)!.exitCode).toBe(3);
    expect(events.at(-1)!.status).toBe('exited');
    expect(events.at(-1)!.exitCode).toBe(3);
  });

  it('writeとresizeがptyへ届く', () => {
    const s = m.create({ cwd: '' });
    m.write(s.id, 'ls\r');
    m.resize(s.id, 120, 40);
    expect(ptys[0]!.written).toEqual(['ls\r']);
    expect(ptys[0]!.resized).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('killでptyが殺されexitedになる', () => {
    const s = m.create({ cwd: '' });
    m.kill(s.id);
    expect(ptys[0]!.killed).toBe(true);
    expect(m.get(s.id)!.status).toBe('exited');
  });

  it('restartは同idのまま新ptyでrunningに戻り、同cwd・同フラグで再spawnし、スクロールバックはクリアされる', () => {
    const s = m.create({ cwd: 'ch1', continue: true });
    ptys[0]!.emitData('old output');
    ptys[0]!.emitExit(1);
    const s2 = m.restart(s.id);
    expect(s2.id).toBe(s.id);
    expect(s2.status).toBe('running');
    expect(ptys.length).toBe(2);
    expect(spawnCalls[1]!.args).toEqual(['--continue']);
    expect(spawnCalls[1]!.opts.cwd).toBe(path.join(root, 'ch1'));
    expect(m.scrollback(s.id)).toBe('');
    ptys[1]!.emitData('new');
    expect(m.scrollback(s.id)).toBe('new');
  });

  it('稼働中のセッションをrestartすると旧ptyはkillされる', () => {
    const s = m.create({ cwd: '' });
    m.restart(s.id);
    expect(ptys[0]!.killed).toBe(true);
    expect(m.get(s.id)!.status).toBe('running');
  });

  it('存在しないidへのwrite/resize/kill/restart/scrollbackはthrow', () => {
    expect(() => m.write('zzz', 'x')).toThrow();
    expect(() => m.resize('zzz', 80, 24)).toThrow();
    expect(() => m.kill('zzz')).toThrow();
    expect(() => m.restart('zzz')).toThrow();
    expect(() => m.scrollback('zzz')).toThrow();
  });

  it('root外を指すシンボリックリンクのcwdはthrow', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-out-'));
    fs.symlinkSync(outside, path.join(root, 'evil'));
    expect(() => m.create({ cwd: 'evil' })).toThrow();
    expect(spawnCalls.length).toBe(0);
  });

  it('createはstatusイベント(running)を発行する', () => {
    const events: SessionInfo[] = [];
    m.on('status', (info: SessionInfo) => events.push({ ...info }));
    const s = m.create({ cwd: '' });
    expect(events.length).toBe(1);
    expect(events[0]!.id).toBe(s.id);
    expect(events[0]!.status).toBe('running');
  });

  it('exit後の旧ptyからの遅延データはscrollbackに入らない(restart後の混線防止)', () => {
    const s = m.create({ cwd: '' });
    const old = ptys[0]!;
    old.emitExit(0);
    m.restart(s.id);
    old.emitData('ghost');
    expect(m.scrollback(s.id)).toBe('');
  });
});
