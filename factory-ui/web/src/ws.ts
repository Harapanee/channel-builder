import type { ClientMsg, ServerMsg } from '../../shared/types';

/**
 * factory-ui サーバーの `/ws`(単一エンドポイント)への WebSocket 接続を管理する。
 *
 * - 1本の接続で複数セッションを多重化する(attach / input / resize を sessionId 付きで送る)
 * - 切断時は指数バックオフ(0.5s → 最大8s)で自動再接続する
 * - 再接続に成功したら、attach 済みの sessionId へ自動で再 attach する
 *   (サーバーは attach ごとに scrollback を1回返すので、受信側はそれで画面を作り直せる)
 * - onMessage() で受信を購読する。戻り値の関数を呼ぶと購読解除できる。
 *   受信は ServerMsg として型付けするだけで種別ごとの分岐は持たないため、
 *   pty/session/fs 系に加え job-update / job-log / gate-open / rate-limit も
 *   そのまま(透過的に)購読側へ配る。判別は購読側で行う。
 *
 * StrictMode 下での mount→unmount→remount に耐えるため「使い捨て」にはせず、
 * connect()/close() で開閉を繰り返せる設計にしている(close 後に connect すれば再接続する)。
 */

type Listener = (msg: ServerMsg) => void;

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;

export class FactoryWS {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();
  /** attach 済みで、再接続時に自動 re-attach する対象 */
  private readonly attached = new Set<string>();
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** connect() で true、close() で false。再接続すべきかの意思を表す */
  private wantOpen = false;

  constructor(url = defaultWsUrl()) {
    this.url = url;
  }

  /** 接続を開始する。既に接続中/接続済みなら何もしない。 */
  connect(): void {
    this.wantOpen = true;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)
    ) {
      return;
    }
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = INITIAL_BACKOFF_MS; // 成功したのでバックオフをリセット
      // 既知の attach 済みセッションへ(再)attach する
      for (const sessionId of this.attached) {
        this.rawSend({ type: 'attach', sessionId });
      }
    };

    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as ServerMsg;
      } catch {
        return; // 不正な JSON は無視
      }
      for (const cb of this.listeners) cb(msg);
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // 接続失敗時は close も続けて発火する。再接続は onclose 経由で行うのでここでは何もしない。
    };
  }

  /** セッションに attach する。切断中でも記録し、次の接続で自動 re-attach する。 */
  attach(sessionId: string): void {
    this.attached.add(sessionId);
    this.rawSend({ type: 'attach', sessionId });
  }

  /** セッションの追跡をやめる(自動 re-attach の対象から外す)。 */
  detach(sessionId: string): void {
    this.attached.delete(sessionId);
  }

  input(sessionId: string, data: string): void {
    this.rawSend({ type: 'input', sessionId, data });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.rawSend({ type: 'resize', sessionId, cols, rows });
  }

  /** 受信メッセージを購読する。戻り値の関数を呼ぶと購読解除。 */
  onMessage(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** 接続を閉じ、以後の自動再接続を止める(再度 connect() すれば再開できる)。 */
  close(): void {
    this.wantOpen = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* 既に閉じている等は無視 */
      }
    }
  }

  private rawSend(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (!this.wantOpen || this.reconnectTimer !== null) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS); // 次回に備えて倍化(上限8s)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantOpen) this.connect();
    }, delay);
  }
}

/** ブラウザ環境で現在オリジンの `/ws` を組み立てる(dev は vite が :4700 へプロキシ)。 */
function defaultWsUrl(): string {
  const loc = (globalThis as { location?: Location }).location;
  const proto = loc && loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = loc ? loc.host : '127.0.0.1';
  return `${proto}//${host}/ws`;
}
