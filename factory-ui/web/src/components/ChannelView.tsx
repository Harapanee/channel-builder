import { useCallback, useEffect, useState } from 'react';
import type { EpisodeSummary, SessionInfo } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import { getChannel, listSessions } from '../api';
import { TerminalDrawer } from './TerminalDrawer';
import { JobsTab } from './JobsTab';
import { EpisodesTab } from './EpisodesTab';
import { GalleryTab } from './GalleryTab';
import { VoicesTab } from './VoicesTab';
import { SettingsTab } from './SettingsTab';

type Tab = 'jobs' | 'episodes' | 'gallery' | 'voices' | 'settings';

const TABS: { key: Tab; label: string }[] = [
  { key: 'jobs', label: 'ジョブ' },
  { key: 'episodes', label: 'エピソード' },
  { key: 'gallery', label: '素材' },
  { key: 'voices', label: '音声' },
  { key: 'settings', label: '設定' },
];

type ChannelData = { system: Record<string, unknown>; episodes: EpisodeSummary[] };

/**
 * 1チャンネルの表示: ヘッダ + タブ(ジョブ/エピソード/素材/音声/設定)。
 *
 * ターミナルは既定では前面に出さない「上級」機能。タブ列の右の「ターミナル(上級)」
 * トグルで下部ドロワー(TerminalDrawer)を開閉する。ドロワーは開いている間だけ
 * マウントし、閉じたらアンマウントする(内包する TerminalTab/xterm ごと破棄)。
 *
 * fs-update(kind:episode/media) がこの dir 宛てなら getChannel(dir) を再取得する。
 * sessions-changed が来たら「この dir で稼働中(running)の最新セッション」を再解決し、
 * EpisodesTab/EpisodeDetail の新規動画・改善・承認ボタンの活性状態に反映する。
 */
export function ChannelView({ dir, ws }: { dir: string; ws: FactoryWS }) {
  const [tab, setTab] = useState<Tab>('jobs');
  const [data, setData] = useState<ChannelData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionInfo | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);

  const reloadChannel = useCallback(async () => {
    try {
      const res = await getChannel(dir);
      setData(res);
      setLoadError(null);
    } catch (e) {
      setLoadError(`チャンネル情報の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [dir]);

  const reloadSessions = useCallback(async () => {
    try {
      const list = await listSessions();
      const latestRunning =
        list
          .filter((s) => s.cwd === dir && s.status === 'running')
          .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
      setActiveSession(latestRunning);
    } catch {
      setActiveSession(null);
    }
  }, [dir]);

  useEffect(() => {
    setTab('jobs');
    setData(null);
    setActiveSession(null);
    setTerminalOpen(false);
    reloadChannel();
    reloadSessions();
  }, [dir, reloadChannel, reloadSessions]);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (msg.type === 'fs-update' && msg.dir === dir && (msg.kind === 'episode' || msg.kind === 'media')) {
        reloadChannel();
      }
      if (msg.type === 'sessions-changed') {
        reloadSessions();
      }
    });
  }, [ws, dir, reloadChannel, reloadSessions]);

  const channelName = typeof data?.system.channelName === 'string' ? data.system.channelName : dir;
  const activeSessionId = activeSession?.id ?? null;
  const approvedEpisodes = Array.isArray(data?.system.approvedEpisodes)
    ? (data.system.approvedEpisodes as unknown[]).map((x) => String(x))
    : [];

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ padding: '20px 20px 0' }}>
        <header style={{ display: 'flex', alignItems: 'baseline', gap: '12px', marginBottom: '12px' }}>
          <h2>{channelName}</h2>
          <span className="mono">{dir}</span>
        </header>
        <div className="tabs" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: '4px' }}>
            {TABS.map(({ key, label }) => (
              <button
                key={key}
                className={`tab${tab === key ? ' active' : ''}`}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            className={`btn ${terminalOpen ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setTerminalOpen((v) => !v)}
          >
            {terminalOpen ? 'ターミナルを閉じる' : 'ターミナル(上級)'}
          </button>
        </div>
      </div>

      <div className="main-scroll">
        {loadError && (
          <div style={{ color: 'var(--status-err)', marginBottom: '12px' }}>{loadError}</div>
        )}
        {tab === 'jobs' && <JobsTab dir={dir} ws={ws} episodes={data?.episodes ?? []} />}
        {tab === 'episodes' &&
          (data ? (
            <EpisodesTab
              dir={dir}
              ws={ws}
              episodes={data.episodes}
              approvedEpisodes={approvedEpisodes}
              onChanged={reloadChannel}
              onOpenSettings={() => setTab('settings')}
            />
          ) : (
            <div className="empty">読み込み中…</div>
          ))}
        {tab === 'gallery' && <GalleryTab dir={dir} ws={ws} activeSessionId={activeSessionId} />}
        {tab === 'voices' && <VoicesTab dir={dir} />}
        {tab === 'settings' && <SettingsTab dir={dir} />}
      </div>

      {terminalOpen && (
        <TerminalDrawer dir={dir} ws={ws} onClose={() => setTerminalOpen(false)} />
      )}
    </div>
  );
}
