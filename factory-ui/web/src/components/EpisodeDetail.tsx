import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EpisodeSummary, JobDetail as JobDetailType, JobSummary } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import { approveEpisode, enqueueRenderQueue, getFileText, getJob, listJobs, mediaUrl } from '../api';
import { badgeClassFor } from '../status';
import { JobDetail } from './JobDetail';
import { JobCard } from './JobsTab';
import { OperationLauncher } from './OperationLauncher';
import { ResumeEpisodeButton } from './ResumeEpisodeButton';
import { Stepper } from './Stepper';
import { YoutubePanel } from './YoutubePanel';

type ReviewEntry =
  | { kind: 'md'; name: string; text: string }
  | { kind: 'json'; name: string; text: string }
  | { kind: 'error'; name: string; message: string };

/**
 * エピソード詳細: video(preview/final切替) + script.md + review/一覧 + 承認ボタン。
 *
 * 承認は「稼働ジョブのゲート応答」ではなく、既に最終化されたエピソードの承認記録として
 * `approveEpisode(dir, epId)`(直接編集。claudeセッション不要)を呼ぶ。isApproved は
 * `.channel-system.json` の approvedEpisodes を親(EpisodesTab/ChannelView)経由で受け取る。
 */
export function EpisodeDetail({
  dir,
  ws,
  episode,
  episodes,
  isApproved,
  onApproved,
  onBack,
  onOpenSettings,
}: {
  dir: string;
  ws: FactoryWS;
  episode: EpisodeSummary;
  episodes: EpisodeSummary[];
  isApproved: boolean;
  onApproved?: () => void;
  onBack: () => void;
  onOpenSettings?: () => void;
}) {
  const [variant, setVariant] = useState<'preview' | 'final'>(
    episode.hasFinal ? 'final' : 'preview',
  );
  const [scriptText, setScriptText] = useState<string | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [reviewEntries, setReviewEntries] = useState<ReviewEntry[]>([]);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [enqueueing, setEnqueueing] = useState(false);
  const [queueMsg, setQueueMsg] = useState<string | null>(null);

  // このエピソードに関連するジョブ(episodeId一致)。JobsTab と同じ流儀で
  // 一覧+稼働中の詳細(stages)を持ち、カードクリックで JobDetail に切り替える
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [jobDetails, setJobDetails] = useState<Record<string, JobDetailType>>({});
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const reloadJobs = useCallback(async () => {
    try {
      const list = (await listJobs()).filter(
        (j) => j.dir === dir && j.episodeId === episode.episodeId,
      );
      setJobs(list);
      const active = list.filter((j) => j.status === 'running' || j.status === 'awaiting_gate');
      const fetched = await Promise.all(
        active.map((j) => getJob(j.id).catch(() => null)),
      );
      const valid = fetched.filter((d): d is JobDetailType => d !== null);
      if (valid.length > 0) {
        setJobDetails((prev) => {
          const next = { ...prev };
          for (const d of valid) next[d.id] = d;
          return next;
        });
      }
    } catch {
      /* ジョブ一覧はエピソード表示の付加情報。失敗しても本体の表示は続ける */
    }
  }, [dir, episode.episodeId]);

  useEffect(() => {
    setJobs([]);
    setJobDetails({});
    setSelectedJobId(null);
    reloadJobs();
  }, [reloadJobs]);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (msg.type === 'job-update' && msg.job.dir === dir) {
        setJobDetails((prev) => ({ ...prev, [msg.job.id]: msg.job }));
        reloadJobs();
      }
    });
  }, [ws, dir, reloadJobs]);

  useEffect(() => {
    setVariant(episode.hasFinal ? 'final' : 'preview');
    setScriptText(null);
    setScriptError(null);
    setReviewEntries([]);
    setApproveError(null);
    setQueueMsg(null);

    let alive = true;

    if (episode.hasScript) {
      getFileText(dir, `episodes/${episode.episodeId}/script.md`)
        .then((text) => {
          if (alive) setScriptText(text);
        })
        .catch((e) => {
          if (alive) {
            setScriptError(`台本の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
          }
        });
    }

    Promise.all(
      episode.reviewFiles.map(async (name): Promise<ReviewEntry> => {
        const relPath = `episodes/${episode.episodeId}/review/${name}`;
        try {
          const text = await getFileText(dir, relPath);
          if (name.toLowerCase().endsWith('.json')) {
            try {
              return { kind: 'json', name, text: JSON.stringify(JSON.parse(text), null, 2) };
            } catch {
              return { kind: 'json', name, text }; // パース不能ならそのまま表示
            }
          }
          return { kind: 'md', name, text };
        } catch (e) {
          return { kind: 'error', name, message: e instanceof Error ? e.message : String(e) };
        }
      }),
    ).then((entries) => {
      if (alive) setReviewEntries(entries);
    });

    return () => {
      alive = false;
    };
  }, [dir, episode]);

  const videoSrc = useMemo(() => {
    if (variant === 'final' && episode.hasFinal) {
      return mediaUrl(dir, `episodes/${episode.episodeId}/out/final.mp4`);
    }
    if (variant === 'preview' && episode.hasPreview) {
      return mediaUrl(dir, `episodes/${episode.episodeId}/out/preview.mp4`);
    }
    return null;
  }, [dir, episode, variant]);

  async function approve() {
    if (approving || isApproved) return;
    const ok = window.confirm(`${episode.episodeId} を承認済みとして記録します。よろしいですか?`);
    if (!ok) return;
    setApproving(true);
    setApproveError(null);
    try {
      await approveEpisode(dir, episode.episodeId);
      onApproved?.();
    } catch (e) {
      setApproveError(`承認の記録に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setApproving(false);
    }
  }

  // 承認済み(render_ready)・未レンダーのエピソードを夜間レンダーキューへ手動登録する
  // (承認ゲート経由なら自動登録済み。これはQA落ち修正後の再投入・登録漏れの救済用)
  async function enqueueRender() {
    if (enqueueing) return;
    setEnqueueing(true);
    setQueueMsg(null);
    try {
      await enqueueRenderQueue(dir, episode.episodeId);
      setQueueMsg('夜間レンダーキューに登録しました');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setQueueMsg(msg.includes('-> 409') ? 'すでにキューに登録済みです' : `登録に失敗しました: ${msg}`);
    } finally {
      setEnqueueing(false);
    }
  }

  if (selectedJobId) {
    return <JobDetail jobId={selectedJobId} ws={ws} onBack={() => setSelectedJobId(null)} />;
  }

  const sortedJobs = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <button className="btn btn-ghost" onClick={onBack}>
          ← 一覧に戻る
        </button>
        <h3 className="mono">{episode.episodeId}</h3>
        <span className={badgeClassFor(episode.status)}>{episode.status ?? '不明'}</span>
        <ResumeEpisodeButton
          dir={dir}
          episode={episode}
          activeJobEpisodeIds={
            new Set(
              jobs
                .filter((j) => j.status === 'running' || j.status === 'awaiting_gate' || j.status === 'queued')
                .map((j) => j.episodeId ?? ''),
            )
          }
          onStarted={(jobId) => {
            reloadJobs();
            setSelectedJobId(jobId);
          }}
        />
        {episode.status === 'render_ready' && !episode.hasFinal && (
          <button className="btn" onClick={enqueueRender} disabled={enqueueing}>
            夜間レンダーキューへ
          </button>
        )}
        {queueMsg && <span className="mono">{queueMsg}</span>}
      </div>

      {episode.stages && episode.stages.length > 0 && (
        <section
          className="panel"
          style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}
        >
          <h3>制作進捗</h3>
          <Stepper stages={episode.stages} />
        </section>
      )}

      {sortedJobs.length > 0 && (
        <section
          className="panel"
          style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}
        >
          <h3>このエピソードのジョブ</h3>
          {sortedJobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              detail={jobDetails[job.id]}
              showResume={
                job.status === 'failed' || job.status === 'cancelled' || job.status === 'interrupted'
              }
              onSelect={() => setSelectedJobId(job.id)}
              onResumed={reloadJobs}
            />
          ))}
        </section>
      )}

      <section
        className="panel"
        style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}
      >
        {episode.hasPreview || episode.hasFinal ? (
          <>
            {episode.hasPreview && episode.hasFinal && (
              <div className="tabs" style={{ borderBottom: 'none' }}>
                <button
                  className={`tab${variant === 'preview' ? ' active' : ''}`}
                  onClick={() => setVariant('preview')}
                >
                  プレビュー
                </button>
                <button
                  className={`tab${variant === 'final' ? ' active' : ''}`}
                  onClick={() => setVariant('final')}
                >
                  本番
                </button>
              </div>
            )}
            {videoSrc && (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                key={videoSrc}
                controls
                src={videoSrc}
                style={{
                  width: '100%',
                  maxWidth: '960px',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-l)',
                }}
              />
            )}
          </>
        ) : (
          <div className="empty">プレビュー・本番動画はまだありません</div>
        )}
      </section>

      {(episode.hasFinal || episode.hasPreview) && (
        <YoutubePanel dir={dir} episode={episode} ws={ws} onOpenSettings={onOpenSettings} />
      )}

      <section style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {episode.hasScript ? (
          // 台本は長文になるためデフォルト折りたたみ(episode切替でリセットされるよう key を付ける)
          <details key={episode.episodeId} className="collapse">
            <summary>
              <h3 style={{ display: 'inline' }}>台本</h3>
              <span className="collapse-hint">クリックで展開</span>
            </summary>
            {scriptError ? (
              <span style={{ color: 'var(--status-err)' }}>{scriptError}</span>
            ) : scriptText === null ? (
              <div className="empty">読み込み中…</div>
            ) : (
              <pre className="doc-view">{scriptText}</pre>
            )}
          </details>
        ) : (
          <>
            <h3>台本</h3>
            <div className="empty">script.md はありません</div>
          </>
        )}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {episode.reviewFiles.length === 0 ? (
          <>
            <h3>レビュー</h3>
            <div className="empty">review/ にファイルはありません</div>
          </>
        ) : (
          // レビューも長文になるため台本と同様デフォルト折りたたみ(episode切替でリセット)
          <details key={episode.episodeId} className="collapse">
            <summary>
              <h3 style={{ display: 'inline' }}>レビュー</h3>
              <span className="collapse-hint">クリックで展開</span>
            </summary>
            {reviewEntries.map((entry) => (
              <div key={entry.name} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="mono">{entry.name}</span>
                {entry.kind === 'error' ? (
                  <span style={{ color: 'var(--status-err)' }}>{entry.message}</span>
                ) : entry.kind === 'json' ? (
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>
                    {entry.text}
                  </pre>
                ) : (
                  <pre className="doc-view">{entry.text}</pre>
                )}
              </div>
            ))}
          </details>
        )}
      </section>

      <section style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" disabled={approving || isApproved} onClick={approve}>
          {isApproved ? '承認済み' : '承認する'}
        </button>
        {isApproved && (
          <span style={{ color: 'var(--status-ok)' }}>承認記録あり(.channel-system.json)</span>
        )}
        {approveError && <span style={{ color: 'var(--status-err)' }}>{approveError}</span>}
      </section>

      <OperationLauncher dir={dir} episodes={episodes} presetEpisodeId={episode.episodeId} />
    </div>
  );
}
