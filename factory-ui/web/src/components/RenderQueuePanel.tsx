import { useEffect, useState } from 'react';
import type { ChannelSummary, RenderQueueItem } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import {
  cancelRenderQueueItem,
  enqueueRenderQueue,
  getRenderQueue,
  mediaUrl,
  startRenderQueue,
} from '../api';
import { badgeClassFor } from '../status';

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
  onSelectChannel,
  dir,
}: {
  ws: FactoryWS;
  channels?: ChannelSummary[];
  onSelectChannel?: (dir: string) => void;
  /** 指定すると、このチャンネルのアイテムだけを表示する(埋め込み用) */
  dir?: string;
}) {
  const [items, setItems] = useState<RenderQueueItem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // レンダー中の経過分表示のための再描画タイマー(runningがあるときだけ動かす)
  const [, setTick] = useState(0);

  useEffect(() => {
    getRenderQueue()
      .then((res) => setItems(res.items))
      .catch(() => {
        /* 初期取得失敗時はWS更新を待つ */
      });
  }, []);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (msg.type === 'render-queue') setItems(msg.items);
    });
  }, [ws]);

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
        <h2>レンダーキュー</h2>
        <button
          className="btn"
          disabled={!canStart}
          onClick={() => run(() => startRenderQueue(), 'キューはすでに実行中か、待機中のエピソードがありません')}
        >
          夜間レンダー開始
        </button>
      </div>

      {message && <span style={{ color: 'var(--status-err)' }}>{message}</span>}

      {visibleItems.length === 0 ? (
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
                    href={mediaUrl(item.dir, `episodes/${item.epId}/out/final.mp4`)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    final.mp4 ▶
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
                      run(() => enqueueRenderQueue(item.dir, item.epId), 'すでにキューに登録済みです')
                    }
                  >
                    再キュー
                  </button>
                  {onSelectChannel && (
                    <button className="btn btn-ghost" onClick={() => onSelectChannel(item.dir)}>
                      修正へ
                    </button>
                  )}
                </>
              )}
              {item.status === 'waiting' && (
                <button
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => run(() => cancelRenderQueueItem(item.id), 'キャンセルできない状態です')}
                >
                  取り消し
                </button>
              )}
              {item.status === 'running' && (
                <button
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => run(() => cancelRenderQueueItem(item.id), 'キャンセルできない状態です')}
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
