import { useEffect, useState, type CSSProperties } from 'react';
import type { EpisodeSummary, JobMode, ShortFormatSummary, ShortSummary } from '../../../shared/types';
import { createJob } from '../api';
import { badgeClassFor, JOB_MODE_LABEL, statusLabel } from '../status';
import type { FactoryWS } from '../ws';
import { EFFORT_HINT, MODEL_HINT } from './OperationLauncher';
import { ShortDetail } from './ShortDetail';

// short-create の元エピソードに選べる status(short-create スキルの選択基準と同じ)
const ELIGIBLE_STATUSES = new Set(['implemented', 'prechecked', 'qa_passed', 'reviewed', 'packaged', 'render_ready', 'final']);
// 初期値に優先するstatus(完成・承認済み・レンダー待ち=ショート化の典型的な元)
const PREFERRED_DEFAULT_STATUSES = new Set(['final', 'approved', 'render_ready']);

const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

const MODE_HINTS: Record<JobMode, string> = {
  manual: '台本承認・Studio確認で毎回停止します',
  semi: 'Studio確認だけ停止します',
  auto: '全確認をおすすめで自走します(Studio確認なし。非推奨)',
};

const inputStyle: CSSProperties = {
  padding: '8px 12px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-s)',
  background: 'var(--surface)',
  color: 'var(--text-primary)',
  fontSize: '14px',
  fontFamily: 'var(--font-body)',
};

/**
 * ショートタブ: /short-create ランチャー + ショート一覧(クリックで ShortDetail)+
 * 登録済みフォーマット一覧(表示のみ。新規登録・改修はターミナルの /short-builder)。
 */
export function ShortsTab({
  dir,
  ws,
  shorts,
  shortFormats,
  episodes,
  publishedUrls = {},
  presetEpisodeId,
  selectedId,
  onSelect,
  onChanged,
  onJobStarted,
}: {
  dir: string;
  ws: FactoryWS;
  shorts: ShortSummary[];
  shortFormats: ShortFormatSummary[];
  episodes: EpisodeSummary[];
  /** YouTube公開済み(アップロード完了)の shortId → 動画URL(親 ChannelView が uploads から抽出) */
  publishedUrls?: Record<string, string>;
  presetEpisodeId?: string;
  /** hash同期の選択状態(制御型)。リロード・戻る/進むで詳細を失わない */
  selectedId: string | null;
  onSelect: (shortId: string | null) => void;
  onChanged?: () => void;
  onJobStarted?: (jobId: string) => void;
}) {
  // 新しい順(epId降順)。テスト用エピソード(ep000-*)は別グループへ分離する
  const eligibleEpisodes = episodes
    .filter((e) => e.status !== undefined && ELIGIBLE_STATUSES.has(e.status))
    .sort((a, b) => b.episodeId.localeCompare(a.episodeId));
  const normalEpisodes = eligibleEpisodes.filter((e) => !e.episodeId.startsWith('ep000-'));
  const testEpisodes = eligibleEpisodes.filter((e) => e.episodeId.startsWith('ep000-'));

  const [sourceEpId, setSourceEpId] = useState('');
  const [formatId, setFormatId] = useState('');
  const [mode, setMode] = useState<JobMode>('manual');
  const [model, setModel] = useState<string>('opus');
  const [effort, setEffort] = useState<string>('high');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    // 初期値: final/approved/render_ready の最新(epId降順で最初)→ 無ければテスト用以外の最新 → 最後の手段で全体の先頭
    const preferred =
      normalEpisodes.find((e) => e.status !== undefined && PREFERRED_DEFAULT_STATUSES.has(e.status))?.episodeId ??
      normalEpisodes[0]?.episodeId ??
      eligibleEpisodes[0]?.episodeId ??
      '';
    setSourceEpId(presetEpisodeId ?? preferred);
    // presetEpisodeId(エピソード詳細からの導線)と対象チャンネルの切替時のみ再初期化する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetEpisodeId, dir]);

  useEffect(() => {
    setFormatId(shortFormats[0]?.formatId ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, shortFormats.length]);

  async function launch() {
    if (starting || sourceEpId === '' || formatId === '') return;
    setStarting(true);
    setError(null);
    setNotice(null);
    try {
      const j = await createJob({
        dir,
        operation: 'short-create',
        arg: `${sourceEpId} ${formatId}`,
        mode,
        model,
        effort,
      });
      setNotice(`ショート制作ジョブを起動しました(${sourceEpId} → ${formatId})`);
      onJobStarted?.(j.id);
    } catch (e) {
      setError(`起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setStarting(false);
    }
  }

  const selected = selectedId ? shorts.find((s) => s.shortId === selectedId) ?? null : null;
  if (selected) {
    return (
      <ShortDetail
        dir={dir}
        short={selected}
        ws={ws}
        onChanged={onChanged}
        onJobStarted={onJobStarted}
        onBack={() => onSelect(null)}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <section
        className="panel"
        style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}
      >
        <h3>ショートを作成(/short-create)</h3>
        {eligibleEpisodes.length === 0 ? (
          <div className="empty">元にできるエピソード(実装済み以降)がまだありません</div>
        ) : shortFormats.length === 0 ? (
          <div className="empty">
            フォーマットが未登録です。ターミナルで /short-builder を実行して登録してください
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span className="mono">元エピソード</span>
                <select
                  value={sourceEpId}
                  onChange={(e) => setSourceEpId(e.target.value)}
                  style={{ ...inputStyle, height: '36px' }}
                >
                  {normalEpisodes.map((ep) => (
                    <option key={ep.episodeId} value={ep.episodeId}>
                      {ep.episodeId}
                      {ep.subject ? ` — ${ep.subject}` : ''}
                    </option>
                  ))}
                  {testEpisodes.length > 0 && (
                    <optgroup label="テスト用">
                      {testEpisodes.map((ep) => (
                        <option key={ep.episodeId} value={ep.episodeId}>
                          {ep.episodeId}
                          {ep.subject ? ` — ${ep.subject}` : ''}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span className="mono">フォーマット</span>
                <select
                  value={formatId}
                  onChange={(e) => setFormatId(e.target.value)}
                  style={{ ...inputStyle, height: '36px' }}
                >
                  {shortFormats.map((f) => (
                    <option key={f.formatId} value={f.formatId}>
                      {f.formatId}
                      {f.name ? ` — ${f.name}` : ''}
                      {f.targetDurationSec ? `(約${f.targetDurationSec}秒)` : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span className="mono">実行モード</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                {(Object.keys(JOB_MODE_LABEL) as JobMode[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`btn ${mode === k ? 'btn-primary' : 'btn-ghost'}`}
                    aria-pressed={mode === k}
                    onClick={() => setMode(k)}
                  >
                    {JOB_MODE_LABEL[k]}
                  </button>
                ))}
                <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>{MODE_HINTS[mode]}</span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={starting || sourceEpId === '' || formatId === ''}
                onClick={launch}
              >
                {starting ? '起動中…' : '起動'}
              </button>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span className="mono">モデル</span>
                <select value={model} onChange={(e) => setModel(e.target.value)} style={{ ...inputStyle, height: '32px', padding: '0 8px' }}>
                  {MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span className="mono">effort</span>
                <select value={effort} onChange={(e) => setEffort(e.target.value)} style={{ ...inputStyle, height: '32px', padding: '0 8px' }}>
                  {EFFORTS.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </label>
              <span aria-live="polite">
                {error && <span style={{ color: 'var(--status-err)' }}>{error}</span>}
                {notice && !error && <span style={{ color: 'var(--status-ok)' }}>{notice}</span>}
              </span>
            </div>
            <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
              {MODEL_HINT} / {EFFORT_HINT}
            </span>
          </>
        )}
      </section>

      {shorts.length === 0 ? (
        <div className="empty">ショートがまだありません</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {shorts.map((sh) => (
            <div
              key={sh.shortId}
              className="card clickable"
              role="button"
              tabIndex={0}
              onClick={() => onSelect(sh.shortId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(sh.shortId);
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
                padding: '12px 16px',
              }}
            >
              <span className="mono">{sh.shortId}</span>
              <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{sh.title ?? ''}</span>
              {sh.sourceEpisodeId && (
                <span className="mono" style={{ color: 'var(--text-secondary)' }}>← {sh.sourceEpisodeId}</span>
              )}
              {sh.hasFinal && <span className="mono" style={{ color: 'var(--text-secondary)' }}>本番あり</span>}
              {publishedUrls[sh.shortId] && (
                <a
                  className="mono"
                  style={{ color: 'var(--status-ok)', fontWeight: 600 }}
                  href={publishedUrls[sh.shortId]}
                  target="_blank"
                  rel="noreferrer"
                  title="YouTubeで開く"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  ▶ 公開済み
                </a>
              )}
              {/* 状態バッジは行の右端に固定幅スロットで置く(行ごとの表示有無で位置が揺れないように) */}
              <span className="status-slot">
                <span className={badgeClassFor(sh.status)}>{statusLabel(sh.status)}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      <section
        className="panel"
        style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}
      >
        <h3>登録済みフォーマット</h3>
        {shortFormats.length === 0 ? (
          <div className="empty">
            まだありません。ターミナルで /short-builder を実行して登録してください
          </div>
        ) : (
          shortFormats.map((f) => (
            <div key={f.formatId} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span className="mono">{f.formatId}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{f.name ?? ''}</span>
              {f.targetDurationSec !== undefined && (
                <span className="mono" style={{ color: 'var(--text-secondary)' }}>約{f.targetDurationSec}秒</span>
              )}
            </div>
          ))
        )}
        <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
          フォーマットの新規登録・改修はターミナルの /short-builder で行います
        </span>
      </section>
    </div>
  );
}
