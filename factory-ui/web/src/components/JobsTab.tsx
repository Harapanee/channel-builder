import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { EpisodeSummary, JobDetail as JobDetailType, JobSummary } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import { getJob, listJobs, resumeJob } from '../api';
import { badgeClassFor } from '../status';
import { JobDetail, JOB_STATUS_LABEL } from './JobDetail';
import { OperationLauncher } from './OperationLauncher';
import { RenderQueuePanel } from './RenderQueuePanel';

/**
 * ジョブタブ: このチャンネル(dir)の操作起動フォーム(OperationLauncher) + 稼働中/履歴ジョブ一覧。
 * ジョブをクリックすると同タブ内で JobDetail に切り替わる(EpisodesTab/EpisodeDetail と同じ流儀)。
 *
 * 一覧は listJobs() を dir でフィルタしたもの。稼働中/確認待ちジョブは getJob() で詳細(stages)を
 * 補い、ステージレールで進捗を示す(Dashboard の jobDetails キャッシュと同じ考え方)。
 * 一覧はステータスでセクション分けする(レンダー待ち/確認待ち/実行中/待機中/中断・失敗/完了)。
 */
export function JobsTab({ dir, ws, episodes }: { dir: string; ws: FactoryWS; episodes: EpisodeSummary[] }) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [jobDetails, setJobDetails] = useState<Record<string, JobDetailType>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  // reload を安定した関数(deps=[dir])に保ちつつ最新の jobDetails を読むための ref
  // (Dashboard.tsx と同じ考え方: jobDetails を deps に入れると WS 由来の再取得のたびに
  //  reload の参照が変わり、購読先の useEffect が余計に張り直される)
  const jobDetailsRef = useRef<Record<string, JobDetailType>>({});
  useEffect(() => {
    jobDetailsRef.current = jobDetails;
  }, [jobDetails]);

  const reload = useCallback(async () => {
    try {
      const list = (await listJobs()).filter((j) => j.dir === dir);
      setJobs(list);
      setLoadError(null);
      const running = list.filter((j) => j.status === 'running' || j.status === 'awaiting_gate');
      const missing = running.filter((j) => !(j.id in jobDetailsRef.current));
      if (missing.length > 0) {
        const fetched = await Promise.all(missing.map((j) => getJobSafe(j.id)));
        const valid = fetched.filter((d): d is JobDetailType => d !== null);
        if (valid.length > 0) {
          setJobDetails((prev) => {
            const next = { ...prev };
            for (const d of valid) next[d.id] = d;
            return next;
          });
        }
      }
    } catch (e) {
      setLoadError(`ジョブ一覧の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [dir]);

  useEffect(() => {
    setJobs([]);
    setJobDetails({});
    setLoadError(null);
    setSelectedJobId(null);
    reload();
  }, [dir, reload]);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (msg.type === 'job-update' && msg.job.dir === dir) {
        setJobDetails((prev) => ({ ...prev, [msg.job.id]: msg.job }));
        reload();
      } else if (msg.type === 'gate-open') {
        reload(); // gate-open は dir を持たないため、この dir 分だけを取り直す
      }
    });
  }, [ws, dir, reload]);

  if (selectedJobId) {
    return <JobDetail jobId={selectedJobId} ws={ws} onBack={() => setSelectedJobId(null)} />;
  }

  const sortedJobs = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt);

  type SectionKey = 'render' | 'gate' | 'running' | 'queued' | 'stopped' | 'done';
  const SECTIONS: { key: SectionKey; title: string }[] = [
    { key: 'render', title: 'レンダー待ち(目視確認)' },
    { key: 'gate', title: '確認待ち' },
    { key: 'running', title: '実行中' },
    { key: 'queued', title: '待機中(キュー)' },
    { key: 'stopped', title: '中断・失敗' },
    { key: 'done', title: '完了' },
  ];
  function sectionOf(job: JobSummary): SectionKey {
    if (job.status === 'awaiting_gate') {
      return jobDetails[job.id]?.gate?.kind === 'render-check' ? 'render' : 'gate';
    }
    if (job.status === 'running') return 'running';
    if (job.status === 'queued') return 'queued';
    if (job.status === 'succeeded') return 'done';
    return 'stopped';
  }
  const grouped = new Map<SectionKey, JobSummary[]>();
  for (const j of sortedJobs) {
    const k = sectionOf(j);
    grouped.set(k, [...(grouped.get(k) ?? []), j]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <OperationLauncher dir={dir} episodes={episodes} onStarted={(id) => { setSelectedJobId(id); reload(); }} />

      <RenderQueuePanel ws={ws} dir={dir} />

      <section style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <h3>ジョブ一覧</h3>
        {loadError && <div style={{ color: 'var(--status-err)' }}>{loadError}</div>}
        {sortedJobs.length === 0 ? (
          <div className="empty">このチャンネルのジョブはまだありません</div>
        ) : (
          SECTIONS.filter((s) => (grouped.get(s.key) ?? []).length > 0).map((s) => (
            <div key={s.key} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <h4 style={{ color: 'var(--text-secondary)' }}>
                {s.title}({grouped.get(s.key)!.length})
              </h4>
              {grouped.get(s.key)!.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  detail={jobDetails[job.id]}
                  showResume={s.key === 'stopped'}
                  onSelect={() => setSelectedJobId(job.id)}
                  onResumed={reload}
                />
              ))}
            </div>
          ))
        )}
      </section>
    </div>
  );
}

/** ジョブ1件のカード(ステージレール・再開ボタン付き)。JobsTab と EpisodeDetail で使う */
export function JobCard({
  job,
  detail,
  showResume,
  onSelect,
  onResumed,
}: {
  job: JobSummary;
  detail?: JobDetailType;
  showResume: boolean;
  onSelect: () => void;
  onResumed: () => void;
}) {
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  async function handleResume(e: MouseEvent) {
    e.stopPropagation(); // カードのクリック(詳細遷移)を抑止
    setResuming(true);
    setResumeError(null);
    try {
      await resumeJob(job.id);
      onResumed();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setResumeError(msg.includes('-> 409') ? '途中再開不可(詳細画面から再試行してください)' : `再開失敗: ${msg}`);
    } finally {
      setResuming(false);
    }
  }

  return (
    <div
      className="card clickable"
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '14px 16px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{job.title}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {showResume && (
            <button type="button" className="btn btn-primary" disabled={resuming} onClick={handleResume}>
              再開
            </button>
          )}
          <span className={badgeClassFor(job.status)}>{JOB_STATUS_LABEL[job.status] ?? job.status}</span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <span className="mono">{job.operation}</span>
        <span className="mono">{job.model}×{job.effort}</span>
        <span className="mono">更新 {new Date(job.updatedAt).toLocaleString('ja-JP')}</span>
        {resumeError && <span style={{ color: 'var(--status-err)' }}>{resumeError}</span>}
      </div>
      {detail && detail.stages.length > 0 && (
        <div className="stage-rail">
          {detail.stages.map((s, i) => (
            <StageDotLink key={s.key} stage={s} isLast={i === detail.stages.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function StageDotLink({
  stage,
  isLast,
}: {
  stage: JobDetailType['stages'][number];
  isLast: boolean;
}) {
  return (
    <>
      <span
        className={`stage-dot${stage.state === 'done' ? ' done' : stage.state === 'active' ? ' active' : ''}`}
        title={stage.label}
      />
      {!isLast && <span className={`stage-link${stage.state === 'done' ? ' done' : ''}`} />}
    </>
  );
}

async function getJobSafe(id: string): Promise<JobDetailType | null> {
  try {
    return await getJob(id);
  } catch {
    return null;
  }
}
