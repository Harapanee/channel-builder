import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChannelSummary,
  JobDetail,
  JobSummary,
  MetricsResponse,
  RateLimitInfo,
} from '../../../shared/types';
import type { FactoryWS } from '../ws';
import { getJob, getMetrics, listJobs } from '../api';
import { badgeClassFor } from '../status';
import { AttentionInbox } from './AttentionInbox';
import { ChannelAnalyzePanel } from './ChannelAnalyzePanel';
import { ChannelCard } from './ChannelCard';
import { RenderQueuePanel } from './RenderQueuePanel';

/**
 * メインの既定ビュー(チャンネル未選択時)。上部に要対応インボックス、中央にチャンネルカードのグリッド、
 * 下部に稼働中ジョブ一覧(空でも文言で締める)。全体を max-width で中央寄せし、広幅画面での右側の
 * 空白肥大と、チャンネル数が少ないときの間延びを抑える。
 *
 * channels は App.tsx が単一ソース(fs-update kind:system → getFactory)として渡す(Sidebarと同じデータソース)。
 * ジョブ一覧はここで自前保持する(listJobs)。
 *
 * WS購読:
 *  - job-update: listJobs を再取得してインボックス/カードを更新。ペイロードは JobDetail 全体
 *    (stages含む)なので、そのまま jobDetails キャッシュに積んで稼働中ジョブのステージレールに使う。
 *  - gate-open: listJobs を再取得(ゲート発生 = 状態がawaiting_gateへ変わるため)。
 *  - rate-limit: 控えめなクォータ表示(ヘッダ)に反映するだけ。
 */
export function Dashboard({
  factoryName,
  channels,
  onSelectChannel,
  onOpenJob,
  onOpenEpisode,
  ws,
}: {
  factoryName: string;
  channels: ChannelSummary[];
  onSelectChannel: (dir: string) => void;
  /** 要対応・稼働中ジョブから該当ジョブ詳細へ直行する(チャンネル止まりにしない) */
  onOpenJob: (dir: string, jobId: string) => void;
  /** レンダーキューの失敗アイテムから該当エピソード/ショート詳細へ直行する */
  onOpenEpisode: (dir: string, epId: string, kind?: 'episode' | 'short') => void;
  ws: FactoryWS;
}) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [jobDetails, setJobDetails] = useState<Record<string, JobDetail>>({});
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null);
  // 初回fetch完了フラグ。完了前に「〜はありません」の空状態文言を出さないため
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);

  // メトリクス統計セクション(表示時1回+WS再接続で再取得。チャート無し・タイル+テーブルのみ)
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  // reloadJobs を安定した関数(空deps)に保ちつつ最新の jobDetails を読むための ref
  const jobDetailsRef = useRef<Record<string, JobDetail>>({});
  useEffect(() => {
    jobDetailsRef.current = jobDetails;
  }, [jobDetails]);

  const reloadJobs = useCallback(async () => {
    try {
      const list = await listJobs();
      setJobs(list);
      setJobsError(null);
      // 稼働中ジョブのうちステージ未取得のものだけ getJob() で補完する
      // (job-update WS を1度も受けていない=ページ読み込み前から稼働していたジョブが対象)
      const running = list.filter((j) => j.status === 'running');
      const missing = running.filter((j) => !(j.id in jobDetailsRef.current));
      if (missing.length > 0) {
        const fetched = await Promise.all(missing.map((j) => getJob(j.id).catch(() => null)));
        const valid = fetched.filter((d): d is JobDetail => d !== null);
        if (valid.length > 0) {
          setJobDetails((prev) => {
            const next = { ...prev };
            for (const d of valid) next[d.id] = d;
            return next;
          });
        }
      }
    } catch {
      // 直前の表示は維持しつつ、失敗したことは1行で伝える(再取得はWS/fs-update経路に任せる)
      setJobsError('ジョブ一覧の取得に失敗しました');
    } finally {
      setJobsLoaded(true);
    }
  }, []);

  useEffect(() => {
    reloadJobs();
  }, [reloadJobs]);

  const reloadMetrics = useCallback(async () => {
    try {
      setMetrics(await getMetrics());
      setMetricsError(null);
    } catch (e) {
      // 直前の表示は維持しつつ、失敗したことは1行で伝える
      setMetricsError(`メトリクスの取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => {
    reloadMetrics();
  }, [reloadMetrics]);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (msg.type === 'job-update') {
        setJobDetails((prev) => ({ ...prev, [msg.job.id]: msg.job }));
        reloadJobs();
      } else if (msg.type === 'gate-open') {
        reloadJobs();
      } else if (msg.type === 'rate-limit') {
        setRateLimit(msg.info);
      } else if (msg.type === 'ws-status' && msg.connected) {
        // WS再接続 = 切断中の更新を取りこぼしている可能性があるため再取得
        reloadJobs();
        reloadMetrics();
      }
    });
  }, [ws, reloadJobs, reloadMetrics]);

  const awaitingGateDirs = new Set(
    jobs.filter((j) => j.status === 'awaiting_gate').map((j) => j.dir),
  );
  // チャンネルごとの先頭の要対応ジョブ(カードの「要対応」ボタンからジョブ詳細へ直行する)
  const awaitingGateJobIdByDir = new Map<string, string>();
  for (const j of jobs) {
    if (j.status === 'awaiting_gate' && !awaitingGateJobIdByDir.has(j.dir)) {
      awaitingGateJobIdByDir.set(j.dir, j.id);
    }
  }
  const runningJobIdByDir = new Map<string, string>();
  for (const j of jobs) {
    if (j.status === 'running' && !runningJobIdByDir.has(j.dir)) {
      runningJobIdByDir.set(j.dir, j.id);
    }
  }
  const inboxJobs = jobs.filter((j) => j.status === 'awaiting_gate' || j.status === 'failed');
  const runningJobs = jobs
    .filter((j) => j.status === 'running')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const nameFor = (dir: string) =>
    dir === '' ? 'ファクトリー' : channels.find((c) => c.dir === dir)?.channelName || dir;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', maxWidth: '1184px', margin: '0 auto' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <h1>{factoryName || 'Factory'}</h1>
          <span className="mono">{channels.length} channels</span>
        </div>
        {rateLimit && (
          <span className="mono">
            クォータ {Math.round(rateLimit.utilization * 100)}%（{rateLimit.status}）
          </span>
        )}
      </header>

      <AttentionInbox
        jobs={inboxJobs}
        channels={channels}
        onOpenJob={onOpenJob}
        loaded={jobsLoaded}
      />

      {jobsError && <span style={{ color: 'var(--status-err)' }}>{jobsError}</span>}

      <RenderQueuePanel ws={ws} channels={channels} onOpenEpisode={onOpenEpisode} />

      <section
        className="panel"
        style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}
      >
        <h2>メトリクス</h2>

        {metricsError && <span style={{ color: 'var(--status-err)' }}>{metricsError}</span>}

        {!metrics ? (
          <div className="empty">読み込み中…</div>
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: '12px',
              }}
            >
              {[
                { label: '総エピソード', value: metrics.totals.episodeCount },
                { label: 'final本数', value: metrics.totals.finalCount },
                { label: '累計レンダー分', value: metrics.totals.renderMinutesTotal },
                { label: '累計制作時間h', value: metrics.totals.wallClockHoursTotal.toFixed(1) },
                { label: '累計画像生成', value: metrics.totals.imageGenTotal },
              ].map((tile) => (
                <div
                  key={tile.label}
                  style={{
                    background: 'var(--surface-2)',
                    borderRadius: 'var(--radius-s)',
                    padding: '12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                  }}
                >
                  <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{tile.label}</span>
                  <span className="mono" style={{ fontSize: '20px', color: 'var(--text-primary)' }}>
                    {tile.value}
                  </span>
                </div>
              ))}
            </div>

            {metrics.channels.length === 0 ? (
              <div className="empty">チャンネルがまだありません</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div
                  style={{
                    display: 'flex',
                    gap: '10px',
                    padding: '6px 4px',
                    color: 'var(--text-secondary)',
                    fontSize: '13px',
                  }}
                >
                  <span style={{ flex: '1 1 120px' }}>dir</span>
                  <span style={{ flex: '1 1 140px' }}>チャンネル名</span>
                  <span style={{ width: '70px', textAlign: 'right' }}>エピ数</span>
                  <span style={{ width: '70px', textAlign: 'right' }}>final</span>
                  <span style={{ width: '90px', textAlign: 'right' }}>レンダー分</span>
                  <span style={{ width: '90px', textAlign: 'right' }}>制作時間h</span>
                  <span style={{ width: '90px', textAlign: 'right' }}>画像生成</span>
                </div>
                {metrics.channels.map((c) => (
                  <div
                    key={c.dir}
                    style={{
                      display: 'flex',
                      gap: '10px',
                      padding: '8px 4px',
                      borderTop: '1px solid var(--border)',
                      alignItems: 'center',
                    }}
                  >
                    <span className="mono" style={{ flex: '1 1 120px' }}>
                      {c.dir}
                    </span>
                    <span style={{ flex: '1 1 140px' }}>{c.channelName || c.dir}</span>
                    <span className="mono" style={{ width: '70px', textAlign: 'right' }}>
                      {c.episodeCount}
                    </span>
                    <span className="mono" style={{ width: '70px', textAlign: 'right' }}>
                      {c.finalCount}
                    </span>
                    <span className="mono" style={{ width: '90px', textAlign: 'right' }}>
                      {c.renderMinutesTotal}
                    </span>
                    <span className="mono" style={{ width: '90px', textAlign: 'right' }}>
                      {c.wallClockHoursTotal.toFixed(1)}
                    </span>
                    <span className="mono" style={{ width: '90px', textAlign: 'right' }}>
                      {c.imageGenTotal}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {channels.length === 0 ? (
        <div className="empty">チャンネルがまだありません。左の「+ 新チャンネル」から始めます。</div>
      ) : (
        <div className="dash-grid">
          {channels.map((c) => {
            const runningId = runningJobIdByDir.get(c.dir);
            const activeJob = runningId ? jobDetails[runningId] : undefined;
            return (
              <ChannelCard
                key={c.dir}
                channel={c}
                activeJob={activeJob}
                hasAwaitingGate={awaitingGateDirs.has(c.dir)}
                awaitingGateJobId={awaitingGateJobIdByDir.get(c.dir)}
                onSelect={onSelectChannel}
                onOpenJob={onOpenJob}
              />
            );
          })}
        </div>
      )}

      <section style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <h2>稼働中ジョブ</h2>
        {!jobsLoaded ? (
          <div className="empty">読み込み中…</div>
        ) : runningJobs.length === 0 ? (
          <div className="empty">稼働中のジョブはありません</div>
        ) : (
          <div className="panel" style={{ overflow: 'hidden' }}>
            {runningJobs.map((j) => (
              <button
                key={j.id}
                type="button"
                className="inbox-item"
                onClick={() => onOpenJob(j.dir, j.id)}
              >
                <span className={badgeClassFor(j.status)}>稼働中</span>
                <span
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {j.title}
                </span>
                <span className="mono">{nameFor(j.dir)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <ChannelAnalyzePanel onStarted={(jobId) => onOpenJob('', jobId)} />
    </div>
  );
}
