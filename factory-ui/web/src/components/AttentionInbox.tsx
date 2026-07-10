import type { ChannelSummary, JobSummary } from '../../../shared/types';
import { badgeClassFor } from '../status';

/**
 * ダッシュボード最上部の「要対応インボックス」。
 * 全チャンネル横断で awaiting_gate ジョブ + failed ジョブを集約し、件数バッジ付きで一覧表示する。
 * 各行クリックで該当ジョブの dir(チャンネル)へ遷移する
 * (ジョブ詳細そのものへのディープリンクは Task 12 の JobDetail 画面が担当のため、ここではチャンネル遷移までで足りる)。
 */
export function AttentionInbox({
  jobs,
  channels,
  onSelectChannel,
}: {
  jobs: JobSummary[];
  channels: ChannelSummary[];
  onSelectChannel: (dir: string) => void;
}) {
  const items = jobs
    .filter((j) => j.status === 'awaiting_gate' || j.status === 'failed')
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const nameFor = (dir: string) => channels.find((c) => c.dir === dir)?.channelName || dir;

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
          onClick={() => onSelectChannel(job.dir)}
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
