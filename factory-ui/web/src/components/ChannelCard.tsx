import { Fragment } from 'react';
import type { ChannelSummary, JobDetail } from '../../../shared/types';
import { badgeClassFor } from '../status';

/**
 * 次の推奨アクション(常に1つ)。優先順位: 要対応ゲートあり > building > approved > それ以外。
 * ボタンはチャンネル遷移で足りる(実際の操作起動は ChannelView 側 = Task 12 以降の担当)。
 */
function nextActionLabel(status: string, hasAwaitingGate: boolean): string {
  if (hasAwaitingGate) return '要対応';
  if (status === 'building') return 'Pilotへ';
  if (status === 'approved') return '新規動画';
  return '続ける'; // pilot_iterating 等のフォールバック
}

/** チャンネルのライフサイクル(制作ライン signature)。常時描画する固定3工程。 */
const LIFECYCLE_STAGES: { key: string; label: string }[] = [
  { key: 'building', label: '構築' },
  { key: 'pilot_iterating', label: 'Pilot' },
  { key: 'approved', label: '承認' },
];

/**
 * channel.status → 3工程それぞれの状態。nextActionLabel と同じ分岐
 * (building / approved を明示判定し、pilot_iterating を含むそれ以外は同一のフォールバック)。
 */
function lifecycleStates(status: string): Array<'pending' | 'active' | 'done'> {
  if (status === 'approved') return ['done', 'done', 'done'];
  if (status === 'building') return ['active', 'pending', 'pending'];
  return ['done', 'active', 'pending']; // pilot_iterating 等のフォールバック
}

/**
 * ダッシュボードの1チャンネルぶんのカード。
 * channelName + 状態バッジ + 承認済み本数 + ライフサイクル・ステージレール(構築→Pilot→承認、常時表示)
 * + (稼働中ジョブがあれば)そのジョブ自体のステージレール + 次の推奨アクション。
 */
export function ChannelCard({
  channel,
  activeJob,
  hasAwaitingGate,
  onSelect,
}: {
  channel: ChannelSummary;
  /** そのdirで現在 running のジョブの詳細(ステージ含む)。未取得/無ければ undefined = ステージレールは省略 */
  activeJob?: JobDetail;
  hasAwaitingGate: boolean;
  onSelect: (dir: string) => void;
}) {
  const actionLabel = nextActionLabel(channel.status, hasAwaitingGate);
  const lifecycle = lifecycleStates(channel.status);

  return (
    <div
      className="card clickable"
      role="button"
      tabIndex={0}
      onClick={() => onSelect(channel.dir)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(channel.dir);
        }
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
        }}
      >
        <h3
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={channel.channelName || channel.dir}
        >
          {channel.channelName || channel.dir}
        </h3>
        <span className={badgeClassFor(channel.status)}>{channel.status || '不明'}</span>
      </div>

      <span className="mono">{channel.dir}</span>
      <span className="mono" style={{ color: 'var(--text-secondary)' }}>
        承認 {channel.approvedEpisodes.length}本 / 全{channel.episodeCount}本
      </span>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div className="stage-rail">
          {LIFECYCLE_STAGES.map((stg, i) => (
            <Fragment key={stg.key}>
              <span
                className={`stage-dot${
                  lifecycle[i] === 'done' ? ' done' : lifecycle[i] === 'active' ? ' active' : ''
                }`}
                title={stg.label}
              />
              {i < LIFECYCLE_STAGES.length - 1 && (
                <span className={`stage-link${lifecycle[i] === 'done' ? ' done' : ''}`} />
              )}
            </Fragment>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          {LIFECYCLE_STAGES.map((stg, i) => (
            <span
              key={stg.key}
              className="mono"
              style={{
                color:
                  lifecycle[i] === 'active'
                    ? 'var(--text-primary)'
                    : lifecycle[i] === 'done'
                      ? 'var(--text-secondary)'
                      : 'var(--text-muted)',
                fontWeight: lifecycle[i] === 'active' ? 600 : 400,
              }}
            >
              {stg.label}
            </span>
          ))}
        </div>
      </div>

      {activeJob && activeJob.stages.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span className="mono">{activeJob.title}</span>
          <div className="stage-rail">
            {activeJob.stages.map((s, i) => (
              <Fragment key={s.key}>
                <span
                  className={`stage-dot${
                    s.state === 'done' ? ' done' : s.state === 'active' ? ' active' : ''
                  }`}
                  title={s.label}
                />
                {i < activeJob.stages.length - 1 && (
                  <span className={`stage-link${s.state === 'done' ? ' done' : ''}`} />
                )}
              </Fragment>
            ))}
          </div>
        </div>
      )}

      <div className="next-action">
        <button
          type="button"
          className="btn btn-primary"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(channel.dir);
          }}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
