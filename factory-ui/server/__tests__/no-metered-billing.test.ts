import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 制約(spec §2, §10): Anthropic API 従量課金を使わない。
// サーバー/フロント/共有コードに api.anthropic.com / ANTHROPIC_API_KEY への参照が無いこと、
// ジョブ/ターミナルの起動は `claude` CLI のみ、を退行防止として固定する。
const here = path.dirname(fileURLToPath(import.meta.url));
const factoryUi = path.resolve(here, '..', '..');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'jobs', '.git', 'spike'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !e.name.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

describe('従量課金なしの固定', () => {
  const files = [
    ...walk(path.join(factoryUi, 'server')),
    ...walk(path.join(factoryUi, 'web', 'src')),
    ...walk(path.join(factoryUi, 'shared')),
  ];

  it('api.anthropic.com への参照が無い', () => {
    const hits = files.filter((f) => fs.readFileSync(f, 'utf8').includes('api.anthropic.com'));
    expect(hits).toEqual([]);
  });

  it('ANTHROPIC_API_KEY への参照が無い', () => {
    const hits = files.filter((f) => fs.readFileSync(f, 'utf8').includes('ANTHROPIC_API_KEY'));
    expect(hits).toEqual([]);
  });

  it('プロセス起動は claude と npm(Remotion Studio)のみ', () => {
    const spawnCalls: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\.spawn\(\s*['"]([^'"]+)['"]/g)) spawnCalls.push(m[1]!);
      for (const m of src.matchAll(/\bspawn\(\s*['"]([^'"]+)['"]/g)) spawnCalls.push(m[1]!);
    }
    // npm は studio.ts の `npm run studio`(Remotion Studio起動)のみ。API課金とは無関係
    const allowed = new Set(['claude', 'npm']);
    const unexpected = spawnCalls.filter((c) => !allowed.has(c));
    expect(unexpected).toEqual([]);
  });
});
