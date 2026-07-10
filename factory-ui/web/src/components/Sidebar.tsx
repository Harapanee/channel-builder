import type { ChannelSummary } from '../../../shared/types';
import { badgeClassFor } from '../status';

/**
 * 左サイドバー: ダッシュボードへのリンク + チャンネル一覧 + 「+ 新チャンネル」。
 * activeDir: null=ダッシュボード, ''=ファクトリールートのターミナル, それ以外=チャンネルdir。
 * サイドバーからは直接遷移させないため '' は選択肢に含めない(「+ 新チャンネル」経由でのみ到達する)。
 */
export function Sidebar({
  factoryName,
  channels,
  activeDir,
  onSelect,
  onNewChannel,
  creatingChannel,
}: {
  factoryName: string;
  channels: ChannelSummary[];
  activeDir: string | null;
  onSelect: (dir: string | null) => void;
  onNewChannel: () => void;
  creatingChannel: boolean;
}) {
  return (
    <nav className="sidebar">
      <div style={{ padding: '4px 10px 12px' }}>
        <h3>{factoryName || 'Factory'}</h3>
      </div>

      <button
        className={`sidebar-item${activeDir === null ? ' active' : ''}`}
        onClick={() => onSelect(null)}
      >
        <span>ダッシュボード</span>
      </button>

      <div className="mono" style={{ padding: '16px 10px 4px' }}>
        チャンネル({channels.length})
      </div>

      {channels.length === 0 ? (
        <div className="empty" style={{ padding: '12px' }}>
          チャンネルがありません
        </div>
      ) : (
        channels.map((c) => (
          <button
            key={c.dir}
            className={`sidebar-item${activeDir === c.dir ? ' active' : ''}`}
            onClick={() => onSelect(c.dir)}
            title={c.channelName || c.dir}
          >
            <span
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: '2px',
                minWidth: 0,
                flex: '1 1 auto',
                textAlign: 'left',
              }}
            >
              <span
                style={{
                  display: 'block',
                  width: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {c.channelName || c.dir}
              </span>
              <span
                className="mono"
                style={{
                  display: 'block',
                  width: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {c.dir}
              </span>
            </span>
            <span className={badgeClassFor(c.status)} style={{ flexShrink: 0 }}>
              {c.status || '不明'}
            </span>
          </button>
        ))
      )}

      <button
        className="btn btn-ghost"
        style={{ marginTop: '12px' }}
        disabled={creatingChannel}
        onClick={onNewChannel}
      >
        + 新チャンネル
      </button>
    </nav>
  );
}
