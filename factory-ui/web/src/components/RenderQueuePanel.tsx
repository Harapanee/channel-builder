import { useCallback, useEffect, useState } from 'react';
import type { ChannelSummary, RenderQueueItem } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import {
  cancelRenderQueueItem,
  clearRenderQueueFinished,
  enqueueRenderQueue,
  getRenderQueue,
  mediaUrl,
  startRenderQueue,
  startRenderQueueItem,
} from '../api';
import { badgeClassFor } from '../status';
import { useConfirm } from './ConfirmDialog';

const STATUS_LABEL: Record<RenderQueueItem['status'], string> = {
  waiting: '待機',
  running: 'レンダー中',
  done: '完了',
  failed: '失敗',
  canceled: '中止',
};

/**
 * 夜間レンダーキューのパネル。ダッシュボード(ファクトリー横断)とチャンネルの
 * ジョブタブ(dir指定で自チャンネル分に絞る)の両方に置く。
 * 「日中に承認して溜める → 寝る前に夜間レンダー開始 → 朝ここで結果を確認」の運用面。
 * 一覧は WS `render-queue` で常時更新し、初期表示は GET /api/render-queue で取得する。
 * 開始(startRenderQueue)はキュー全体の消化で、dir指定時も他チャンネル分を含めて走る。
 */
export function RenderQueuePanel({
  ws,
  channels = [],
  onOpenEpisode,
  dir,
}: {
  ws: FactoryWS;
  channels?: ChannelSummary[];
  /** 失敗アイテムの「修正へ」から該当エピソード/ショート詳細へ直行する */
  onOpenEpisode?: (dir: string, epId: string, kind?: 'episode' | 'short') => void;
  /** 指定すると、このチャンネルのアイテムだけを表示する(埋め込み用) */
  dir?: string;
}) {
  const confirm = useConfirm();
  const [items, setItems] = useState<RenderQueueItem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // レンダー中の経過分表示のための再描画タイマー(runningがあるときだけ動かす)
  const [, setTick] = useState(0);

  const fetchQueue = useCallback(() => {
    getRenderQueue()
      .then((res) => {
        setItems(res.items);
        setLoading(false);
        setLoadError(null);
      })
      .catch((e) => {
        setLoading(false);
        setLoadError(`キューの取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      });
  }, []);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (msg.type === 'render-queue') {
        setItems(msg.items);
        setLoading(false);
        setLoadError(null);
      } else if (msg.type === 'ws-status' && msg.connected) {
        fetchQueue(); // 再接続=切断中の更新を取りこぼした可能性があるので取り直す
      }
    });
  }, [ws, fetchQueue]);

  // 実行有無・開始可否はキュー全体で判定し(消化はチャンネル横断で直列)、表示だけ絞る
  const visibleItems = dir === undefined ? items : items.filter((i) => i.dir === dir);
  const hasRunning = items.some((i) => i.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [hasRunning]);

  const nameFor = (d: string) => channels.find((c) => c.dir === d)?.channelName || d;
  const canStart = !busy && !hasRunning && items.some((i) => i.status === 'waiting');
  // クリアはキュー全体に効く(dir絞り込み表示でも他チャンネルの終了済みが消える。startと同じ思想)
  const hasFinished = items.some(
    (i) => i.status === 'done' || i.status === 'failed' || i.status === 'canceled',
  );

  async function run(action: () => Promise<unknown>, conflictMessage: string) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessage(msg.includes('-> 409') ? conflictMessage : `操作に失敗しました: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="panel"
      style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        {/* ダッシュボードではセクション題(h2)、チャンネル内埋め込みではタブ内セクション題(h3) */}
        {dir === undefined ? <h2>レンダーキュー</h2> : <h3>レンダーキュー</h3>}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            className="btn btn-ghost"
            disabled={busy || !hasFinished}
            title="完了・失敗・中止の履歴をキュー全体から削除します(待機中・レンダー中は残ります)"
            onClick={() =>
              run(() => clearRenderQueueFinished(), '他の操作と競合しました。最新の状態を確認してください')
            }
          >
            終了済みをクリア
          </button>
          <button
            className="btn"
            disabled={!canStart}
            title="キューは全チャンネル横断で直列に消化されます"
            onClick={() => run(() => startRenderQueue(), 'キューはすでに実行中か、待機中のエピソードがありません')}
          >
            {/* チャンネル絞り表示でも開始はキュー全体に効くため、作用範囲をラベルで明示する */}
            {dir === undefined ? '夜間レンダー開始' : '夜間レンダー開始(全チャンネル)'}
          </button>
        </div>
      </div>

      {message && <span style={{ color: 'var(--status-err)' }}>{message}</span>}
      {loadError && <span style={{ color: 'var(--status-err)' }}>{loadError}</span>}

      {loading ? (
        <div className="empty">読み込み中…</div>
      ) : visibleItems.length === 0 ? (
        <div className="empty">
          {dir === undefined
            ? 'キューは空です。エピソードの承認(レンダー前の一括確認)で自動登録されます。'
            : 'このチャンネルのキューは空です。レンダー前の一括確認を承認すると自動登録されます。'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {visibleItems.map((item) => (
            <div
              key={item.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '8px 4px',
                borderTop: '1px solid var(--border)',
                flexWrap: 'wrap',
              }}
            >
              <span className={badgeClassFor(item.status)}>{STATUS_LABEL[item.status]}</span>
              {item.kind === 'short' && <span className="badge">SHORT</span>}
              <span className="mono">{item.epId}</span>
              <span
                className="mono"
                style={{ color: 'var(--text-secondary)', flex: 1, minWidth: '80px' }}
              >
                {dir === undefined ? nameFor(item.dir) : ''}
              </span>
              {item.status === 'running' && item.startedAt && (
                <span className="mono">
                  {Math.max(0, Math.round((Date.now() - Date.parse(item.startedAt)) / 60000))}分経過
                </span>
              )}
              {item.status === 'done' && (
                <>
                  <span className="badge ok">QA pass</span>
                  <a
                    className="btn btn-ghost"
                    href={mediaUrl(
                      item.dir,
                      `${item.kind === 'short' ? 'shorts' : 'episodes'}/${item.epId}/out/final.mp4`,
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    final.mp4を開く
                  </a>
                </>
              )}
              {item.status === 'failed' && (
                <>
                  <span style={{ color: 'var(--status-err)' }}>
                    {item.reason ?? 'failed'}
                    {item.qaExit !== undefined && item.qaExit !== 0 ? `(QA exit ${item.qaExit})` : ''}
                  </span>
                  <button
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() =>
                      run(() => enqueueRenderQueue(item.dir, item.epId, item.kind), 'すでにキューに登録済みです')
                    }
                  >
                    再キュー
                  </button>
                  {onOpenEpisode && (
                    <button
                      className="btn btn-ghost"
                      onClick={() => onOpenEpisode(item.dir, item.epId, item.kind)}
                    >
                      修正へ
                    </button>
                  )}
                </>
              )}
              {item.status === 'waiting' && (
                <>
                  <button
                    className="btn btn-ghost"
                    disabled={busy || hasRunning}
                    title={
                      hasRunning
                        ? 'レンダー実行中は個別開始できません(直列実行)'
                        : 'このジョブ1本だけを今すぐレンダーします(他の待機分には進みません)'
                    }
                    onClick={() =>
                      run(() => startRenderQueueItem(item.id), 'すでにレンダーが実行中か、開始できない状態です')
                    }
                  >
                    ▶ 開始
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => run(() => cancelRenderQueueItem(item.id), 'キャンセルできない状態です')}
                  >
                    取り消し
                  </button>
                </>
              )}
              {item.status === 'running' && (
                <button
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={async () => {
                    // 実行中の中止は破壊的(途中結果が消える)なので確認を挟む
                    const ok = await confirm({
                      title: `${item.epId} のレンダーを中止しますか?`,
                      body: '実行中のレンダーを停止します。途中結果は破棄されます。',
                      confirmLabel: '中止する',
                      danger: true,
                    });
                    if (!ok) return;
                    await run(() => cancelRenderQueueItem(item.id), 'キャンセルできない状態です');
                  }}
                >
                  中止
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
