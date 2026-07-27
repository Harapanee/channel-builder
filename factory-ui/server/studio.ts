import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * render-check(レンダー前の目視確認)向けの Remotion Studio 常駐管理。
 * 同時に1チャンネル分だけ `npm run studio -- --port 4710 --no-open` を起動し、
 * HTTP疎通を確認してからURLを返す。ゲート応答時に stopIfDir で自動停止する。
 */

export const STUDIO_PORT = 4710;
export const STUDIO_URL = `http://127.0.0.1:${STUDIO_PORT}`;

export type StudioProc = {
  kill(): void;
  onExit(fn: (code: number | null) => void): void;
};

export type StudioSpawn = (cwd: string, targetDir?: string, engine?: string) => StudioProc;

/** チャンネルの .channel-system.json から renderEngine を読む。読めなければ remotion 扱い。 */
export function readRenderEngine(channelPath: string): string {
  try {
    const raw = readFileSync(path.join(channelPath, '.channel-system.json'), 'utf8');
    const engine = JSON.parse(raw)?.renderEngine;
    return typeof engine === 'string' && engine ? engine : 'remotion';
  } catch {
    return 'remotion';
  }
}

export type StudioStatus =
  | { running: false }
  | { running: true; dir: string; url: string; status: 'starting' | 'ready' };

const defaultSpawn: StudioSpawn = (cwd, targetDir, engine) => {
  let args: string[];
  if (engine === 'hyperframes') {
    // HyperFramesはRemotion Studioを持たない。プレビューサーバーを同ポートで起動する。
    // devスクリプト経由ならチャンネルが固定したhyperframesバージョンをそのまま使える
    const hasDev = (() => {
      try {
        const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
        return typeof pkg?.scripts?.dev === 'string';
      } catch {
        return false;
      }
    })();
    args = hasDev
      ? ['run', 'dev', '--', `--port=${STUDIO_PORT}`, '--no-open']
      : ['exec', '--yes', 'hyperframes', 'preview', '--', `--port=${STUDIO_PORT}`, '--no-open'];
  } else {
    args = ['run', 'studio', '--', `--port=${STUDIO_PORT}`, '--no-open'];
    // 対象(episodes/<id> または shorts/<id>)を開く(Rootのdefaultはep000-testのため、propsで上書きする)
    if (targetDir) args.push(`--props=${JSON.stringify({ episodeDir: targetDir })}`);
  }
  const p = spawn('npm', args, {
    cwd,
    stdio: 'ignore',
    detached: false,
  });
  return {
    kill: () => p.kill('SIGTERM'),
    onExit: (fn) => p.on('exit', fn),
  };
};

const defaultProbe = async (): Promise<boolean> => {
  try {
    const res = await fetch(STUDIO_URL, { signal: AbortSignal.timeout(2000) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
};

type Current = { dir: string; targetDir?: string; proc: StudioProc; status: 'starting' | 'ready' };

/** ポート4710の占有プロセスをkillする(サーバー再起動で孤児化した旧studio対策)。 */
const defaultKillPort = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    execFile('lsof', ['-ti', `tcp:${STUDIO_PORT}`], (err, stdout) => {
      const pids = stdout.trim().split('\n').filter(Boolean).map(Number);
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // 既に死んでいれば無視
        }
      }
      resolve();
    });
  });
};

export class StudioManager {
  private current: Current | null = null;
  private readonly spawnFn: StudioSpawn;
  private readonly probe: () => Promise<boolean>;
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly killPort: () => Promise<void>;
  private readonly engineOf: (dir: string) => string;

  constructor(
    private readonly root: string,
    opts?: {
      spawnFn?: StudioSpawn;
      probe?: () => Promise<boolean>;
      probeIntervalMs?: number;
      probeTimeoutMs?: number;
      killPort?: () => Promise<void>;
      engineOf?: (dir: string) => string;
    },
  ) {
    this.spawnFn = opts?.spawnFn ?? defaultSpawn;
    this.engineOf = opts?.engineOf ?? ((dir) => readRenderEngine(path.join(this.root, dir)));
    this.probe = opts?.probe ?? defaultProbe;
    this.killPort = opts?.killPort ?? defaultKillPort;
    this.probeIntervalMs = opts?.probeIntervalMs ?? 500;
    this.probeTimeoutMs = opts?.probeTimeoutMs ?? 60_000;
  }

  status(): StudioStatus {
    if (!this.current) return { running: false };
    return { running: true, dir: this.current.dir, url: STUDIO_URL, status: this.current.status };
  }

  /** 起動して疎通確認後にURLを返す。同一dir+同一対象でreadyなら即返す(冪等)。 */
  async start(dir: string, targetDir?: string): Promise<string> {
    const engine = this.engineOf(dir);
    // Remotionのみ、URLにコンポジションIDを含めて対象のコンポジションを開く(HyperFramesは単一エントリ)
    const url =
      engine === 'hyperframes'
        ? STUDIO_URL
        : targetDir?.startsWith('shorts/')
          ? `${STUDIO_URL}/Short`
          : `${STUDIO_URL}/Episode`;
    const same = this.current?.dir === dir && this.current?.targetDir === targetDir;
    if (same && this.current!.status === 'ready') return url;
    if (this.current && !same) this.stop();
    if (!this.current) {
      // 4710に管理外のstudio(サーバー再起動前の孤児など)が残っていると、疎通確認が
      // それに成功して「別エピソードを開いたstudio」を返してしまう。先に排除する
      if (await this.probe()) {
        await this.killPort();
        // ポート解放を待ってからspawn(解放前に起動するとbind失敗でタイムアウトする)。
        // 解放されないまま待ち切ったら、そのままspawnして通常のタイムアウト経路に任せる
        const freeDeadline = Date.now() + Math.min(10_000, this.probeTimeoutMs);
        while ((await this.probe()) && Date.now() < freeDeadline) {
          await new Promise((r) => setTimeout(r, this.probeIntervalMs));
        }
      }
      const proc = this.spawnFn(path.join(this.root, dir), targetDir, engine);
      const cur: Current = { dir, targetDir, proc, status: 'starting' };
      this.current = cur;
      // kill以外の自然死(クラッシュ等)でも状態を残さない
      proc.onExit(() => {
        if (this.current === cur) this.current = null;
      });
    }
    const cur = this.current;
    const deadline = Date.now() + this.probeTimeoutMs;
    while (Date.now() < deadline) {
      if (this.current !== cur) throw new Error('studio was stopped or replaced during startup');
      if (await this.probe()) {
        cur.status = 'ready';
        return url;
      }
      await new Promise((r) => setTimeout(r, this.probeIntervalMs));
    }
    this.stop();
    throw new Error(
      `studio did not respond on port ${STUDIO_PORT} (studioスクリプトの有無とポート${STUDIO_PORT}の空きを確認してください)`,
    );
  }

  stop(): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null; // exitハンドラより先にクリア(kill→exitの二重処理を避ける)
    cur.proc.kill();
  }

  /** 該当チャンネルで稼働中のときだけ止める(ゲート応答時の自動停止用)。 */
  stopIfDir(dir: string): void {
    if (this.current?.dir === dir) this.stop();
  }
}
