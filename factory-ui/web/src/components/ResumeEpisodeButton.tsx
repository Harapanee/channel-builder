import { useState } from 'react';
import type { EpisodeSummary } from '../../../shared/types';
import { createJob } from '../api';

/**
 * 制作途中エピソードの「制作を再開」ボタン。
 * 表示条件(status!==final かつ 未レンダー かつ 当該エピソード対象の稼働/待機ジョブなし)を
 * 内包し、満たさないときは何も描画しない。押すとepisodeId付きvideo-createジョブを新規起動する
 * (スキル側がepisode.jsonのstatusを見て未完了工程から再開する)。
 */
export function ResumeEpisodeButton({
  dir,
  episode,
  activeJobEpisodeIds,
  onStarted,
}: {
  dir: string;
  episode: EpisodeSummary;
  activeJobEpisodeIds: Set<string>;
  onStarted?: (jobId: string) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resumable =
    episode.status !== 'final' && !episode.hasFinal && !activeJobEpisodeIds.has(episode.episodeId);
  if (!resumable) return null;

  async function resume() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const job = await createJob({
        dir,
        operation: 'video-create',
        arg: '',
        episodeId: episode.episodeId,
      });
      onStarted?.(job.id);
    } catch (e) {
      setError(`再開に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      setStarting(false);
    }
  }

  return (
    <>
      <button type="button" className="btn" disabled={starting} onClick={resume}>
        {starting ? '起動中…' : '制作を再開'}
      </button>
      {error && <span style={{ color: 'var(--status-err)' }}>{error}</span>}
    </>
  );
}
