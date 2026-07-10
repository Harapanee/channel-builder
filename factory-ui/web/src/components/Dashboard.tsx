import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChannelSummary, JobDetail, JobSummary, RateLimitInfo } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import { getJob, listJobs } from '../api';
import { badgeClassFor } from '../status';
import { AttentionInbox } from './AttentionInbox';
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
  ws,
}: {
  factoryName: string;
  channels: ChannelSummary[];
  onSelectChannel: (dir: string) => void;
  ws: FactoryWS;
}) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [jobDetails, setJobDetails] = useState<Record<string, JobDetail>>({});
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null);

  // reloadJobs を安定した関数(空deps)に保ちつつ最新の jobDetails を読むための ref
  const jobDetailsRef = useRef<Record<string, JobDetail>>({});
  useEffect(() => {
    jobDetailsRef.current = jobDetails;
  }, [jobDetails]);

  const reloadJobs = useCallback(async () => {
    try {
      const list = await listJobs();
      setJobs(list);
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
      // 一覧取得に失敗しても直前の表示は維持する
    }
  }, []);

  useEffect(() => {
    reloadJobs();
  }, [reloadJobs]);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (msg.type === 'job-update') {
        setJobDetails((prev) => ({ ...prev, [msg.job.id]: msg.job }));
        reloadJobs();
      } else if (msg.type === 'gate-open') {
        reloadJobs();
      } else if (msg.type === 'rate-limit') {
        setRateLimit(msg.info);
      }
    });
  }, [ws, reloadJobs]);

  const awaitingGateDirs = new Set(
    jobs.filter((j) => j.status === 'awaiting_gate').map((j) => j.dir),
  );
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
  const nameFor = (dir: string) => channels.find((c) => c.dir === dir)?.channelName || dir;

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

      <AttentionInbox jobs={inboxJobs} channels={channels} onSelectChannel={onSelectChannel} />

      <RenderQueuePanel ws={ws} channels={channels} onSelectChannel={onSelectChannel} />

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
                onSelect={onSelectChannel}
              />
            );
          })}
        </div>
      )}

      <section style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <h2>稼働中ジョブ</h2>
        {runningJobs.length === 0 ? (
          <div className="empty">稼働中のジョブはありません</div>
        ) : (
          <div className="panel" style={{ overflow: 'hidden' }}>
            {runningJobs.map((j) => (
              <button
                key={j.id}
                type="button"
                className="inbox-item"
                onClick={() => onSelectChannel(j.dir)}
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
    </div>
  );
}
