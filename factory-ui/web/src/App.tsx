import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChannelSummary } from '../../shared/types';
import { FactoryWS } from './ws';
import { TerminalTab } from './components/TerminalTab';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './components/Dashboard';
import { ChannelView } from './components/ChannelView';
import { createSession, getFactory, sendInput } from './api';

/**
 * アプリの骨格。左Sidebar(チャンネル一覧+「+ 新チャンネル」)+ 右にDashboardまたはChannelView。
 *
 * activeDir の意味:
 *  - null: ダッシュボード(メインの既定ビュー。要対応インボックス + チャンネルカードのグリッド)
 *  - '' : ファクトリールートのターミナル(「+ 新チャンネル」で /channel-builder をプリフィルする専用ビュー)
 *  - それ以外: そのdirのChannelView
 *
 * WS接続(FactoryWS)は1本をここで生成し、TerminalTab/ChannelView/Dashboard へ共有する。
 */
export default function App() {
  const wsRef = useRef<FactoryWS | null>(null);
  if (wsRef.current === null) wsRef.current = new FactoryWS();
  const ws = wsRef.current;

  const [factoryName, setFactoryName] = useState('');
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [activeDir, setActiveDir] = useState<string | null>(null);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [newChannelError, setNewChannelError] = useState<string | null>(null);
  // 「+ 新チャンネル」を連打したときにルートターミナルを強制的に作り直す(新セッションを確実に拾わせる)ためのキー
  const [rootTerminalSeq, setRootTerminalSeq] = useState(0);

  const reloadFactory = useCallback(async () => {
    try {
      const res = await getFactory();
      setFactoryName(res.name);
      setChannels(res.channels);
    } catch {
      // 一覧取得に失敗しても直前の表示は維持する(ポーリングではなく fs-update 起点の再取得のため)
    }
  }, []);

  useEffect(() => {
    ws.connect();
    return () => ws.close();
  }, [ws]);

  useEffect(() => {
    reloadFactory();
  }, [reloadFactory]);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (msg.type === 'fs-update' && msg.kind === 'system') {
        reloadFactory();
      }
    });
  }, [ws, reloadFactory]);

  async function handleNewChannel() {
    setCreatingChannel(true);
    setNewChannelError(null);
    try {
      const session = await createSession({ cwd: '' });
      setActiveDir('');
      setRootTerminalSeq((n) => n + 1);
      // 送信はEnterなしのプリフィル。実行はユーザーがターミナルでEnterする。
      await sendInput(session.id, '/channel-builder', false);
    } catch (e) {
      setNewChannelError(`新チャンネルの起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCreatingChannel(false);
    }
  }

  return (
    <div className="app">
      <Sidebar
        factoryName={factoryName}
        channels={channels}
        activeDir={activeDir}
        onSelect={setActiveDir}
        onNewChannel={handleNewChannel}
        creatingChannel={creatingChannel}
      />
      <main className="main">
        {newChannelError && (
          <div style={{ padding: '12px 20px 0', color: 'var(--status-err)' }}>
            {newChannelError}
          </div>
        )}
        {activeDir === null ? (
          <div className="main-scroll">
            <Dashboard
              factoryName={factoryName}
              channels={channels}
              onSelectChannel={setActiveDir}
              ws={ws}
            />
          </div>
        ) : activeDir === '' ? (
          <TerminalTab key={`root-${rootTerminalSeq}`} dir="" ws={ws} />
        ) : (
          <ChannelView key={activeDir} dir={activeDir} ws={ws} />
        )}
      </main>
    </div>
  );
}
