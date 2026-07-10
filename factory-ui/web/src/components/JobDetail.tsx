import { useCallback, useEffect, useState } from 'react';
import type { JobDetail as JobDetailType, JobStatus } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import { cancelJob, createJob, getJob, resumeJob } from '../api';
import { badgeClassFor, JOB_MODE_LABEL } from '../status';
import { GateCard } from './GateCard';
import { Stepper } from './Stepper';
import { applyFeedItem, parseFeedItem, type FeedItem } from '../logFeed';

/** JobStatus → 表示用の日本語ラベル(バッジの色に加えて必ずテキストで意味を伝える)。 */
export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: '待機中',
  running: '稼働中',
  awaiting_gate: '要対応',
  succeeded: '成功',
  failed: '失敗',
  cancelled: 'キャンセル',
  interrupted: '中断',
};

const MAX_LOG_LINES = 500;

// 長い発話・エラー本文はデフォルト3行で切り、クリックで全文展開する
const FEED_COLLAPSE_CHARS = 160;

function FeedRow({ item }: { item: FeedItem }) {
  const [expanded, setExpanded] = useState(false);
  const detail = item.detail ?? '';
  const long = detail.length > FEED_COLLAPSE_CHARS;
  const shown = expanded || !long ? detail : `${detail.slice(0, FEED_COLLAPSE_CHARS)}…`;
  return (
    <div
      className={`job-feed-row job-feed-${item.kind}`}
      onClick={long ? () => setExpanded((v) => !v) : undefined}
      style={long ? { cursor: 'pointer' } : undefined}
    >
      <span className="job-feed-icon">{item.icon}</span>
      <span className="job-feed-body">
        {item.label && <span className="job-feed-label">{item.label}</span>}
        {detail && <span className="job-feed-detail">{shown}</span>}
      </span>
    </div>
  );
}

/**
 * ジョブ詳細: ステージタイムライン + ライブログ + 生成物 + ゲートカード + キャンセル。
 *
 * getJob(id) で初期状態を取得し、以後は job-update(自身のid宛て)で丸ごと差し替える。
 * ログは job-log 購読で追記するのみ(取得済みの過去ログを遡って取り直すAPIは無い)。
 */
export function JobDetail({
  jobId,
  ws,
  onBack,
}: {
  jobId: string;
  ws: FactoryWS;
  onBack: () => void;
}) {
  const [job, setJob] = useState<JobDetailType | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [logOpen, setLogOpen] = useState(true);
  const [logView, setLogView] = useState<'feed' | 'raw'>('feed');
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const detail = await getJob(jobId);
      setJob(detail);
      setLoadError(null);
    } catch (e) {
      setLoadError(`ジョブ詳細の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [jobId]);

  useEffect(() => {
    setJob(null);
    setLoadError(null);
    setLogLines([]);
    setFeedItems([]);
    setCancelError(null);
    setRetryError(null);
    setResumeError(null);
    reload();
  }, [jobId, reload]);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (msg.type === 'job-update' && msg.job.id === jobId) {
        setJob(msg.job);
      } else if (msg.type === 'job-log' && msg.jobId === jobId) {
        setLogLines((prev) => [...prev, msg.line].slice(-MAX_LOG_LINES));
        const item = parseFeedItem(msg.line);
        if (item) setFeedItems((prev) => applyFeedItem(prev, item));
      }
    });
  }, [ws, jobId]);

  async function handleCancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelJob(jobId);
    } catch (e) {
      setCancelError(`キャンセルに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCancelling(false);
    }
  }

  // 失敗・中断・キャンセル済みのジョブは、同じ操作・題材で作り直して再試行できる(受け入れ基準6)
  async function handleRetry() {
    if (!job) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await createJob({
        dir: job.dir,
        operation: job.operation,
        arg: job.request.arg,
        mode: job.mode,
        model: job.model,
        effort: job.effort,
        durationSec: job.request.durationSec,
        episodeId: job.request.episodeId,
      });
      onBack(); // 新しいジョブがジョブ一覧に現れる
    } catch (e) {
      setRetryError(`再試行に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRetrying(false);
    }
  }

  // 中断・失敗・キャンセル済みジョブをセッション再開(--resume)で途中から続ける。
  // 409 = sessionId無し(再開不能)。その場合は再試行(最初から)を案内する。
  async function handleResume() {
    setResuming(true);
    setResumeError(null);
    try {
      await resumeJob(jobId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setResumeError(
        msg.includes('-> 409')
          ? '途中再開できません(セッション記録なし)。「再試行(最初から)」を使ってください。'
          : `再開に失敗しました: ${msg}`,
      );
    } finally {
      setResuming(false);
    }
  }

  const canCancel = job !== null && (job.status === 'running' || job.status === 'awaiting_gate');
  const canRetry =
    job !== null &&
    (job.status === 'failed' || job.status === 'interrupted' || job.status === 'cancelled');
  const canResume = job !== null && canRetry && job.sessionId !== undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          ← 一覧に戻る
        </button>
        {job && <h3>{job.title}</h3>}
        {job && <span className={badgeClassFor(job.status)}>{JOB_STATUS_LABEL[job.status] ?? job.status}</span>}
      </div>

      {loadError && <div style={{ color: 'var(--status-err)' }}>{loadError}</div>}

      {!job && !loadError && <div className="empty">読み込み中…</div>}

      {job && (
        <>
          <div className="mono">
            {job.operation} ・ モデル {job.model}×{job.effort} ・ モード {JOB_MODE_LABEL[job.mode] ?? job.mode} ・ 更新{' '}
            {new Date(job.updatedAt).toLocaleString('ja-JP')}
          </div>

          {job.stages.length > 0 && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <h3>進捗</h3>
              <Stepper stages={job.stages} />
            </section>
          )}

          {job.gate && <GateCard jobId={job.id} gate={job.gate} dir={job.dir} episodeId={job.episodeId} />}

          {job.resultText && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <h3>{job.operation === 'ask' ? '回答' : '結果'}</h3>
              <pre className="doc-view">{job.resultText}</pre>
            </section>
          )}

          <section style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <h3>生成物</h3>
            {job.artifacts.length === 0 ? (
              <div className="empty">生成物はまだありません</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {job.artifacts.map((a) => (
                  <span key={a} className="mono">
                    {a}
                  </span>
                ))}
              </div>
            )}
          </section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3>ログ</h3>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  type="button"
                  className={`btn ${logView === 'feed' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setLogView('feed')}
                >
                  フィード
                </button>
                <button
                  type="button"
                  className={`btn ${logView === 'raw' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setLogView('raw')}
                >
                  生ログ
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setLogOpen((v) => !v)}>
                  {logOpen ? '折りたたむ' : '展開する'}
                </button>
              </div>
            </div>
            {logOpen &&
              (logLines.length === 0 ? (
                <div className="empty">ログはまだありません(この画面を開いた後に流れた分のみ表示します)</div>
              ) : logView === 'raw' ? (
                <pre className="job-log">{logLines.join('\n')}</pre>
              ) : feedItems.length === 0 ? (
                <div className="empty">表示できる活動はまだありません(生ログには行が届いています)</div>
              ) : (
                <div className="job-feed">
                  {feedItems.map((item) => (
                    <FeedRow key={item.key} item={item} />
                  ))}
                </div>
              ))}
          </section>

          <section style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            {canCancel && (
              <button type="button" className="btn btn-danger" disabled={cancelling} onClick={handleCancel}>
                キャンセル
              </button>
            )}
            {canResume && (
              <button type="button" className="btn btn-primary" disabled={resuming} onClick={handleResume}>
                再開(続きから)
              </button>
            )}
            {canRetry && (
              <button
                type="button"
                className={`btn ${canResume ? 'btn-ghost' : 'btn-primary'}`}
                disabled={retrying}
                onClick={handleRetry}
              >
                再試行(最初から)
              </button>
            )}
            {job.error && <span style={{ color: 'var(--status-err)' }}>{job.error}</span>}
            {cancelError && <span style={{ color: 'var(--status-err)' }}>{cancelError}</span>}
            {resumeError && <span style={{ color: 'var(--status-err)' }}>{resumeError}</span>}
            {retryError && <span style={{ color: 'var(--status-err)' }}>{retryError}</span>}
          </section>
        </>
      )}
    </div>
  );
}
