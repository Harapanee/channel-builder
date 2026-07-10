import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSkills, extractDescription } from '../skills';

describe('extractDescription', () => {
  it('frontmatterのdescriptionの第1文を返す', () => {
    const md = '---\nname: video-create\ndescription: 新規エピソード動画を制作する。全工程を実行する。\n---\n本文';
    expect(extractDescription(md)).toBe('新規エピソード動画を制作する。');
  });
  it('frontmatterやdescriptionが無ければ空文字', () => {
    expect(extractDescription('本文のみ')).toBe('');
    expect(extractDescription('---\nname: x\n---\n')).toBe('');
  });
});

describe('listSkills', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-skills-'));
  });
  it('.claude/skills/*/SKILL.md を名前順に列挙する。無ければ空', async () => {
    expect(await listSkills(dir)).toEqual([]);
    for (const [name, desc] of [
      ['video-create', '動画を作る。詳細は略。'],
      ['theme-scout', 'ネタ帳を補充する。'],
    ]) {
      const p = path.join(dir, '.claude', 'skills', name!);
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n`);
    }
    expect(await listSkills(dir)).toEqual([
      { name: 'theme-scout', description: 'ネタ帳を補充する。' },
      { name: 'video-create', description: '動画を作る。' },
    ]);
  });
});
