import type { BacklogCandidate } from '../shared/types';

/**
 * channel/backlog.md のランキング表から「状態=候補」の題材を抽出する。
 * 表形式(theme-scoutエージェントが管理): | 順位 | 題材 | ...採点列... | 計 | 状態 |
 * 先頭セルが正の整数の行だけをデータ行とみなす(ヘッダ・罫線は自然に除外される)。
 * パース不能な入力は空配列(UI側は候補リスト非表示になるだけで、起動は妨げない)。
 */
export function parseBacklog(md: string): BacklogCandidate[] {
  const out: BacklogCandidate[] = [];
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    const rank = Number(cells[0]);
    if (!Number.isInteger(rank) || rank <= 0) continue;
    const subject = cells[1] ?? '';
    const state = cells[cells.length - 1] ?? '';
    if (subject === '' || state !== '候補') continue;
    const score = Number(cells[cells.length - 2]);
    out.push({ rank, subject, score: Number.isFinite(score) ? score : 0 });
  }
  return out.sort((a, b) => a.rank - b.rank);
}
