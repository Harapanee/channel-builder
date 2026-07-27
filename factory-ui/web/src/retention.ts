import type { RetentionPoint } from '../../shared/types';

const pct = (x: number) => Math.round(x * 100);

/** 平均視聴時間(秒)と平均視聴率(%)から動画実尺(秒)を逆算する。逆算不能ならnull。 */
function estimateDurationSec(avgViewDurationSec?: number, avgViewPercentage?: number): number | null {
  if (!avgViewDurationSec || !avgViewPercentage || avgViewPercentage <= 0) return null;
  return avgViewDurationSec / (avgViewPercentage / 100);
}

/** カーブ上の任意の elapsedRatio 地点の watchRatio を線形補間で求める(範囲外はnull)。 */
function watchRatioAt(curve: RetentionPoint[], ratio: number): number | null {
  if (curve.length < 2) return null;
  if (ratio <= curve[0].elapsedRatio) return curve[0].watchRatio;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (ratio <= b.elapsedRatio) {
      const span = b.elapsedRatio - a.elapsedRatio;
      if (span <= 0) return b.watchRatio;
      return a.watchRatio + ((b.watchRatio - a.watchRatio) * (ratio - a.elapsedRatio)) / span;
    }
  }
  return null;
}

/**
 * 維持率カーブの1行要約群(0〜3行。チャートは描かない — DESIGN.mdの情報密度方針)。
 * - イントロ指標: 30秒地点の維持率(YouTube公式の計測窓。対象は実尺60秒以上)
 * - 最大の離脱: 隣接区間の最大落差(公式リテンション分析のディップ)
 * - 最大の山: 隣接区間の最大上昇(同スパイク=再視聴・共有の兆候)
 */
export function retentionSummaryLines(input: {
  retentionCurve?: RetentionPoint[];
  averageViewDuration?: number;
  averageViewPercentage?: number;
}): string[] {
  const curve = input.retentionCurve;
  if (!curve || curve.length < 2) return [];
  const lines: string[] = [];

  const duration = estimateDurationSec(input.averageViewDuration, input.averageViewPercentage);
  if (duration !== null && duration >= 60) {
    const intro = watchRatioAt(curve, 30 / duration);
    if (intro !== null) lines.push(`イントロ指標(30秒地点): 維持率 ${pct(intro)}%`);
  }

  let maxDrop = 0;
  let dropSeg: [RetentionPoint, RetentionPoint] | null = null;
  let maxRise = 0;
  let riseSeg: [RetentionPoint, RetentionPoint] | null = null;
  for (let i = 1; i < curve.length; i++) {
    const diff = curve[i].watchRatio - curve[i - 1].watchRatio;
    if (-diff > maxDrop) {
      maxDrop = -diff;
      dropSeg = [curve[i - 1], curve[i]];
    }
    if (diff > maxRise) {
      maxRise = diff;
      riseSeg = [curve[i - 1], curve[i]];
    }
  }
  if (dropSeg) {
    lines.push(
      `最大の離脱: 動画の${pct(dropSeg[0].elapsedRatio)}%→${pct(dropSeg[1].elapsedRatio)}%地点(維持率 ${pct(dropSeg[0].watchRatio)}%→${pct(dropSeg[1].watchRatio)}%)`,
    );
  }
  if (riseSeg) {
    lines.push(
      `最大の山: 動画の${pct(riseSeg[0].elapsedRatio)}%→${pct(riseSeg[1].elapsedRatio)}%地点(維持率 ${pct(riseSeg[0].watchRatio)}%→${pct(riseSeg[1].watchRatio)}% — 再視聴・共有の兆候)`,
    );
  }
  return lines;
}
