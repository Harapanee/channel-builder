import type { ChannelSummary, JobSummary } from '../../../shared/types';
import { badgeClassFor } from '../status';

/**
 * ダッシュボード最上部の「要対応インボックス」。
 * 全チャンネル横断で awaiting_gate ジョブ + failed ジョブを集約し、件数バッジ付きで一覧表示する。
 * 各行クリックで該当ジョブの詳細(#/ch/<dir>/jobs/<jobId>)へ直行する。
 */
export function AttentionInbox({
  jobs,
  channels,
  onOpenJob,
  loaded = true,
}: {
  jobs: JobSummary[];
  channels: ChannelSummary[];
  onOpenJob: (dir: string, jobId: string) => void;
  /** 親のジョブ一覧初回fetchが完了したか。未完了の間は空状態文言の代わりに「読み込み中…」を出す */
  loaded?: boolean;
}) {
  const items = jobs
    .filter((j) => j.status === 'awaiting_gate' || j.status === 'failed')
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const nameFor = (dir: string) =>
    dir === '' ? 'ファクトリー' : channels.find((c) => c.dir === dir)?.channelName || dir;

  // 初回fetch前は「0件」と断言せず読み込み中表示にとどめる
  if (!loaded) {
    return (
      <div className="panel" style={{ display: 'flex', alignItems: 'center', padding: '10px 18px' }}>
        <span style={{ color: 'var(--text-secondary)' }}>読み込み中…</span>
      </div>
    );
  }

  // 0件のときは巨大な空パネルを避け、ヘッダ1行のコンパクト表示にする。
  if (items.length === 0) {
    return (
      <div
        className="panel"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '10px 18px',
        }}
      >
        <span
          className="inbox-count"
          style={{
            background: 'color-mix(in srgb, var(--status-ok) 15%, var(--surface))',
            color: 'var(--status-ok)',
          }}
        >
          0
        </span>
        <span style={{ color: 'var(--text-secondary)' }}>要対応の項目はありません</span>
      </div>
    );
  }

  return (
    <div className="inbox">
      <div className="inbox-header">
        <span>要対応</span>
        <span className="inbox-count">{items.length}</span>
      </div>
      {items.map((job) => (
        <button
          key={job.id}
          type="button"
          className="inbox-item"
          onClick={() => onOpenJob(job.dir, job.id)}
        >
          <span className={badgeClassFor(job.status)}>
            {job.status === 'awaiting_gate' ? '要対応' : '失敗'}
          </span>
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {job.title}
          </span>
          <span className="mono">{nameFor(job.dir)}</span>
        </button>
      ))}
    </div>
  );
}
