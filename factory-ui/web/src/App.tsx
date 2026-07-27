import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChannelSummary } from '../../shared/types';
import { FactoryWS } from './ws';
import { TerminalTab } from './components/TerminalTab';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './components/Dashboard';
import { ChannelView } from './components/ChannelView';
import { JobDetail } from './components/JobDetail';
import { ConfirmProvider } from './components/ConfirmDialog';
import { createSession, getFactory, sendInput } from './api';
import { getToken, setToken } from './auth';
import { hashFor, parseHash } from './nav';

/**
 * アプリの骨格。左Sidebar(チャンネル一覧+「+ 新チャンネル」)+ 右にDashboardまたはChannelView。
 *
 * activeDir の意味:
 *  - null: ダッシュボード(メインの既定ビュー。要対応インボックス + チャンネルカードのグリッド)
 *  - '' : ファクトリールートのターミナル(「+ 新チャンネル」で /channel-builder をプリフィルする専用ビュー)
 *  - それ以外: そのdirのChannelView
 *
 * ナビ状態は location.hash と双方向同期する(#/ ダッシュボード、#/root ルートターミナル、
 * #/ch/<dir>/<tab>/<item> チャンネル。item はタブ内の詳細ID: jobs=jobId /
 * episodes=episodeId / shorts=shortId)。リロード・戻る/進む・URL共有で現在地を失わないため。
 *
 * WS接続(FactoryWS)は1本をここで生成し、TerminalTab/ChannelView/Dashboard へ共有する。
 * 切断中は画面最上部にバナーを出し、再接続(ws-status connected:true)で一覧を再取得する。
 */

/**
 * トークン未設定/失効時に表示する全画面ゲート。入力→保存→location.reload() で
 * アプリを最初から作り直す(WS再接続・全一覧の再取得を素直にやり直せるため)。
 */
function TokenGate() {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed === '') {
      setError('トークンを入力してください');
      return;
    }
    setToken(trimmed);
    window.location.reload();
  }

  return (
    <div className="modal-backdrop">
      <form
        className="panel"
        style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px', width: 'min(90vw, 420px)' }}
        onSubmit={submit}
      >
        <h3>アクセストークンが必要です</h3>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          サーバー起動時のログ(<span className="mono">factory-ui auth token: ...</span>)、または{' '}
          <span className="mono">factory-ui/.auth-token</span> の中身を貼り付けてください。
        </p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          placeholder="トークンを貼り付け"
          style={{
            height: '36px',
            padding: '0 12px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-s)',
            background: 'var(--surface)',
            color: 'var(--text-primary)',
          }}
        />
        {error && (
          <span style={{ color: 'var(--status-err)' }} role="alert">
            {error}
          </span>
        )}
        <button type="submit" className="btn btn-primary">
          保存して再読み込み
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const wsRef = useRef<FactoryWS | null>(null);
  if (wsRef.current === null) wsRef.current = new FactoryWS();
  const ws = wsRef.current;

  const initial = useRef(parseHash(window.location.hash)).current;
  const [factoryName, setFactoryName] = useState('');
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [activeDir, setActiveDir] = useState<string | null>(initial.dir);
  const [activeTab, setActiveTab] = useState<string | null>(initial.tab);
  const [activeItem, setActiveItem] = useState<string | null>(initial.item);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [newChannelError, setNewChannelError] = useState<string | null>(null);
  const [wsDisconnected, setWsDisconnected] = useState(false);
  // トークン未設定/失効時は全画面ゲートを出す(初期値はlocalStorage、以後は401イベントで更新)
  const [tokenMissing, setTokenMissing] = useState(() => getToken() === null);
  // 「+ 新チャンネル」を連打したときにルートターミナルを強制的に作り直す(新セッションを確実に拾わせる)ためのキー
  const [rootTerminalSeq, setRootTerminalSeq] = useState(0);
  // 「+ 新チャンネル」経由でルートターミナルを開いたときだけ、Enterで実行する旨のガイドを出す
  const [newChannelGuide, setNewChannelGuide] = useState(false);

  const reloadFactory = useCallback(async () => {
    try {
      const res = await getFactory();
      setFactoryName(res.name);
      setChannels(res.channels);
    } catch {
      // 一覧取得に失敗しても直前の表示は維持する(ポーリングではなく fs-update 起点の再取得のため)
    }
  }, []);

  // tokenMissingの間は空振り接続(指数バックオフの空回り)を避けるためconnectしない。
  // トークン保存はTokenGateがlocation.reload()で再マウントする方式なので、
  // 保存後はこのeffectが初回マウントとして走り直し、自然にconnectされる
  useEffect(() => {
    if (tokenMissing) return;
    ws.connect();
    return () => ws.close();
  }, [ws, tokenMissing]);

  // api.ts の fetchJson が401受信時に発火する。以後の操作を止めて全画面ゲートへ切り替える
  useEffect(() => {
    const onAuthRequired = () => setTokenMissing(true);
    window.addEventListener('factory-ui-auth-required', onAuthRequired);
    return () => window.removeEventListener('factory-ui-auth-required', onAuthRequired);
  }, []);

  useEffect(() => {
    reloadFactory();
  }, [reloadFactory]);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (msg.type === 'fs-update' && msg.kind === 'system') {
        reloadFactory();
      }
      if (msg.type === 'ws-status') {
        setWsDisconnected(!msg.connected);
        // 再接続に成功したら、切断中に取りこぼした更新を取り戻す
        if (msg.connected) reloadFactory();
      }
    });
  }, [ws, reloadFactory]);

  // ナビ状態 → hash(replaceではなくpushで戻る/進むを効かせる)
  useEffect(() => {
    const next = hashFor(activeDir, activeTab, activeItem);
    if (window.location.hash !== next) window.location.hash = next;
  }, [activeDir, activeTab, activeItem]);

  // hash → ナビ状態(戻る/進む・手入力)
  useEffect(() => {
    const onHashChange = () => {
      const parsed = parseHash(window.location.hash);
      setActiveDir(parsed.dir);
      setActiveTab(parsed.tab);
      setActiveItem(parsed.item);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const selectDir = useCallback((dir: string | null) => {
    setActiveDir(dir);
    setActiveTab(null);
    setActiveItem(null);
    setNewChannelGuide(false);
  }, []);

  /** チャンネル内の任意のタブ・詳細へ遷移する(ダッシュボードの要対応導線などの直行用) */
  const openIn = useCallback((dir: string, tab: string, item: string | null) => {
    setActiveDir(dir);
    setActiveTab(tab);
    setActiveItem(item);
    setNewChannelGuide(false);
  }, []);

  async function handleNewChannel() {
    setCreatingChannel(true);
    setNewChannelError(null);
    try {
      const session = await createSession({ cwd: '' });
      setActiveDir('');
      setActiveTab(null);
      setRootTerminalSeq((n) => n + 1);
      setNewChannelGuide(true);
      // 送信はEnterなしのプリフィル。実行はユーザーがターミナルでEnterする。
      await sendInput(session.id, '/channel-builder', false);
    } catch (e) {
      setNewChannelError(`新チャンネルの起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCreatingChannel(false);
    }
  }

  if (tokenMissing) {
    return <TokenGate />;
  }

  return (
    <ConfirmProvider>
      <div className="app">
        {wsDisconnected && (
          <div className="ws-banner" role="alert">
            サーバーとの接続が切れています。再接続中… — この間の表示は最新ではない可能性があります
          </div>
        )}
        <Sidebar
          factoryName={factoryName}
          channels={channels}
          activeDir={activeDir}
          onSelect={selectDir}
          onNewChannel={handleNewChannel}
          creatingChannel={creatingChannel}
        />
        <main className="main">
          {newChannelError && (
            <div style={{ padding: '12px 20px 0', color: 'var(--status-err)' }} role="alert">
              {newChannelError}
            </div>
          )}
          {activeDir === null ? (
            <div className="main-scroll">
              <Dashboard
                factoryName={factoryName}
                channels={channels}
                onSelectChannel={selectDir}
                onOpenJob={(dir, jobId) => openIn(dir, 'jobs', jobId)}
                onOpenEpisode={(dir, epId, kind) =>
                  openIn(dir, kind === 'short' ? 'shorts' : 'episodes', epId)
                }
                ws={ws}
              />
            </div>
          ) : activeDir === '' ? (
            activeTab === 'jobs' && activeItem !== null ? (
              <div className="main-scroll">
                <JobDetail jobId={activeItem} ws={ws} onBack={() => selectDir(null)} />
              </div>
            ) : (
              <>
                {newChannelGuide && (
                  <div
                    style={{ padding: '12px 20px 0', color: 'var(--text-secondary)' }}
                    aria-live="polite"
                  >
                    下のターミナルに <span className="mono">/channel-builder</span>{' '}
                    を入力済みです。<strong>Enterキーを押すと</strong>新チャンネルの構築が始まります。
                  </div>
                )}
                <TerminalTab key={`root-${rootTerminalSeq}`} dir="" ws={ws} />
              </>
            )
          ) : (
            <ChannelView
              key={activeDir}
              dir={activeDir}
              ws={ws}
              tab={activeTab}
              item={activeItem}
              onNavigate={(tab, item) => {
                setActiveTab(tab);
                setActiveItem(item);
              }}
            />
          )}
        </main>
      </div>
    </ConfirmProvider>
  );
}
