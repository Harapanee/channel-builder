import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JobDetail as JobDetailType, JobMode, JobStatus } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import { cancelJob, createJob, getJob, getJobLog, mediaUrl, resumeJob, setJobMode } from '../api';
import { badgeClassFor, JOB_MODE_LABEL } from '../status';
import { GateCard } from './GateCard';
import { Stepper } from './Stepper';
import { applyFeedItem, parseFeedItem, type FeedItem } from '../logFeed';
import { mergeLogLines } from '../logMerge';
import { extractTime, formatClock } from '../logTime';

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

// サーバーの過去ログ返却上限(2000行)に合わせる
const MAX_LOG_LINES = 2000;

// 長い発話・エラー本文はデフォルト3行で切り、クリックで全文展開する
const FEED_COLLAPSE_CHARS = 160;

/**
 * 行頭の時刻(HH:MM:SS)。時刻を持たない行(スタンプ導入前のログ・非JSON行)でも
 * 桁だけ確保して本文の左端を揃える(列がガタつかないように空文字を描く)。
 */
function LogTime({ time, className }: { time?: number; className: string }) {
  return <span className={className}>{time === undefined ? '' : formatClock(time)}</span>;
}

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
      <LogTime time={item.time} className="job-feed-time" />
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
 * ログは getJobLog(id) で過去分を復元してから、job-log 購読分を追記する
 * (fetch中に届いたWS行は mergeLogLines で重複なく合流させる)。
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
  // 過去ログfetchが終わるまでのWS行バッファ。null=復元済み(以後は直接追記)
  const wsLogBufferRef = useRef<string[] | null>([]);
  const [logOpen, setLogOpen] = useState(true);
  const [logView, setLogView] = useState<'feed' | 'raw'>('feed');
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [modeChanging, setModeChanging] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

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
    timeCacheRef.current.clear(); // 別ジョブの行を抱えたままにしない
    setCancelError(null);
    setRetryError(null);
    setResumeError(null);
    reload();

    // 過去ログを復元する。fetch中に届いたWS行はバッファへ溜め、到着後に重複なく合流させる
    wsLogBufferRef.current = [];
    let alive = true;
    const applyInitialLog = (fetched: string[]) => {
      if (!alive) return;
      const merged = mergeLogLines(fetched, wsLogBufferRef.current ?? []).slice(-MAX_LOG_LINES);
      wsLogBufferRef.current = null; // 以後のWS行は直接追記
      setLogLines(merged);
      setFeedItems(
        merged.reduce<FeedItem[]>((acc, line) => {
          const item = parseFeedItem(line);
          return item ? applyFeedItem(acc, item) : acc;
        }, []),
      );
    };
    getJobLog(jobId)
      .then((r) => applyInitialLog(r.lines))
      .catch(() => applyInitialLog([])); // 取得失敗時はWS購読分だけで続行(致命ではない)
    return () => {
      alive = false;
    };
  }, [jobId, reload]);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (msg.type === 'job-update' && msg.job.id === jobId) {
        setJob(msg.job);
      } else if (msg.type === 'job-removed' && msg.jobId === jobId) {
        onBack(); // 他のタブ/クライアントで削除された → 一覧へ戻る
      } else if (msg.type === 'job-log' && msg.jobId === jobId) {
        // 過去ログの復元前はバッファへ(復元時に mergeLogLines で合流する)
        if (wsLogBufferRef.current !== null) {
          wsLogBufferRef.current.push(msg.line);
          return;
        }
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
        durationSecMax: job.request.durationSecMax,
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

  // 走行中(queued/running/awaiting_gate)のジョブの実行モードを切り替える。
  // ゲート停止中に auto/semi へ切り替えると、サーバー側でそのゲートが即自動応答される。
  async function handleModeChange(mode: JobMode) {
    if (!job || job.mode === mode) return;
    setModeChanging(true);
    setModeError(null);
    try {
      const updated = await setJobMode(jobId, mode);
      setJob(updated);
    } catch (e) {
      setModeError(`モード変更に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setModeChanging(false);
    }
  }

  // 生ログの行 → 時刻。1行が数十KBになることがあり、新着行のたびに全行をJSON.parseすると重い。
  // 行文字列をキーにキャッシュし、パースは1行あたり1回だけにする(先頭ドロップでindexがずれても
  // 内容キーなので効き続ける)。溢れたら捨てて次のレンダーで作り直す。
  const timeCacheRef = useRef(new Map<string, number | undefined>());
  const rawRows = useMemo(() => {
    if (logView !== 'raw') return [];
    const cache = timeCacheRef.current;
    if (cache.size > MAX_LOG_LINES * 2) cache.clear();
    return logLines.map((line, i) => {
      if (!cache.has(line)) cache.set(line, extractTime(line));
      return { key: i, time: cache.get(line), line };
    });
  }, [logLines, logView]);

  const canCancel =
    job !== null && (job.status === 'running' || job.status === 'awaiting_gate' || job.status === 'queued');
  const canRetry =
    job !== null &&
    (job.status === 'failed' || job.status === 'interrupted' || job.status === 'cancelled');
  const canResume = job !== null && canRetry && job.sessionId !== undefined;
  const canChangeMode =
    job !== null && (job.status === 'running' || job.status === 'awaiting_gate' || job.status === 'queued');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          ← 一覧に戻る
        </button>
        {/* 画面題はh2(セクション題h3より一段上) */}
        {job && <h2>{job.title}</h2>}
        {job && <span className={badgeClassFor(job.status)}>{JOB_STATUS_LABEL[job.status] ?? job.status}</span>}
      </div>

      {loadError && <div style={{ color: 'var(--status-err)' }}>{loadError}</div>}

      {!job && !loadError && <div className="empty">読み込み中…</div>}

      {job && (
        <>
          <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span>
              {job.operation} ・ モデル {job.model}×{job.effort} ・ モード
            </span>
            {canChangeMode ? (
              // 走行中はその場でモードを切替できる(ゲート停止中にオートへ切り替えると即自動応答)
              (['manual', 'semi', 'auto'] as const).map((mo) => (
                <button
                  key={mo}
                  type="button"
                  className={`btn btn-sm ${job.mode === mo ? 'btn-primary' : 'btn-ghost'}`}
                  disabled={modeChanging || job.mode === mo}
                  onClick={() => handleModeChange(mo)}
                >
                  {JOB_MODE_LABEL[mo]}
                </button>
              ))
            ) : (
              <span>{JOB_MODE_LABEL[job.mode] ?? job.mode}</span>
            )}
            <span>・ 更新 {new Date(job.updatedAt).toLocaleString('ja-JP')}</span>
            {modeError && <span style={{ color: 'var(--status-err)' }}>{modeError}</span>}
          </div>

          {job.stages.length > 0 && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <h3>進捗</h3>
              <Stepper stages={job.stages} />
            </section>
          )}

          {job.gate && <GateCard jobId={job.id} gate={job.gate} dir={job.dir} episodeId={job.episodeId} shortId={job.shortId} />}

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
                {job.artifacts.map((a) =>
                  /\.(mp4|png|jpg)$/i.test(a) ? (
                    <a key={a} href={mediaUrl(job.dir, a)} target="_blank" rel="noreferrer" className="mono">
                      {a}
                    </a>
                  ) : (
                    <span key={a} className="mono">
                      {a}
                    </span>
                  ),
                )}
              </div>
            )}
          </section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3>ログ</h3>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {/* ビュー切替はチャンネルタブと同じ下線式タブに統一する(操作語彙をボタンと混ぜない) */}
                <div className="tabs" style={{ borderBottom: 'none' }} role="tablist" aria-label="ログ表示切替">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={logView === 'feed'}
                    className={`tab${logView === 'feed' ? ' active' : ''}`}
                    onClick={() => setLogView('feed')}
                  >
                    フィード
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={logView === 'raw'}
                    className={`tab${logView === 'raw' ? ' active' : ''}`}
                    onClick={() => setLogView('raw')}
                  >
                    生ログ
                  </button>
                </div>
                <button type="button" className="btn btn-ghost" onClick={() => setLogOpen((v) => !v)}>
                  {logOpen ? '折りたたむ' : '展開する'}
                </button>
              </div>
            </div>
            {logOpen &&
              (logLines.length === 0 ? (
                <div className="empty">ログはまだありません</div>
              ) : logView === 'raw' ? (
                <div className="job-log">
                  {rawRows.map((r) => (
                    <div className="job-log-row" key={r.key}>
                      <LogTime time={r.time} className="job-log-time" />
                      <span className="job-log-line">{r.line}</span>
                    </div>
                  ))}
                </div>
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
