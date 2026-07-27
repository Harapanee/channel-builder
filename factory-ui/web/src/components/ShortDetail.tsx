import { useEffect, useMemo, useState } from 'react';
import type { ShortSummary } from '../../../shared/types';
import {
  approveShortStudioCheck,
  createJob,
  enqueueRenderQueue,
  getFileText,
  mediaUrl,
  startStudioShort,
} from '../api';
import { badgeClassFor, statusLabel } from '../status';
import type { FactoryWS } from '../ws';
import { useConfirm } from './ConfirmDialog';
import { Stepper } from './Stepper';
import { YoutubePanel } from './YoutubePanel';

type ReviewEntry =
  | { kind: 'md'; name: string; text: string }
  | { kind: 'json'; name: string; text: string }
  | { kind: 'error'; name: string; message: string };

/**
 * ショート詳細: 進捗レール + final動画(縦9:16) + script.md + review/一覧 +
 * Studio起動 / Studio確認承認(implemented時) / 夜間レンダーキュー投入(studio_checked時)。
 *
 * Studio確認承認は「稼働ジョブのゲート応答」ではなく short.json への直接編集
 * (approveShortStudioCheck)。short-create ジョブが稼働中の場合のゲート応答はジョブ詳細で行う。
 */
export function ShortDetail({
  dir,
  short,
  ws,
  onChanged,
  onJobStarted,
  onBack,
}: {
  dir: string;
  short: ShortSummary;
  ws: FactoryWS;
  onChanged?: () => void;
  onJobStarted?: (jobId: string) => void;
  onBack: () => void;
}) {
  const confirm = useConfirm();
  const [scriptText, setScriptText] = useState<string | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [reviewEntries, setReviewEntries] = useState<ReviewEntry[]>([]);
  const [approving, setApproving] = useState(false);
  const [approveMsg, setApproveMsg] = useState<string | null>(null);
  const [enqueueing, setEnqueueing] = useState(false);
  const [queueMsg, setQueueMsg] = useState<string | null>(null);
  const [studioStarting, setStudioStarting] = useState(false);
  const [studioMsg, setStudioMsg] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  // createMetadata()の失敗を表示する専用state。ボタンはYoutubePanel内(画面下部)にあるため、
  // 画面上部の操作セクション(queueMsg)に出しても押した本人の視界に入らない(最終レビュー指摘)
  const [publishMsg, setPublishMsg] = useState<string | null>(null);

  useEffect(() => {
    setScriptText(null);
    setScriptError(null);
    setReviewEntries([]);
    setApproveMsg(null);
    setQueueMsg(null);
    setStudioMsg(null);
    setPublishMsg(null);

    let alive = true;

    if (short.hasScript) {
      getFileText(dir, `shorts/${short.shortId}/script.md`)
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
      short.reviewFiles.map(async (name): Promise<ReviewEntry> => {
        const relPath = `shorts/${short.shortId}/review/${name}`;
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
  }, [dir, short]);

  const videoSrc = useMemo(
    () => (short.hasFinal ? mediaUrl(dir, `shorts/${short.shortId}/out/final.mp4`) : null),
    [dir, short],
  );

  async function openStudio() {
    if (studioStarting) return;
    setStudioStarting(true);
    setStudioMsg('Studioを起動しています…(初回は数十秒かかります)');
    try {
      const res = await startStudioShort(dir, short.shortId);
      window.open(res.url, '_blank');
      setStudioMsg('Studioを開きました(別タブ)。確認が済んだら「Studio確認OK」を押してください');
    } catch (e) {
      setStudioMsg(`Studioの起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setStudioStarting(false);
    }
  }

  async function approveStudioCheck() {
    if (approving) return;
    const ok = await confirm({
      title: 'Studio確認をOKとして記録しますか?',
      body: `${short.shortId} のステータスを「Studio確認済み」に更新します。`,
      confirmLabel: '記録する',
    });
    if (!ok) return;
    setApproving(true);
    setApproveMsg(null);
    try {
      await approveShortStudioCheck(dir, short.shortId);
      setApproveMsg('Studio確認OKを記録しました');
      onChanged?.();
    } catch (e) {
      setApproveMsg(`記録に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setApproving(false);
    }
  }

  async function enqueueRender() {
    if (enqueueing) return;
    setEnqueueing(true);
    setQueueMsg(null);
    try {
      await enqueueRenderQueue(dir, short.shortId, 'short');
      setQueueMsg('夜間レンダーキューに登録しました');
      onChanged?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setQueueMsg(msg.includes('-> 409') ? 'すでにキューに登録済みです' : `登録に失敗しました: ${msg}`);
    } finally {
      setEnqueueing(false);
    }
  }

  /** /short-publish ジョブを起動して publish/metadata.json を作らせる(既存ショートの後付けにも使う) */
  async function createMetadata() {
    if (publishing) return;
    setPublishing(true);
    setPublishMsg(null);
    try {
      const job = await createJob({ dir, operation: 'short-publish', arg: short.shortId });
      onJobStarted?.(job.id);
    } catch (e) {
      setPublishMsg(`公開メタデータ生成の起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <button className="btn btn-ghost" onClick={onBack}>
          ← 一覧に戻る
        </button>
        {/* 画面題はタイトル主・shortId従のh2(セクション題h3より一段上) */}
        <h2>{short.title || short.shortId}</h2>
        <span className="mono">{short.shortId}</span>
        <span className={badgeClassFor(short.status)}>{statusLabel(short.status)}</span>
        {short.sourceEpisodeId && (
          <span className="mono" style={{ color: 'var(--text-secondary)' }}>← {short.sourceEpisodeId}</span>
        )}
        {short.formatId && (
          <span className="mono" style={{ color: 'var(--text-secondary)' }}>{short.formatId}</span>
        )}
        {short.hasFinal && <span className="mono" style={{ color: 'var(--text-secondary)' }}>本番あり</span>}
      </div>

      <section
        className="panel"
        style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}
      >
        <h3>制作進捗</h3>
        <Stepper stages={short.stages} />
      </section>

      <section
        className="panel"
        style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}
      >
        <h3>操作</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <button className="btn" onClick={openStudio} disabled={studioStarting}>
            Studioで確認
          </button>
          {short.status === 'implemented' && (
            <button className="btn btn-primary" onClick={approveStudioCheck} disabled={approving}>
              Studio確認OK
            </button>
          )}
          {short.status === 'studio_checked' && (
            <button className="btn btn-primary" onClick={enqueueRender} disabled={enqueueing}>
              夜間レンダーキューへ
            </button>
          )}
        </div>
        <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {studioMsg && <span className="mono">{studioMsg}</span>}
          {approveMsg && <span className="mono">{approveMsg}</span>}
          {queueMsg && <span className="mono">{queueMsg}</span>}
        </div>
        {short.status === 'queued' && (
          <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
            キュー登録済みです。消化はレンダーキューパネル(サイドバー)の開始ボタンから
          </span>
        )}
      </section>

      <section
        className="panel"
        style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}
      >
        {videoSrc ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            key={videoSrc}
            controls
            src={videoSrc}
            style={{
              width: '100%',
              maxWidth: '360px',
              aspectRatio: '9 / 16',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-l)',
            }}
          />
        ) : (
          <div className="empty">レンダー済み動画はまだありません</div>
        )}
      </section>

      {short.hasFinal && (
        <YoutubePanel
          dir={dir}
          kind="short"
          id={short.shortId}
          ws={ws}
          onCreateMetadata={createMetadata}
          creatingMetadata={publishing}
          createMetadataError={publishMsg}
        />
      )}

      <section style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {short.hasScript ? (
          <details key={short.shortId} className="collapse">
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
            <div className="empty">まだ台本がありません</div>
          </>
        )}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {short.reviewFiles.length === 0 ? (
          <>
            <h3>レビュー</h3>
            <div className="empty">レビュー記録はまだありません</div>
          </>
        ) : (
          <details key={short.shortId} className="collapse">
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
    </div>
  );
}
