import { EventEmitter } from 'node:events';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

export type FsUpdate = { dir: string; kind: 'system' | 'episode' | 'media' | 'images' };

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const IMAGE_ROOTS = new Set(['assets', 'episodes', 'scratchpad_gen']);
const DEBOUNCE_MS = 300;

/**
 * ファクトリールートからの相対パスを fs-update に分類する。監視対象外は null。
 * dir = チャンネルフォルダ名(ルート直下)。factory-ui / docs / 隠しディレクトリは対象外。
 */
export function classify(rel: string): FsUpdate | null {
  const parts = rel.split(path.sep);
  if (parts.length < 2) return null;
  const dir = parts[0]!;
  if (dir.startsWith('.') || dir === 'factory-ui' || dir === 'docs') return null;
  if (parts.some((p) => p === 'node_modules' || p === '.git')) return null;

  const rest = parts.slice(1);
  if (rest.length === 1 && rest[0] === '.channel-system.json') return { dir, kind: 'system' };

  const ext = path.extname(rel).toLowerCase();
  if (rest[0] === 'episodes' && rest.length >= 3) {
    if (rest.length === 3 && rest[2] === 'episode.json') return { dir, kind: 'episode' };
    if (rest[2] === 'out' && ext === '.mp4') return { dir, kind: 'media' };
    if (rest[2] === 'review') return { dir, kind: 'media' };
  }
  if (IMAGE_EXTS.has(ext) && IMAGE_ROOTS.has(rest[0]!)) return { dir, kind: 'images' };
  return null;
}

/**
 * chokidarでファクトリールートを監視し、'fs-update' イベント({dir, kind})を発行する。
 * 300ms debounceで (dir, kind) 単位に集約する。
 */
export class FactoryWatcher extends EventEmitter {
  private readonly watcher: FSWatcher;
  private readonly pending = new Map<string, FsUpdate>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly root: string) {
    super();
    this.watcher = chokidar.watch(root, {
      ignored: (p) =>
        p.includes(`${path.sep}node_modules`) ||
        p.includes(`${path.sep}.git`) ||
        p.includes(`${path.sep}factory-ui${path.sep}`) ||
        p.endsWith(`${path.sep}factory-ui`),
      ignoreInitial: true,
      depth: 6,
    });
    const handle = (p: string) => this.handle(p);
    this.watcher.on('add', handle).on('change', handle).on('unlink', handle);
  }

  private handle(absPath: string): void {
    const update = classify(path.relative(this.root, absPath));
    if (!update) return;
    this.pending.set(`${update.dir}|${update.kind}`, update);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const updates = [...this.pending.values()];
      this.pending.clear();
      for (const u of updates) this.emit('fs-update', u);
    }, DEBOUNCE_MS);
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.watcher.close();
  }
}

export function createWatcher(root: string): FactoryWatcher {
  return new FactoryWatcher(root);
}
