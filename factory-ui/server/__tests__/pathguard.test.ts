import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safeResolve } from '../pathguard';

describe('safeResolve', () => {
  let root: string;

  beforeEach(async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pathguard-'));
    // realpath でシンボリックリンク(/tmp→/private/tmp 等)を正規化しておく
    root = await fs.realpath(tmp);

    await fs.mkdir(path.join(root, 'a'), { recursive: true });
    await fs.writeFile(path.join(root, 'a', 'b.md'), 'hi');

    await fs.writeFile(path.join(root, '.env'), 'SECRET=1');
    await fs.writeFile(path.join(root, '.env.local'), 'SECRET=2');

    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await fs.writeFile(path.join(root, '.git', 'config'), '[core]');

    await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), '//');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('通常ファイルは絶対パスを返す', async () => {
    const resolved = await safeResolve(root, 'a/b.md');
    expect(resolved).toBe(path.join(root, 'a', 'b.md'));
  });

  it('.. でのroot脱出はnull', async () => {
    expect(await safeResolve(root, '../outside.txt')).toBeNull();
    expect(await safeResolve(root, '../../etc/hosts')).toBeNull();
    expect(await safeResolve(root, 'a/../../outside.txt')).toBeNull();
  });

  it('シンボリックリンク経由の脱出はnull', async () => {
    const outsideTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'));
    const outside = await fs.realpath(outsideTmp);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'x');
    await fs.symlink(outside, path.join(root, 'link'));
    try {
      expect(await safeResolve(root, 'link/secret.txt')).toBeNull();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('.envはnull、.env.localもnull', async () => {
    expect(await safeResolve(root, '.env')).toBeNull();
    expect(await safeResolve(root, '.env.local')).toBeNull();
  });

  it('.git配下・node_modules配下はnull', async () => {
    expect(await safeResolve(root, '.git/config')).toBeNull();
    expect(await safeResolve(root, 'node_modules/pkg/index.js')).toBeNull();
  });

  it('存在しないパスはnull', async () => {
    expect(await safeResolve(root, 'a/does-not-exist.md')).toBeNull();
  });

  it('root内シンボリックリンク→root内の.envはnull(realpath後再チェックの回帰ガード)', async () => {
    // リンク自体もリンク先もroot内だが、実体は禁止対象の .env
    await fs.symlink(path.join(root, '.env'), path.join(root, 'link-env'));
    expect(await safeResolve(root, 'link-env')).toBeNull();
  });

  it('.ENV/.GIT/NODE_MODULESなどcase変種はnull', async () => {
    // 実体がcase変種名で存在するケース(realpathのcase正規化には頼れない)
    await fs.mkdir(path.join(root, 'sub'), { recursive: true });
    await fs.writeFile(path.join(root, 'sub', '.ENV'), 'X');
    await fs.mkdir(path.join(root, 'a', '.GIT'), { recursive: true });
    await fs.writeFile(path.join(root, 'a', '.GIT', 'config'), 'X');
    await fs.mkdir(path.join(root, 'a', 'NODE_MODULES'), { recursive: true });
    await fs.writeFile(path.join(root, 'a', 'NODE_MODULES', 'x.js'), '//');

    expect(await safeResolve(root, 'sub/.ENV')).toBeNull();
    expect(await safeResolve(root, 'a/.GIT/config')).toBeNull();
    expect(await safeResolve(root, 'a/NODE_MODULES/x.js')).toBeNull();

    // リクエスト側だけがcase変種のケース(実体は .env / .git)も null
    expect(await safeResolve(root, '.ENV')).toBeNull();
    expect(await safeResolve(root, '.GIT/config')).toBeNull();
  });

  it('隣接ディレクトリprefix攻撃(root=yt に対する yt-evil)はnull', async () => {
    const baseTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adj-'));
    const base = await fs.realpath(baseTmp);
    const yt = path.join(base, 'yt');
    const evil = path.join(base, 'yt-evil');
    await fs.mkdir(yt, { recursive: true });
    await fs.mkdir(evil, { recursive: true });
    await fs.writeFile(path.join(evil, 'file.txt'), 'leak');
    await fs.symlink(path.join(evil, 'file.txt'), path.join(yt, 'leak'));
    try {
      expect(await safeResolve(yt, 'leak')).toBeNull();
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it("rel='' はroot自身の実体パスを返す(仕様固定)", async () => {
    // root は beforeEach で realpath 済みなのでそのまま一致する
    expect(await safeResolve(root, '')).toBe(root);
  });
});
