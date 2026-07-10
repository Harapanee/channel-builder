import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMsg, ServerMsg, SessionInfo } from '../shared/types';
import type { SessionManager } from './sessions';
import type { FactoryWatcher, FsUpdate } from './watcher';
import type { JobManager } from './jobs';
import type { RenderQueueManager } from './render-queue';
import type { YoutubeManager } from './youtube';
import type { JobDetail, GateRequest, RateLimitInfo, RenderQueueItem, YoutubeUploadJob } from '../shared/types';
import { isLocalRequest } from './guards';

/**
 * `/ws` にWebSocketハブを取り付ける。単一接続でメッセージを多重化する。
 * - attach: そのセッションのscrollbackを送り、以後のpty-dataを中継する
 * - sessionsの'status' → session-status + sessions-changed をブロードキャスト
 * - watcherの'fs-update' → 全クライアントへブロードキャスト
 */
export function attachWsHub(
  server: Server,
  sessions: SessionManager,
  watcher: FactoryWatcher,
  jobs: JobManager,
  renderQueue: RenderQueueManager,
  youtube?: YoutubeManager,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('error', (err) => console.error('wss error:', err.message));
  const attached = new WeakMap<WebSocket, Set<string>>();

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '', 'http://127.0.0.1').pathname;
    // WebSocketはCORS対象外。第三者ページからのws接続をOrigin/Hostで弾く
    if (pathname !== '/ws' || !isLocalRequest(req.headers)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws: WebSocket, msg: ServerMsg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMsg) => {
    for (const ws of wss.clients) send(ws, msg);
  };

  sessions.on('data', (sessionId: string, data: string) => {
    for (const ws of wss.clients) {
      if (attached.get(ws)?.has(sessionId)) send(ws, { type: 'pty-data', sessionId, data });
    }
  });

  sessions.on('status', (info: SessionInfo) => {
    broadcast({
      type: 'session-status',
      sessionId: info.id,
      status: info.status,
      ...(info.exitCode !== undefined ? { exitCode: info.exitCode } : {}),
    });
    broadcast({ type: 'sessions-changed' });
  });

  watcher.on('fs-update', (u: FsUpdate) => {
    broadcast({ type: 'fs-update', dir: u.dir, kind: u.kind });
  });

  // ジョブ層のイベントを配信
  jobs.on('update', (job: JobDetail) => {
    broadcast({ type: 'job-update', job });
  });
  jobs.on('log', (jobId: string, line: string) => {
    broadcast({ type: 'job-log', jobId, line });
  });
  jobs.on('gate', (jobId: string, gate: GateRequest) => {
    broadcast({ type: 'gate-open', jobId, gate });
  });
  jobs.on('rate-limit', (info: RateLimitInfo) => {
    broadcast({ type: 'rate-limit', info });
  });

  // 夜間レンダーキューの状態変化を配信
  renderQueue.on('update', (items: RenderQueueItem[]) => {
    broadcast({ type: 'render-queue', items });
  });

  // YouTubeアップロードの進捗・完了を配信
  youtube?.on('update', (job: YoutubeUploadJob) => {
    broadcast({ type: 'youtube-upload', job });
  });

  wss.on('connection', (ws) => {
    attached.set(ws, new Set());
    // errorリスナー未登録だとECONNRESET等がプロセス全体を落とす
    ws.on('error', (err) => console.error('ws client error:', err.message));
    ws.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw)) as ClientMsg;
      } catch {
        return; // 不正なJSONは無視
      }
      try {
        if (msg.type === 'attach') {
          attached.get(ws)?.add(msg.sessionId);
          send(ws, { type: 'scrollback', sessionId: msg.sessionId, data: sessions.scrollback(msg.sessionId) });
        } else if (msg.type === 'input') {
          sessions.write(msg.sessionId, msg.data);
        } else if (msg.type === 'resize') {
          sessions.resize(msg.sessionId, msg.cols, msg.rows);
        }
      } catch {
        // 不明なセッションID等は無視(接続は維持する)
      }
    });
  });

  return wss;
}
