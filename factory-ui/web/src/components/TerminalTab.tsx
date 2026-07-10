import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ServerMsg, SessionInfo } from '../../../shared/types';
import type { FactoryWS } from '../ws';

/**
 * 指定 dir(''=ファクトリールート / チャンネルフォルダ名)の埋め込みターミナル。
 *
 * - GET /api/sessions を cwd===dir でフィルタし、最新セッションを表示する
 * - セッションが無ければ「セッション開始」「前回の続き(--continue)」ボタンを出す
 * - xterm + FitAddon。term.onData → ws.input、ResizeObserver → ws.resize
 * - exited 時はバナー(状態灯 .badge.err)+「再起動」ボタン
 */
export function TerminalTab({ dir, ws }: { dir: string; ws: FactoryWS }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLatest = useCallback(async (): Promise<SessionInfo | null> => {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error(`GET /api/sessions -> ${res.status}`);
    const list = (await res.json()) as SessionInfo[];
    // running を優先(操作ボタンの送信先=最新runningと画面表示を一致させる)、同格ならcreatedAt降順
    return (
      list
        .filter((s) => s.cwd === dir)
        .sort((a, b) => {
          const ar = a.status === 'running' ? 1 : 0;
          const br = b.status === 'running' ? 1 : 0;
          return br - ar || b.createdAt - a.createdAt;
        })[0] ?? null
    );
  }, [dir]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSession(null);
    setError(null);
    loadLatest()
      .then((s) => {
        if (!alive) return;
        setSession(s);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setError('セッション一覧の取得に失敗しました');
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [loadLatest]);

  async function start(continueFlag: boolean) {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: dir, continue: continueFlag }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSession((await res.json()) as SessionInfo);
    } catch (e) {
      setError(`セッション開始に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setStarting(false);
    }
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '16px',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: '12px' }}>
        <h3>{dir === '' ? 'ファクトリールート' : dir}</h3>
        <span className="mono">{dir === '' ? '/' : dir}</span>
      </header>

      {loading ? (
        <div className="empty">読み込み中…</div>
      ) : session ? (
        <TerminalView key={session.id} session={session} ws={ws} />
      ) : (
        <div
          className="panel"
          style={{
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            alignItems: 'flex-start',
          }}
        >
          <div className="empty" style={{ padding: 0 }}>
            このフォルダのセッションはまだありません。
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-ghost" disabled={starting} onClick={() => start(false)}>
              セッション開始
            </button>
            <button className="btn btn-ghost" disabled={starting} onClick={() => start(true)}>
              前回の続き(--continue)
            </button>
          </div>
          {error && <span className="badge err">{error}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * 1セッションぶんの xterm 表示。session.id が変わると key で作り直される。
 * 状態灯・再起動バナーは自前で管理する(親は session の発見だけを担う)。
 */
function TerminalView({ session, ws }: { session: SessionInfo; ws: FactoryWS }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'running' | 'exited'>(session.status);
  const [exitCode, setExitCode] = useState<number | undefined>(session.exitCode);
  const sessionId = session.id;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // IME(日本語入力)は xterm 内蔵の補助 textarea が composition を処理する。
    // 独自の keydown/keypress ハンドラを足さないことで変換確定が壊れないようにする。
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#0b0c0e', foreground: '#f2f4f6', cursor: '#4cc2ff' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();

    const dataSub = term.onData((data) => ws.input(sessionId, data));

    const unsub = ws.onMessage((msg: ServerMsg) => {
      switch (msg.type) {
        case 'scrollback':
          if (msg.sessionId !== sessionId) return;
          // attach のたびに1回届く。既存内容を捨てて描き直す(再接続・再起動時の同期点)。
          term.reset();
          if (msg.data) term.write(msg.data);
          break;
        case 'pty-data':
          if (msg.sessionId !== sessionId) return;
          term.write(msg.data);
          break;
        case 'session-status':
          if (msg.sessionId !== sessionId) return;
          setStatus(msg.status);
          setExitCode(msg.exitCode);
          // 再起動などで再び稼働 → 最新の scrollback を取り直して端末をリセットする
          if (msg.status === 'running') ws.attach(sessionId);
          break;
        default:
          break; // sessions-changed / fs-update はこの画面では扱わない
      }
    });

    ws.attach(sessionId); // 初回 attach(scrollback が返ってくる)

    const sendResize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      ws.resize(sessionId, term.cols, term.rows);
    };
    const ro = new ResizeObserver(() => sendResize());
    ro.observe(host);
    sendResize(); // 初回サイズを通知

    return () => {
      ro.disconnect();
      dataSub.dispose();
      unsub();
      ws.detach(sessionId);
      term.dispose();
    };
  }, [sessionId, ws]);

  async function restart() {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/restart`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      // 成功すると session-status(running) が届き、上の購読で端末がリセットされる
    } catch {
      // 再起動失敗は致命ではないためここでは黙殺(ボタンは残る)
    }
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span className={`badge ${status === 'running' ? 'run' : 'err'}`}>
          {status === 'running'
            ? 'RUNNING'
            : `EXITED${exitCode !== undefined ? ` ${exitCode}` : ''}`}
        </span>
        {status === 'exited' && (
          <button className="btn btn-ghost" onClick={restart}>
            再起動
          </button>
        )}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-l)',
          overflow: 'hidden',
          padding: '8px',
        }}
      >
        <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
