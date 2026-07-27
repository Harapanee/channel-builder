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

/**
 * エピソード/ショート/チャンネル/レンダーキューのステータス → 日本語ラベル。
 * 語彙の正: episode は server/progress.ts の STATUS_DONE_COUNT、short は SHORT_STATUS_DONE_COUNT、
 * チャンネルは .channel-system.json の status(building/pilot_iterating/approved)。
 * ジョブ(JobStatus)は JobDetail.tsx の JOB_STATUS_LABEL が既に担っているが、
 * ここにも同義を持たせて全画面がこの1関数で日本語化できるようにする。
 */
const STATUS_LABEL: Record<string, string> = {
  // episode(video-create工程)
  researched: '調査済み',
  scripted: '台本済み',
  voiced: '音声済み',
  storyboarded: '絵コンテ済み',
  implemented: '実装済み',
  prechecked: '検査済み',
  qa_passed: 'QA合格',
  reviewed: 'レビュー済み',
  packaged: '公開準備済み',
  render_ready: 'レンダー待ち',
  final: '完成',
  approved: '承認済み',
  // short(short-create工程)
  script_approved: '台本承認済み',
  studio_checked: 'Studio確認済み',
  rendered: 'レンダー済み',
  // チャンネル
  building: '構築中',
  pilot_iterating: 'Pilot改善中',
  // ジョブ・レンダーキュー
  queued: 'キュー待ち',
  waiting: '待機中',
  running: '実行中',
  awaiting_gate: '要対応',
  succeeded: '成功',
  done: '完了',
  failed: '失敗',
  cancelled: '中止',
  canceled: '中止',
  interrupted: '中断',
  exited: '終了',
};

/**
 * ステータスの表示ラベル。未知の値は原文のまま返す(誤訳よりまし)。
 * undefined/空は「未着手」(以前の「不明」はデータ欠損の不安をそのまま見せていた)。
 */
export function statusLabel(status: string | undefined): string {
  if (!status) return '未着手';
  return STATUS_LABEL[status] ?? status;
}
