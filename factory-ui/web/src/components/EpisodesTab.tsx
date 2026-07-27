import { useCallback, useEffect, useRef, useState } from 'react';
import type { EpisodeSummary } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import { listJobs, mediaUrl } from '../api';
import { badgeClassFor, statusLabel } from '../status';
import { EpisodeDetail } from './EpisodeDetail';
import { ResumeEpisodeButton } from './ResumeEpisodeButton';

/** テスト・検証用エピソード(ep000-*)の判定。通常一覧から分離して折りたたみに格納する */
function isTestEpisode(ep: EpisodeSummary): boolean {
  return ep.episodeId.startsWith('ep000-');
}

/**
 * エピソード一覧(master)+選択中のエピソード詳細(detail)。選択状態は親(ChannelView→App)の
 * hash 同期状態を描画する制御型(selectedId / onSelect)。リロード・戻る/進むで詳細を失わない。
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
  publishedUrls = {},
  selectedId,
  onSelect,
  onOpenJob,
  onChanged,
  onOpenSettings,
  onCreateShort,
}: {
  dir: string;
  ws: FactoryWS;
  episodes: EpisodeSummary[];
  approvedEpisodes: string[];
  /** YouTube公開済み(アップロード完了)の epId → 動画URL(親 ChannelView が uploads から抽出) */
  publishedUrls?: Record<string, string>;
  selectedId: string | null;
  onSelect: (epId: string | null) => void;
  /** ジョブ詳細へ遷移(ジョブタブのhashへ)。EpisodeDetail 内のジョブカードが使う */
  onOpenJob?: (jobId: string) => void;
  onChanged?: () => void;
  onOpenSettings?: () => void;
  onCreateShort?: (epId: string) => void;
}) {
  const [activeJobEpisodeIds, setActiveJobEpisodeIds] = useState<Set<string>>(new Set());
  // 詳細から一覧へ戻ったとき、開いていた行へフォーカスを返すための記録
  const lastOpenedIdRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

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
    reloadJobs();
    return ws.onMessage((msg) => {
      if (msg.type === 'job-update' && msg.job.dir === dir) reloadJobs();
      // WS再接続 = 切断中の更新を取りこぼしている可能性があるため再取得
      if (msg.type === 'ws-status' && msg.connected) reloadJobs();
    });
  }, [ws, dir, reloadJobs]);

  // 詳細 → 一覧へ戻ったとき、開いていた行のボタンへフォーカスを返す
  useEffect(() => {
    if (selectedId !== null) return;
    const epId = lastOpenedIdRef.current;
    if (!epId) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-ep-row="${CSS.escape(epId)}"]`,
    );
    row?.focus();
  }, [selectedId]);

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
        onBack={() => onSelect(null)}
        onOpenJob={onOpenJob}
        onOpenSettings={onOpenSettings}
        onCreateShort={onCreateShort ? () => onCreateShort(selected.episodeId) : undefined}
      />
    );
  }

  function openEpisode(epId: string) {
    lastOpenedIdRef.current = epId;
    onSelect(epId);
  }

  function renderRow(ep: EpisodeSummary) {
    return (
      <div
        key={ep.episodeId}
        className="card"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          padding: '12px 16px',
        }}
      >
        {/* クリック可能領域はタイトル部分の <button> に限定する(role="button" の div に
            ネイティブ button をネストする構造は不正なため。キーボード操作は button が担う) */}
        <button
          type="button"
          data-ep-row={ep.episodeId}
          onClick={() => openEpisode(ep.episodeId)}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            background: 'none',
            border: 'none',
            padding: 0,
            font: 'inherit',
            color: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            minWidth: 0,
          }}
        >
          <span className="mono">{ep.episodeId}</span>
          <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{ep.subject ?? ''}</span>
        </button>
        {/* preview/final/承認 の有無は「存在するときだけラベルを描画」で伝える(色のみの区別はquality-floor違反) */}
        {approvedEpisodes.includes(ep.episodeId) && (
          <span className="mono" style={{ color: 'var(--status-ok)' }}>承認済み</span>
        )}
        {ep.hasPreview && (
          <a
            className="mono"
            style={{ color: 'var(--accent)' }}
            href={mediaUrl(dir, `episodes/${ep.episodeId}/out/preview.mp4`)}
            target="_blank"
            rel="noreferrer"
          >
            プレビュー
          </a>
        )}
        {ep.hasFinal && (
          <a
            className="mono"
            style={{ color: 'var(--accent)' }}
            href={mediaUrl(dir, `episodes/${ep.episodeId}/out/final.mp4`)}
            target="_blank"
            rel="noreferrer"
          >
            本番
          </a>
        )}
        {publishedUrls[ep.episodeId] && (
          <a
            className="mono"
            style={{ color: 'var(--status-ok)', fontWeight: 600 }}
            href={publishedUrls[ep.episodeId]}
            target="_blank"
            rel="noreferrer"
            title="YouTubeで開く"
          >
            ▶ 公開済み
          </a>
        )}
        <ResumeEpisodeButton
          dir={dir}
          episode={ep}
          activeJobEpisodeIds={activeJobEpisodeIds}
          onStarted={() => {
            reloadJobs();
            openEpisode(ep.episodeId);
          }}
        />
        {/* 状態バッジは行の右端に固定幅スロットで置く(行ごとのリンク有無で位置が揺れないように) */}
        <span className="status-slot">
          <span className={badgeClassFor(ep.status)}>{statusLabel(ep.status)}</span>
        </span>
      </div>
    );
  }

  // 新しい順(epId降順)。テスト用(ep000-*)は末尾の折りたたみへ分離する
  const sorted = [...episodes].sort((a, b) => b.episodeId.localeCompare(a.episodeId));
  const normalEpisodes = sorted.filter((ep) => !isTestEpisode(ep));
  const testEpisodes = sorted.filter(isTestEpisode);

  return (
    <div ref={listRef} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {episodes.length === 0 ? (
        <div className="empty">エピソードがまだありません</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {normalEpisodes.map(renderRow)}
          </div>
          {testEpisodes.length > 0 && (
            <details className="collapse">
              <summary>テスト・検証用 ({testEpisodes.length}件)</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {testEpisodes.map(renderRow)}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
