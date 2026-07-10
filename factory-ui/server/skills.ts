import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SkillInfo } from '../shared/types';

/**
 * チャンネルの .claude/skills/<name>/SKILL.md から、ターミナルヒント用の
 * 「スキル名+説明の第1文」を名前順で返す。ディレクトリ不在・SKILL.md不在はスキップ。
 */
export async function listSkills(channelDir: string): Promise<SkillInfo[]> {
  const skillsDir = path.join(channelDir, '.claude', 'skills');
  let names: string[];
  try {
    names = await fsp.readdir(skillsDir);
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const name of names.sort()) {
    try {
      const md = await fsp.readFile(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
      const description = extractDescription(md);
      if (description !== '') out.push({ name, description });
    } catch {
      /* SKILL.md の無いフォルダはスキップ */
    }
  }
  return out;
}

/** frontmatter(--- ... ---)の description: 行から第1文(。まで)を取り出す */
export function extractDescription(md: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return '';
  const line = m[1]!.split('\n').find((l) => l.trimStart().startsWith('description:'));
  if (!line) return '';
  const full = line.slice(line.indexOf('description:') + 'description:'.length).trim();
  if (full === '') return '';
  const first = full.split('。')[0]!;
  return first === full ? full : first + '。';
}
