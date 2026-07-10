import { describe, it, expect } from 'vitest';
import { parseBacklog } from '../backlog';

const MD = `# ネタ帳(題材バックログ)
最終更新: 2026-07-08

| 順位 | 題材 | 認知 | 最悪密度 | 誤解破壊 | 多様 | 計 | 状態 |
|---|---|---|---|---|---|---|---|
| 1 | マンボウ | 9 | 9 | 10 | 9 | 37 | 制作中(ep001-mola) |
| 2 | チョウチンアンコウ | 7 | 9 | 9 | 9 | 34 | 候補 |
| 3 | コウテイペンギン | 9 | 9 | 8 | 8 | 34 | 候補 |

## 候補メモ
`;

describe('parseBacklog', () => {
  it('状態=候補の行だけを順位昇順で返す(制作中・済は除外)', () => {
    expect(parseBacklog(MD)).toEqual([
      { rank: 2, subject: 'チョウチンアンコウ', score: 34 },
      { rank: 3, subject: 'コウテイペンギン', score: 34 },
    ]);
  });
  it('表が無い・壊れているmdは空配列', () => {
    expect(parseBacklog('# 何もない')).toEqual([]);
    expect(parseBacklog('| ヘッダだけ |')).toEqual([]);
  });
});
