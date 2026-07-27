import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EpisodeSummary, JobDetail as JobDetailType, JobSummary } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import { approveEpisode, createJob, enqueueRenderQueue, getFileText, getJob, listJobs, mediaUrl, startStudio } from '../api';
import { badgeClassFor, statusLabel } from '../status';
import { AnalyticsPanel } from './AnalyticsPanel';
import { useConfirm } from './ConfirmDialog';
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
 * エピソード詳細: 見出し+主要アクション(承認等)を最上部に固定し、以下に
 * 進捗 → ジョブ → 動画(preview/final切替) → YouTube → 台本 → レビュー → 改善ランチャーを並べる。
 * 「次に何をすべきか(承認)」が最初に目に入るレイアウト(DESIGN.md の次アクション原則)。
 *
 * ジョブカードのクリックは onOpenJob(ジョブタブのhashへの遷移)に委譲する。
 * 詳細の中に JobDetail を入れ子で描画しない(戻り先が二重になるため)。
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
  onOpenJob,
  onOpenSettings,
  onCreateShort,
}: {
  dir: string;
  ws: FactoryWS;
  episode: EpisodeSummary;
  episodes: EpisodeSummary[];
  isApproved: boolean;
  onApproved?: () => void;
  onBack: () => void;
  /** ジョブ詳細へ遷移(ジョブタブのhashへ)。未指定ならジョブカードは遷移なし表示のみ */
  onOpenJob?: (jobId: string) => void;
  onOpenSettings?: () => void;
  onCreateShort?: () => void;
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
  const [studioStarting, setStudioStarting] = useState(false);
  const [studioMsg, setStudioMsg] = useState<string | null>(null);
  const [thumbText, setThumbText] = useState('');
  const [thumbSending, setThumbSending] = useState(false);
  const [thumbMsg, setThumbMsg] = useState<string | null>(null);
  const [thumbError, setThumbError] = useState<string | null>(null);
  const confirm = useConfirm();
  // 一覧 → 詳細に切り替わったら「一覧に戻る」ボタンへフォーカスを移す(キーボード操作の連続性)
  const backButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    backButtonRef.current?.focus();
  }, []);

  // このエピソードに関連するジョブ(episodeId一致)。JobsTab と同じ流儀で
  // 一覧+稼働中の詳細(stages)を持つ。カードクリックは onOpenJob(ジョブタブへ遷移)
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [jobDetails, setJobDetails] = useState<Record<string, JobDetailType>>({});

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
    reloadJobs();
  }, [reloadJobs]);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (msg.type === 'job-update' && msg.job.dir === dir) {
        setJobDetails((prev) => ({ ...prev, [msg.job.id]: msg.job }));
        reloadJobs();
      }
      // WS再接続 = 切断中の更新を取りこぼしている可能性があるため再取得
      if (msg.type === 'ws-status' && msg.connected) reloadJobs();
    });
  }, [ws, dir, reloadJobs]);

  useEffect(() => {
    setVariant(episode.hasFinal ? 'final' : 'preview');
    setScriptText(null);
    setScriptError(null);
    setReviewEntries([]);
    setApproveError(null);
    setQueueMsg(null);
    setThumbText('');
    setThumbMsg(null);
    setThumbError(null);

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
    const ok = await confirm({
      title: 'エピソードを承認する',
      body: `${episode.episodeId} を承認済みとして記録します。よろしいですか?`,
      confirmLabel: '承認する',
    });
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

  // レンダー前の目視確認用に Remotion Studio を起動して別タブで開く。
  // StudioManager がポート4710に1チャンネル分だけ常駐させ、別対象が動いていれば
  // 自動で停止→再起動するため、押せば必ずこのエピソードが開く。
  async function openStudio() {
    if (studioStarting) return;
    setStudioStarting(true);
    setStudioMsg('Studioを起動しています…(初回は数十秒かかります)');
    try {
      const res = await startStudio(dir, episode.episodeId);
      window.open(res.url, '_blank');
      setStudioMsg('Studioを開きました(別タブ)');
    } catch (e) {
      setStudioMsg(`Studioの起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setStudioStarting(false);
    }
  }

  // サムネの改善要求は既存の channel-refine(episodeId付き)として送る。
  // 専用オペではなくプロンプト先頭に「サムネイルの改善」と明示して対象を絞らせる。
  async function sendThumbRequest() {
    const text = thumbText.trim();
    if (thumbSending || !text) return;
    setThumbSending(true);
    setThumbMsg(null);
    setThumbError(null);
    try {
      const j = await createJob({
        dir,
        operation: 'channel-refine',
        episodeId: episode.episodeId,
        arg: `サムネイルの改善: ${text}`,
      });
      setThumbText('');
      setThumbMsg('サムネイルの改善ジョブを送信しました(キューで順次実行)');
      reloadJobs();
      onOpenJob?.(j.id);
    } catch (e) {
      setThumbError(`送信に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setThumbSending(false);
    }
  }

  const sortedJobs = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* 画面題(subject主・epId従)+ 状態。詳細画面の題はセクション題(h3)より一段上のh2 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <button ref={backButtonRef} className="btn btn-ghost" onClick={onBack}>
          ← 一覧に戻る
        </button>
        <h2>{episode.subject || episode.episodeId}</h2>
        <span className="mono">{episode.episodeId}</span>
        <span className={badgeClassFor(episode.status)}>{statusLabel(episode.status)}</span>
      </div>

      {/* 主要アクション: 最重要の「承認」を最上部に置く(下部のセクション群に埋もれさせない) */}
      <section style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" disabled={approving || isApproved} onClick={approve}>
          {isApproved ? '承認済み' : '承認する'}
        </button>
        {isApproved && (
          <span style={{ color: 'var(--status-ok)' }}>承認記録あり(.channel-system.json)</span>
        )}
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
            onOpenJob?.(jobId);
          }}
        />
        {episode.status === 'render_ready' && !episode.hasFinal && (
          <button className="btn" onClick={enqueueRender} disabled={enqueueing}>
            夜間レンダーキューへ
          </button>
        )}
        {/* 完成後は画面内の動画プレビューで足りるため出さない */}
        {!episode.hasFinal && (
          <button className="btn" onClick={openStudio} disabled={studioStarting}>
            Studioで開く
          </button>
        )}
        {onCreateShort && (
          <button className="btn" onClick={onCreateShort}>
            このエピソードからショートを作成
          </button>
        )}
        {/* 常時マウントの aria-live 領域(表示時に生成すると読み上げられないことがある) */}
        <span className="mono" aria-live="polite">{queueMsg}</span>
        <span className="mono" aria-live="polite">{studioMsg}</span>
        <span style={{ color: 'var(--status-err)' }} aria-live="polite">{approveError}</span>
      </section>

      {episode.stages && episode.stages.length > 0 && (
        <section
          className="panel"
          style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}
        >
          <h3>制作進捗</h3>
          {/* 稼働中ジョブがあるときだけ「進行中」。なければ「次の工程」
              (放置中のエピソードに「進行中」と出す誤解を避ける) */}
          <Stepper
            stages={episode.stages}
            activeLabel={
              jobs.some((j) => j.status === 'running' || j.status === 'awaiting_gate')
                ? '進行中'
                : '次の工程'
            }
          />
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
              onSelect={() => onOpenJob?.(job.id)}
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
              <div className="tabs" style={{ borderBottom: 'none' }} role="tablist">
                <button
                  className={`tab${variant === 'preview' ? ' active' : ''}`}
                  role="tab"
                  aria-selected={variant === 'preview'}
                  onClick={() => setVariant('preview')}
                >
                  プレビュー
                </button>
                <button
                  className={`tab${variant === 'final' ? ' active' : ''}`}
                  role="tab"
                  aria-selected={variant === 'final'}
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

      {/* 旧サーバー(thumbnailFiles未対応)と組んでも落ちないよう ?? [] で防御 */}
      {(episode.thumbnailFiles ?? []).length > 0 && (
        <section
          className="panel"
          style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}
        >
          <h3>サムネイル</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
            {episode.thumbnailFiles.map((name) => {
              const isSelected = episode.selectedThumbnail === `publish/${name}`;
              return (
                <figure key={name} style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <img
                    src={mediaUrl(dir, `episodes/${episode.episodeId}/publish/${name}`)}
                    alt={`サムネイル ${name}`}
                    style={{
                      width: '320px',
                      maxWidth: '100%',
                      background: 'var(--bg)',
                      border: isSelected
                        ? '2px solid var(--status-ok)'
                        : '1px solid var(--border)',
                      borderRadius: 'var(--radius-l)',
                    }}
                  />
                  <figcaption className="mono" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    {name}
                    {isSelected && <span style={{ color: 'var(--status-ok)' }}>採用中</span>}
                  </figcaption>
                </figure>
              );
            })}
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span className="mono">サムネイルの改善要求(channel-refineジョブとして送信)</span>
            <textarea
              rows={2}
              value={thumbText}
              onChange={(e) => setThumbText(e.target.value)}
              placeholder="例: 文字が小さくて読めない。もっと大きく"
              style={{
                padding: '8px 12px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-s)',
                background: 'var(--surface)',
                color: 'var(--text-primary)',
                fontSize: '14px',
                fontFamily: 'var(--font-body)',
                resize: 'vertical',
              }}
            />
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              disabled={thumbSending || thumbText.trim() === ''}
              onClick={sendThumbRequest}
            >
              {thumbSending ? '送信中…' : '改善要求を送信'}
            </button>
            <span aria-live="polite">
              {thumbError && <span style={{ color: 'var(--status-err)' }}>{thumbError}</span>}
              {thumbMsg && !thumbError && <span style={{ color: 'var(--status-ok)' }}>{thumbMsg}</span>}
            </span>
          </div>
        </section>
      )}

      {(episode.hasFinal || episode.hasPreview) && (
        <>
          <YoutubePanel dir={dir} kind="episode" id={episode.episodeId} ws={ws} onOpenSettings={onOpenSettings} />
          <AnalyticsPanel dir={dir} episode={episode} onOpenSettings={onOpenSettings} />
        </>
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

      <OperationLauncher
        dir={dir}
        episodes={episodes}
        presetEpisodeId={episode.episodeId}
        title="このエピソードの改善・操作を起動"
        onStarted={(jobId) => {
          reloadJobs();
          onOpenJob?.(jobId);
        }}
      />
    </div>
  );
}
