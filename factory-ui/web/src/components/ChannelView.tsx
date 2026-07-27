import { useCallback, useEffect, useState } from 'react';
import type { SessionInfo } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import { getChannel, listSessions, listYoutubeUploads, type ChannelResponse } from '../api';
import { TerminalDrawer } from './TerminalDrawer';
import { JobsTab } from './JobsTab';
import { EpisodesTab } from './EpisodesTab';
import { ShortsTab } from './ShortsTab';
import { GalleryTab } from './GalleryTab';
import { SettingsTab } from './SettingsTab';

type Tab = 'jobs' | 'episodes' | 'shorts' | 'gallery' | 'settings';

const TABS: { key: Tab; label: string }[] = [
  { key: 'jobs', label: 'ジョブ' },
  { key: 'episodes', label: 'エピソード' },
  { key: 'shorts', label: 'ショート' },
  { key: 'gallery', label: '素材' },
  { key: 'settings', label: '設定' },
];

type ChannelData = ChannelResponse;

/**
 * 1チャンネルの表示: ヘッダ + タブ(ジョブ/エピソード/ショート/素材/設定)。
 * 音声試聴は設定タブ内のセクション(旧 #/ch/<dir>/voices は settings へ読み替える)。
 *
 * ナビ状態(タブ・タブ内の詳細ID)は自前で持たず、親(App)の hash 同期状態を
 * そのまま描画する完全制御型。タブ切替・詳細の開閉はすべて onNavigate 経由で
 * hash に反映されるため、リロード・戻る/進む・URL共有で現在地を失わない。
 *
 * ターミナルは既定では前面に出さない「上級」機能。タブ列の右の「ターミナル(上級)」
 * トグルで下部ドロワー(TerminalDrawer)を開閉する。ドロワーは開いている間だけ
 * マウントし、閉じたらアンマウントする(内包する TerminalTab/xterm ごと破棄)。
 *
 * fs-update(kind:episode/media) がこの dir 宛てなら getChannel(dir) を再取得する。
 * sessions-changed が来たら「この dir で稼働中(running)の最新セッション」を再解決し、
 * EpisodesTab/EpisodeDetail の新規動画・改善・承認ボタンの活性状態に反映する。
 */
const TAB_KEYS: readonly string[] = TABS.map((t) => t.key);

/** hash由来のタブ値を正規化する。旧 'voices' は settings へ、不正値は jobs へ */
function resolveTab(raw: string | null | undefined): Tab {
  if (raw === 'voices') return 'settings';
  return raw && TAB_KEYS.includes(raw) ? (raw as Tab) : 'jobs';
}

export function ChannelView({
  dir,
  ws,
  tab: rawTab,
  item,
  onNavigate,
}: {
  dir: string;
  ws: FactoryWS;
  /** hashルーティング由来のタブ(不正値はjobsへフォールバック) */
  tab?: string | null;
  /** hashルーティング由来のタブ内詳細ID(jobs=jobId / episodes=epId / shorts=shortId) */
  item?: string | null;
  /** タブ・詳細の変更をhashへ反映するためのコールバック */
  onNavigate: (tab: string, item: string | null) => void;
}) {
  const tab = resolveTab(rawTab);
  const setTab = useCallback(
    (next: Tab) => {
      onNavigate(next, null);
    },
    [onNavigate],
  );
  const [data, setData] = useState<ChannelData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionInfo | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [shortsPresetEpId, setShortsPresetEpId] = useState<string | undefined>(undefined);
  // このチャンネルでYouTube公開済み(アップロード完了)のID → 動画URL。
  // 一覧の「公開済み」リンク表示に使う(情報源は youtube-uploads.json = factory-ui経由の実績)
  const [publishedUrls, setPublishedUrls] = useState<Record<string, string>>({});

  const reloadUploads = useCallback(async () => {
    try {
      const { jobs } = await listYoutubeUploads();
      const map: Record<string, string> = {};
      // 一覧は新しい順。同一epIdの再アップロードは最新(先勝ち)のURLを採用する
      for (const j of jobs) {
        if (j.dir === dir && j.status === 'done' && j.url && map[j.epId] === undefined) {
          map[j.epId] = j.url;
        }
      }
      setPublishedUrls(map);
    } catch {
      /* 公開済み表示は付加情報。取得失敗でも一覧表示は続ける */
    }
  }, [dir]);

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
    setData(null);
    setActiveSession(null);
    setTerminalOpen(false);
    setShortsPresetEpId(undefined);
    reloadChannel();
    reloadSessions();
    reloadUploads();
  }, [dir, reloadChannel, reloadSessions, reloadUploads]);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (msg.type === 'fs-update' && msg.dir === dir && (msg.kind === 'episode' || msg.kind === 'short' || msg.kind === 'media')) {
        reloadChannel();
      }
      if (msg.type === 'sessions-changed') {
        reloadSessions();
      }
      // アップロード完了で「公開済み」リンクを即時反映する
      if (msg.type === 'youtube-upload' && msg.job.dir === dir && msg.job.status === 'done') {
        reloadUploads();
      }
      // WS再接続: 切断中に取りこぼしたfs-update/sessions-changedを取り戻す
      if (msg.type === 'ws-status' && msg.connected) {
        reloadChannel();
        reloadSessions();
        reloadUploads();
      }
    });
  }, [ws, dir, reloadChannel, reloadSessions, reloadUploads]);

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
        {/* タブ列(tablist)とターミナルトグルは別要素として並べる(タブの意味論にボタンを混ぜない) */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <div className="tabs" style={{ borderBottom: 'none' }} role="tablist" aria-label="チャンネル内タブ">
            {TABS.map(({ key, label }) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
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
        {tab === 'jobs' && (
          <JobsTab
            dir={dir}
            ws={ws}
            episodes={data?.episodes ?? []}
            selectedJobId={item ?? null}
            onSelectJob={(jobId) => onNavigate('jobs', jobId)}
            onOpenEpisode={(epId, kind) =>
              onNavigate(kind === 'short' ? 'shorts' : 'episodes', epId)
            }
          />
        )}
        {tab === 'episodes' &&
          (data ? (
            <EpisodesTab
              dir={dir}
              ws={ws}
              episodes={data.episodes}
              approvedEpisodes={approvedEpisodes}
              publishedUrls={publishedUrls}
              selectedId={item ?? null}
              onSelect={(epId) => onNavigate('episodes', epId)}
              onOpenJob={(jobId) => onNavigate('jobs', jobId)}
              onChanged={reloadChannel}
              onOpenSettings={() => setTab('settings')}
              onCreateShort={(epId) => {
                setShortsPresetEpId(epId);
                setTab('shorts');
              }}
            />
          ) : (
            <div className="empty">読み込み中…</div>
          ))}
        {tab === 'shorts' &&
          (data ? (
            <ShortsTab
              dir={dir}
              ws={ws}
              shorts={data.shorts ?? []}
              shortFormats={data.shortFormats ?? []}
              episodes={data.episodes}
              publishedUrls={publishedUrls}
              presetEpisodeId={shortsPresetEpId}
              selectedId={item ?? null}
              onSelect={(shortId) => onNavigate('shorts', shortId)}
              onChanged={reloadChannel}
              onJobStarted={(jobId) => onNavigate('jobs', jobId)}
            />
          ) : (
            <div className="empty">読み込み中…</div>
          ))}
        {tab === 'gallery' && <GalleryTab dir={dir} ws={ws} activeSessionId={activeSessionId} />}
        {tab === 'settings' && <SettingsTab dir={dir} />}
      </div>

      {terminalOpen && (
        <TerminalDrawer dir={dir} ws={ws} onClose={() => setTerminalOpen(false)} />
      )}
    </div>
  );
}
