import { describe, expect, it } from 'vitest';
import { retentionSummaryLines } from '../retention';

const curve = (pts: Array<[number, number]>) =>
  pts.map(([e, w]) => ({ elapsedRatio: e, watchRatio: w }));

describe('retentionSummaryLines', () => {
  it('通常カーブでイントロ指標・最大の離脱・最大の山を出す', () => {
    const lines = retentionSummaryLines({
      retentionCurve: curve([[0, 1], [0.05, 0.7], [0.5, 0.55], [0.55, 0.58], [1, 0.4]]),
      averageViewDuration: 300,
      averageViewPercentage: 50, // 実尺600秒 → 30秒 = elapsedRatio 0.05
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('イントロ指標(30秒地点): 維持率 70%');
    expect(lines[1]).toContain('最大の離脱: 動画の0%→5%地点(維持率 100%→70%)');
    expect(lines[2]).toContain('最大の山: 動画の50%→55%地点');
  });

  it('カーブが2点未満なら空配列', () => {
    expect(retentionSummaryLines({ retentionCurve: curve([[0, 1]]) })).toEqual([]);
    expect(retentionSummaryLines({})).toEqual([]);
  });

  it('平均視聴率が0/欠損ならイントロ指標を出さない(離脱行は出す)', () => {
    const lines = retentionSummaryLines({
      retentionCurve: curve([[0, 1], [0.5, 0.6], [1, 0.5]]),
      averageViewDuration: 120,
      averageViewPercentage: 0,
    });
    expect(lines.some((l) => l.startsWith('イントロ指標'))).toBe(false);
    expect(lines.some((l) => l.startsWith('最大の離脱'))).toBe(true);
  });

  it('逆算実尺が60秒未満ならイントロ指標を出さない(公式イントロ指標の対象は60秒以上)', () => {
    const lines = retentionSummaryLines({
      retentionCurve: curve([[0, 1], [0.5, 0.8], [1, 0.7]]),
      averageViewDuration: 30,
      averageViewPercentage: 60, // 実尺50秒
    });
    expect(lines.some((l) => l.startsWith('イントロ指標'))).toBe(false);
  });

  it('単調減少カーブでは山の行を出さない', () => {
    const lines = retentionSummaryLines({
      retentionCurve: curve([[0, 1], [0.5, 0.7], [1, 0.5]]),
    });
    expect(lines.some((l) => l.startsWith('最大の山'))).toBe(false);
  });

  it('30秒地点がカーブの格子点に無い場合は線形補間する', () => {
    const lines = retentionSummaryLines({
      retentionCurve: curve([[0, 1], [0.1, 0.6], [1, 0.5]]),
      averageViewDuration: 300,
      averageViewPercentage: 50, // 実尺600秒 → ratio 0.05 = [0,1]と[0.1,0.6]の中点 → 0.8
    });
    expect(lines[0]).toBe('イントロ指標(30秒地点): 維持率 80%');
  });
});
