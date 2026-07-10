import { useCallback, useEffect, useState } from 'react';
import type { EpisodeSummary } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import { listJobs } from '../api';
import { badgeClassFor } from '../status';
import { EpisodeDetail } from './EpisodeDetail';
import { ResumeEpisodeButton } from './ResumeEpisodeButton';

/**
 * エピソード一覧(master)+選択中のエピソード詳細(detail)を自前で切り替える。
 * 「新規動画」「改善」の起動は EpisodeDetail に設置された OperationLauncher が担う。
 *
 * approvedEpisodes は `.channel-system.json` の承認記録(親 ChannelView が getChannel から抽出)。
 * onChanged は直接編集(承認)成功後に親へ再取得を促すコールバック。
 */
export function EpisodesTab({
  dir,
  ws,
  episodes,
  approvedEpisodes,
  onChanged,
  onOpenSettings,
}: {
  dir: string;
  ws: FactoryWS;
  episodes: EpisodeSummary[];
  approvedEpisodes: string[];
  onChanged?: () => void;
  onOpenSettings?: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeJobEpisodeIds, setActiveJobEpisodeIds] = useState<Set<string>>(new Set());

  const reloadJobs = useCallback(async () => {
    try {
      const jobs = await listJobs();
      setActiveJobEpisodeIds(
        new Set(
          jobs
            .filter(
              (j) =>
                j.dir === dir &&
                (j.status === 'running' || j.status === 'awaiting_gate' || j.status === 'queued'),
            )
            .map((j) => j.episodeId ?? ''),
        ),
      );
    } catch {
      /* ジョブ一覧は再開ボタン表示の付加情報。失敗しても一覧表示は続ける */
    }
  }, [dir]);

  useEffect(() => {
    setSelectedId(null);
  }, [dir]);

  useEffect(() => {
    reloadJobs();
    return ws.onMessage((msg) => {
      if (msg.type === 'job-update' && msg.job.dir === dir) reloadJobs();
    });
  }, [ws, dir, reloadJobs]);

  const selected = selectedId ? episodes.find((e) => e.episodeId === selectedId) ?? null : null;

  if (selected) {
    return (
      <EpisodeDetail
        dir={dir}
        ws={ws}
        episode={selected}
        episodes={episodes}
        isApproved={approvedEpisodes.includes(selected.episodeId)}
        onApproved={onChanged}
        onBack={() => setSelectedId(null)}
        onOpenSettings={onOpenSettings}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {episodes.length === 0 ? (
        <div className="empty">エピソードがまだありません</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {episodes.map((ep) => (
            <div
              key={ep.episodeId}
              className="card clickable"
              role="button"
              tabIndex={0}
              onClick={() => setSelectedId(ep.episodeId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelectedId(ep.episodeId);
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
                padding: '12px 16px',
              }}
            >
              <span className="mono">{ep.episodeId}</span>
              <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{ep.subject ?? ''}</span>
              <span className={badgeClassFor(ep.status)}>{ep.status ?? '不明'}</span>
              {/* preview/final/承認 の有無は「存在するときだけラベルを描画」で伝える(色のみの区別はquality-floor違反) */}
              {approvedEpisodes.includes(ep.episodeId) && (
                <span className="mono" style={{ color: 'var(--status-ok)' }}>承認済み</span>
              )}
              {ep.hasPreview && <span className="mono" style={{ color: 'var(--text-secondary)' }}>PREVIEW</span>}
              {ep.hasFinal && <span className="mono" style={{ color: 'var(--text-secondary)' }}>FINAL</span>}
              <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                <ResumeEpisodeButton
                  dir={dir}
                  episode={ep}
                  activeJobEpisodeIds={activeJobEpisodeIds}
                  onStarted={() => {
                    reloadJobs();
                    setSelectedId(ep.episodeId);
                  }}
                />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
