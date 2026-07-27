import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { EpisodeSummary, JobDetail as JobDetailType, JobSummary } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import { cancelJob, clearFinishedJobs, deleteJob, getJob, listJobs, resumeJob } from '../api';
import { badgeClassFor } from '../status';
import { useConfirm } from './ConfirmDialog';
import { JobDetail, JOB_STATUS_LABEL } from './JobDetail';
import { OperationLauncher } from './OperationLauncher';
import { RenderQueuePanel } from './RenderQueuePanel';

/**
 * ジョブタブ: 稼働中/履歴ジョブ一覧 + 操作起動フォーム(OperationLauncher。既定は折りたたみ)。
 * 監視コンソールとして「状態が先・操作が後」の順に置く。
 * ジョブ選択状態は親(ChannelView→App)の hash 同期状態を描画する制御型(selectedJobId / onSelectJob)。
 *
 * 一覧は listJobs() を dir でフィルタしたもの。稼働中/確認待ちジョブは getJob() で詳細(stages)を
 * 補い、ステージレールで進捗を示す(Dashboard の jobDetails キャッシュと同じ考え方)。
 * 一覧はステータスでセクション分けする(レンダー待ち/確認待ち/実行中/待機中/中断・失敗/完了)。
 */
export function JobsTab({
  dir,
  ws,
  episodes,
  selectedJobId,
  onSelectJob,
  onOpenEpisode,
}: {
  dir: string;
  ws: FactoryWS;
  episodes: EpisodeSummary[];
  selectedJobId: string | null;
  onSelectJob: (jobId: string | null) => void;
  /** レンダーキューの失敗アイテムから該当エピソード/ショート詳細へ直行する */
  onOpenEpisode?: (epId: string, kind?: 'episode' | 'short') => void;
}) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [jobDetails, setJobDetails] = useState<Record<string, JobDetailType>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  // 初回fetch完了フラグ。完了前に「ジョブなし」と誤認して起動フォームを開かないため
  const [loaded, setLoaded] = useState(false);
  // 個別削除失敗の表示用。削除中のジョブIDは連打防止に使う
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  // キュー済みジョブのキャンセル中ID(連打防止)。失敗表示は deleteError を共用する
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const confirm = useConfirm();

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
    } finally {
      setLoaded(true);
    }
  }, [dir]);

  useEffect(() => {
    setJobs([]);
    setJobDetails({});
    setLoadError(null);
    setLoaded(false);
    reload();
  }, [dir, reload]);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (msg.type === 'job-update' && msg.job.dir === dir) {
        setJobDetails((prev) => ({ ...prev, [msg.job.id]: msg.job }));
        reload();
      } else if (msg.type === 'job-removed') {
        reload();
      } else if (msg.type === 'gate-open') {
        reload(); // gate-open は dir を持たないため、この dir 分だけを取り直す
      } else if (msg.type === 'ws-status' && msg.connected) {
        reload(); // 再接続=切断中の取りこぼしがあり得るので一覧を取り直す
      }
    });
  }, [ws, dir, reload]);

  if (selectedJobId) {
    return <JobDetail jobId={selectedJobId} ws={ws} onBack={() => onSelectJob(null)} />;
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

  // 要対応(ゲート待ち)・実行中は情報優先度が最も高いので、起動フォームより上に出す
  const PRIORITY_KEYS: SectionKey[] = ['render', 'gate', 'running'];
  const prioritySections = SECTIONS.filter(
    (s) => PRIORITY_KEYS.includes(s.key) && (grouped.get(s.key) ?? []).length > 0,
  );
  const restSections = SECTIONS.filter(
    (s) => !PRIORITY_KEYS.includes(s.key) && (grouped.get(s.key) ?? []).length > 0,
  );

  async function handleDeleteJob(jobId: string) {
    setDeletingJobId(jobId);
    setDeleteError(null);
    try {
      await deleteJob(jobId);
      await reload();
    } catch (e) {
      setDeleteError(`ジョブの削除に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeletingJobId(null);
    }
  }

  /** 待機中(queued=未実行)ジョブのキャンセル。確認ダイアログ→cancel API→一覧再取得。
   * ジョブレコードは消さず cancelled(終了状態)へ遷移させる(履歴として「中断・失敗」に残り、
   * そこから再試行や個別削除ができる既存設計に合わせる) */
  async function handleCancelQueued(job: JobSummary) {
    const ok = await confirm({
      title: '待機中のジョブをキャンセルしますか?',
      body: `「${job.title}」は未実行のままキャンセルされ、履歴(中断・失敗)に残ります。`,
      confirmLabel: 'キャンセルする',
      cancelLabel: 'やめる',
      danger: true,
    });
    if (!ok) return;
    setCancellingJobId(job.id);
    setDeleteError(null);
    try {
      await cancelJob(job.id);
      await reload();
    } catch (e) {
      setDeleteError(`ジョブのキャンセルに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCancellingJobId(null);
    }
  }

  const renderSection = (s: { key: SectionKey; title: string }) => (
    <div key={s.key} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <h4>
        {s.title}({grouped.get(s.key)!.length})
      </h4>
      {grouped.get(s.key)!.map((job) => (
        <JobCard
          key={job.id}
          job={job}
          detail={jobDetails[job.id]}
          showResume={s.key === 'stopped'}
          onSelect={() => onSelectJob(job.id)}
          onResumed={reload}
          onDelete={
            s.key === 'stopped' || s.key === 'done'
              ? () => {
                  void handleDeleteJob(job.id);
                }
              : undefined
          }
          deleting={deletingJobId === job.id}
          onCancelQueued={
            s.key === 'queued'
              ? () => {
                  void handleCancelQueued(job);
                }
              : undefined
          }
          cancelling={cancellingJobId === job.id}
        />
      ))}
    </div>
  );

  // 監視情報(要対応→履歴)が先、操作(起動フォーム・キュー)は後。
  // 起動フォームはジョブが1件もない新品チャンネルでだけ開いて出迎える
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {prioritySections.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h3>要対応・実行中</h3>
          {loadError && <div style={{ color: 'var(--status-err)' }}>{loadError}</div>}
          {prioritySections.map(renderSection)}
        </section>
      )}

      {(restSections.length > 0 || sortedJobs.length === 0) && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3>ジョブ一覧</h3>
            {((grouped.get('stopped') ?? []).length > 0 || (grouped.get('done') ?? []).length > 0) && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={clearing}
                title="中断・失敗・完了ジョブの履歴を削除します(実行中・待機中は残ります)"
                onClick={async () => {
                  setClearing(true);
                  setDeleteError(null);
                  try {
                    await clearFinishedJobs();
                    await reload();
                  } catch (e) {
                    setDeleteError(`終了済みジョブのクリアに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
                  } finally {
                    setClearing(false);
                  }
                }}
              >
                終了済みをクリア
              </button>
            )}
          </div>
          {prioritySections.length === 0 && loadError && (
            <div style={{ color: 'var(--status-err)' }}>{loadError}</div>
          )}
          {deleteError && <div style={{ color: 'var(--status-err)' }}>{deleteError}</div>}
          {!loaded && sortedJobs.length === 0 ? (
            <div className="empty">読み込み中…</div>
          ) : sortedJobs.length === 0 ? (
            <div className="empty">このチャンネルのジョブはまだありません。下の「新規操作を起動」から始めます。</div>
          ) : (
            restSections.map(renderSection)
          )}
        </section>
      )}

      <OperationLauncher
        dir={dir}
        episodes={episodes}
        defaultOpen={loaded && sortedJobs.length === 0}
        onStarted={(id) => {
          onSelectJob(id);
          reload();
        }}
      />

      <RenderQueuePanel ws={ws} dir={dir} onOpenEpisode={onOpenEpisode ? (_d, epId, kind) => onOpenEpisode(epId, kind) : undefined} />
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
  onDelete,
  deleting,
  onCancelQueued,
  cancelling,
}: {
  job: JobSummary;
  detail?: JobDetailType;
  showResume: boolean;
  onSelect: () => void;
  onResumed: () => void;
  /** 指定すると削除ボタンを表示する(終了ジョブのみ。実行中・待機中は渡さないこと) */
  onDelete?: () => void;
  /** 削除実行中かどうか。true の間は削除ボタンを disabled にして連打を防ぐ */
  deleting?: boolean;
  /** 指定するとキャンセルボタンを表示する(待機中=queuedのジョブのみ渡すこと) */
  onCancelQueued?: () => void;
  /** キャンセル実行中かどうか。true の間はキャンセルボタンを disabled にして連打を防ぐ */
  cancelling?: boolean;
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
          {onCancelQueued && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={cancelling}
              title="このジョブを実行前にキャンセル"
              onClick={(e) => {
                e.stopPropagation(); // カードの onSelect を発火させない
                onCancelQueued();
              }}
            >
              キャンセル
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={deleting}
              title="このジョブを削除"
              onClick={(e) => {
                e.stopPropagation(); // カードの onSelect を発火させない
                onDelete();
              }}
            >
              🗑 削除
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
