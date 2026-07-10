import { describe, expect, it, vi } from 'vitest';
import { StudioManager, type StudioSpawn } from '../studio';

/** kill を記録するフェイクプロセス */
function fakeProc() {
  const listeners: Array<(code: number | null) => void> = [];
  return {
    killed: false,
    kill() {
      this.killed = true;
      // 実プロセス同様、kill後にexitが飛ぶ
      listeners.forEach((fn) => fn(null));
    },
    onExit(fn: (code: number | null) => void) {
      listeners.push(fn);
    },
    /** テストから自然死をシミュレートする */
    die() {
      listeners.forEach((fn) => fn(1));
    },
  };
}

function manager(overrides?: {
  probe?: () => Promise<boolean>;
  spawnFn?: StudioSpawn;
  killPort?: () => Promise<void>;
}) {
  const procs: ReturnType<typeof fakeProc>[] = [];
  const spawnFn: StudioSpawn =
    overrides?.spawnFn ??
    ((_cwd) => {
      const p = fakeProc();
      procs.push(p);
      return p;
    });
  const m = new StudioManager('/factory', {
    spawnFn,
    probe: overrides?.probe ?? (async () => true),
    probeIntervalMs: 1,
    probeTimeoutMs: 100,
    killPort: overrides?.killPort ?? (async () => {}),
  });
  return { m, procs };
}

describe('StudioManager', () => {
  it('start で spawn し、疎通確認後に URL を返して ready になる', async () => {
    const { m, procs } = manager();
    const url = await m.start('ch1');
    expect(url).toBe('http://127.0.0.1:4710');
    expect(procs).toHaveLength(1);
    expect(m.status()).toEqual({ running: true, dir: 'ch1', url, status: 'ready' });
  });

  it('同一dirで再startしても新プロセスを起動しない(冪等)', async () => {
    const { m, procs } = manager();
    await m.start('ch1');
    await m.start('ch1');
    expect(procs).toHaveLength(1);
  });

  it('別dirでstartすると既存をkillして起動し直す', async () => {
    const { m, procs } = manager();
    await m.start('ch1');
    await m.start('ch2');
    expect(procs).toHaveLength(2);
    expect(procs[0].killed).toBe(true);
    expect(m.status()).toMatchObject({ running: true, dir: 'ch2' });
  });

  it('stop でkillして状態をクリアする', async () => {
    const { m, procs } = manager();
    await m.start('ch1');
    m.stop();
    expect(procs[0].killed).toBe(true);
    expect(m.status()).toEqual({ running: false });
  });

  it('stopIfDir は該当dirのときだけ止める', async () => {
    const { m, procs } = manager();
    await m.start('ch1');
    m.stopIfDir('other');
    expect(procs[0].killed).toBe(false);
    m.stopIfDir('ch1');
    expect(procs[0].killed).toBe(true);
  });

  it('疎通がタイムアウトしたらkillしてthrowする', async () => {
    const { m, procs } = manager({ probe: async () => false });
    await expect(m.start('ch1')).rejects.toThrow(/4710/);
    expect(procs[0].killed).toBe(true);
    expect(m.status()).toEqual({ running: false });
  });

  it('プロセスが自然死したら状態をクリアする', async () => {
    const { m, procs } = manager();
    await m.start('ch1');
    procs[0].die();
    expect(m.status()).toEqual({ running: false });
  });

  it('spawnFn には チャンネル絶対パスと episodeId が渡る', async () => {
    const spawnFn = vi.fn((_cwd: string, _episodeId?: string) => fakeProc());
    const { m } = manager({ spawnFn });
    await m.start('ch1', 'ep010-cleopatra');
    expect(spawnFn).toHaveBeenCalledWith('/factory/ch1', 'ep010-cleopatra');
  });

  it('管理外プロセスが4710を占有していたら排除してから起動する', async () => {
    // 最初のprobe=true(占有中)、killPort後はfalse(解放)、spawn後はtrue(新studio)
    let killCalled = 0;
    let occupied = true;
    let spawned = false;
    const { m, procs } = manager({
      probe: async () => (spawned ? true : occupied),
      killPort: async () => {
        killCalled++;
        occupied = false;
      },
      spawnFn: () => {
        spawned = true;
        return fakeProc();
      },
    });
    await m.start('ch1');
    expect(killCalled).toBe(1);
    expect(m.status()).toMatchObject({ running: true, status: 'ready' });
    expect(procs).toHaveLength(0); // 独自spawnFnを使ったのでmanager既定のprocsは空
  });

  it('同一dirでもエピソードが違えば起動し直す', async () => {
    const { m, procs } = manager();
    await m.start('ch1', 'ep010');
    await m.start('ch1', 'ep011');
    expect(procs).toHaveLength(2);
    expect(procs[0].killed).toBe(true);
    await m.start('ch1', 'ep011'); // 同一エピソードは冪等
    expect(procs).toHaveLength(2);
  });
});
