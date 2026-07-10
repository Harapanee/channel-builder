import type { JobMode } from '../../shared/types';

/**
 * ステータス文字列 → 状態バッジ(`.badge`)の CSS クラス(ライトSaaS版トークン)。
 * DESIGN.md のマッピング: running=run、approved/final/succeeded=ok、
 * building/pilot_iterating/awaiting_gate(要対応)=warn、failed/cancelled/interrupted/exited=err。
 * 未知のステータスは色を付けず(`.badge` のニュートラル配色)、テキストラベルだけで示す。
 *
 * 全コンポーネントがこの関数に統一済み(旧 `.tally` クラス依存の `tallyClassFor` は Task 13 で廃止)。
 */
export function badgeClassFor(status: string | undefined): string {
  switch (status) {
    case 'approved':
    case 'final':
    case 'succeeded':
    case 'done':
      return 'badge ok';
    case 'queued':
    case 'building':
    case 'pilot_iterating':
    case 'awaiting_gate':
    case 'render_ready': // 承認済み・夜間レンダー待ち
    case 'waiting':      // レンダーキュー待機
      return 'badge warn';
    case 'running':
      return 'badge run';
    case 'failed':
    case 'cancelled':
    case 'canceled': // レンダーキューの中止
    case 'interrupted':
    case 'exited':
      return 'badge err';
    default:
      return 'badge';
  }
}

/** JobMode → 表示ラベル(色ではなくテキストで意味を伝える) */
export const JOB_MODE_LABEL: Record<JobMode, string> = {
  manual: '手動',
  semi: 'ハーフオート',
  auto: 'オート',
};
