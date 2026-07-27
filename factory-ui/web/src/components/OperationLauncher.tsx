import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { BacklogCandidate, EpisodeSummary, JobMode } from '../../../shared/types';
import { createJob, getBacklog, getFileText } from '../api';
import { JOB_MODE_LABEL } from '../status';

type LauncherTab = 'video' | 'refine' | 'scout' | 'ask';

const TABS: { key: LauncherTab; label: string }[] = [
  { key: 'video', label: '新規動画' },
  { key: 'refine', label: '改善' },
  { key: 'scout', label: 'ネタ帳を補充' },
  { key: 'ask', label: '質問' },
];

const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

// モデル/effortの1行ヒント(選択に迷わないための共通文言。ShortsTabと揃える)
export const MODEL_HINT = 'モデル: opus=標準(推奨) / sonnet=高速・軽量 / haiku=最軽量 / fable=最上位';
export const EFFORT_HINT = 'effort: 思考の深さ。high=標準(推奨) / xhigh=最高品質・消費大 / low=高速';

const DURATION_PRESETS: { label: string; sec: number | null; maxSec?: number }[] = [
  { label: 'おまかせ', sec: null },
  { label: '1分', sec: 60 },
  { label: '3分', sec: 180 },
  { label: '5分', sec: 300 },
  { label: '10分', sec: 600 },
  // maxSec があるプリセットは範囲指定(下限=sec・上限=maxSec)。尺は工程0で範囲内から決定される
  { label: '8〜15分', sec: 480, maxSec: 900 },
];

const MODE_HINTS: Record<JobMode, string> = {
  manual: '各確認ポイントで毎回停止します',
  semi: 'レンダー前の目視確認だけ停止します',
  auto: '全確認をおすすめで自走します(目視確認なし)',
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
 * 新規操作ランチャー(共通コンポーネント)。JobsTab と EpisodeDetail に設置する。
 * モード切替: 新規動画(題材おすすめ+尺+モード) / 改善(3欄まとめて送信) / ネタ帳補充 / 質問。
 * フッターでモデル×effortを選ぶ(既定 opus×high)。送信はすべて POST /jobs(キューで順次実行)。
 *
 * 既定は折りたたみ(監視情報を上に出すため。DESIGN.md「状態が先・操作が後」)。
 * defaultOpen=true で開いた状態から始める(ジョブ0件の新品チャンネルなど)。
 */
export function OperationLauncher({
  dir,
  episodes,
  presetEpisodeId,
  defaultOpen = false,
  title = '新規操作を起動',
  onStarted,
}: {
  dir: string;
  episodes: EpisodeSummary[];
  presetEpisodeId?: string;
  /** trueで初期展開。あとから true に変わったときも展開する(初回ロード完了後の判定に追従) */
  defaultOpen?: boolean;
  title?: string;
  onStarted?: (jobId: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // defaultOpen が後から true になったら開く(閉じる方向へは追従しない=ユーザー操作を上書きしない)
  const prevDefaultOpen = useRef(defaultOpen);
  useEffect(() => {
    if (defaultOpen && !prevDefaultOpen.current) setOpen(true);
    prevDefaultOpen.current = defaultOpen;
  }, [defaultOpen]);
  const [tab, setTab] = useState<LauncherTab>(presetEpisodeId ? 'refine' : 'video');
  const [model, setModel] = useState<string>('opus');
  const [effort, setEffort] = useState<string>('high');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 新規動画
  const [subject, setSubject] = useState('');
  const [presetSec, setPresetSec] = useState<number | null>(null);
  const [presetMaxSec, setPresetMaxSec] = useState<number | null>(null);
  const [customSec, setCustomSec] = useState('');
  const [mode, setMode] = useState<JobMode>('manual');
  const [candidates, setCandidates] = useState<BacklogCandidate[]>([]);

  // 改善(3欄)
  const [channelText, setChannelText] = useState('');
  const [episodeText, setEpisodeText] = useState('');
  const [episodeId, setEpisodeId] = useState('');
  const [factoryText, setFactoryText] = useState('');

  // 質問
  const [question, setQuestion] = useState('');

  // ネタ帳全文ビュー(開いたときに初めて取得する)
  const [backlogText, setBacklogText] = useState<string | null>(null);
  const [backlogError, setBacklogError] = useState<string | null>(null);

  function loadBacklogText() {
    if (backlogText !== null || backlogError !== null) return; // 取得済み
    getFileText(dir, 'channel/backlog.md')
      .then((text) => setBacklogText(text))
      .catch((e) =>
        setBacklogError(
          e instanceof Error && e.message.includes('404')
            ? 'ネタ帳(channel/backlog.md)はまだありません。「ネタ帳を補充」で作成できます。'
            : `ネタ帳の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
  }

  useEffect(() => {
    setBacklogText(null);
    setBacklogError(null);
    getBacklog(dir)
      .then((r) => setCandidates(r.candidates))
      .catch(() => setCandidates([]));
  }, [dir]);

  useEffect(() => {
    setEpisodeId(presetEpisodeId ?? episodes[0]?.episodeId ?? '');
  }, [presetEpisodeId, episodes]);

  const customNum = customSec.trim() === '' ? null : Number(customSec);
  const customInvalid =
    customNum !== null && (!Number.isFinite(customNum) || customNum < 10 || customNum > 3600);
  const durationSec = customNum ?? presetSec ?? undefined;
  // 秒数の直接指定があるときは範囲プリセットを無効化(単一値が優先)
  const durationSecMax = customNum !== null ? undefined : presetMaxSec ?? undefined;

  const canSubmit = (() => {
    if (starting) return false;
    if (tab === 'video') return !customInvalid;
    if (tab === 'refine') {
      const any = channelText.trim() || episodeText.trim() || factoryText.trim();
      if (!any) return false;
      return episodeText.trim() === '' || episodeId !== '';
    }
    if (tab === 'ask') return question.trim() !== '';
    return true; // scout
  })();

  async function launch() {
    setStarting(true);
    setError(null);
    setNotice(null);
    try {
      const common = { dir, model, effort };
      if (tab === 'video') {
        const j = await createJob({
          ...common,
          operation: 'video-create',
          arg: subject.trim(),
          mode,
          durationSec: durationSec ?? undefined,
          durationSecMax,
        });
        setSubject('');
        setNotice('新規動画の制作ジョブを起動しました');
        onStarted?.(j.id);
      } else if (tab === 'refine') {
        const entries: { operation: string; arg: string; episodeId?: string }[] = [];
        if (channelText.trim()) entries.push({ operation: 'channel-refine', arg: channelText.trim() });
        if (episodeText.trim())
          entries.push({ operation: 'channel-refine', arg: episodeText.trim(), episodeId });
        if (factoryText.trim()) entries.push({ operation: 'system-refine', arg: factoryText.trim() });
        let firstId: string | null = null;
        for (const e of entries) {
          const j = await createJob({ ...common, ...e });
          firstId ??= j.id;
          if (e.operation === 'system-refine') setFactoryText('');
          else if (e.episodeId) setEpisodeText('');
          else setChannelText('');
        }
        setNotice(`${entries.length}件の改善ジョブを送信しました(キューで順次実行)`);
        if (firstId) onStarted?.(firstId);
      } else if (tab === 'scout') {
        const j = await createJob({ ...common, operation: 'theme-scout' });
        setNotice('ネタ帳の補充ジョブを起動しました');
        onStarted?.(j.id);
      } else {
        const j = await createJob({ ...common, operation: 'ask', arg: question.trim() });
        setQuestion('');
        setNotice('質問ジョブを起動しました(回答はジョブ詳細の「回答」に表示されます)');
        onStarted?.(j.id);
      }
    } catch (e) {
      const hint = tab === 'refine' ? '(記入が残っている欄は未送信です。再度送信してください)' : '';
      setError(`操作の起動に失敗しました: ${e instanceof Error ? e.message : String(e)}${hint}`);
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="panel" style={{ padding: '16px' }}>
      <details
        className="collapse"
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
      >
        <summary>
          <h3 style={{ display: 'inline' }}>{title}</h3>
          <span className="collapse-hint">新規動画・改善・ネタ帳補充・質問</span>
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`btn ${tab === t.key ? 'btn-primary' : 'btn-ghost'}`}
            aria-pressed={tab === t.key}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'video' && (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span className="mono">題材(空欄=ネタ帳からおすすめを自動選定)</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="例: 織田信長"
              style={{ ...inputStyle, height: '36px', padding: '0 12px' }}
            />
          </label>
          {candidates.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span className="mono">ネタ帳のおすすめ(クリックで題材に設定)</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {candidates.slice(0, 10).map((c) => (
                  <button
                    key={c.rank}
                    type="button"
                    className={`btn ${subject === c.subject ? 'btn-primary' : 'btn-ghost'}`}
                    aria-pressed={subject === c.subject}
                    onClick={() => setSubject(c.subject)}
                    title={`順位${c.rank}・計${c.score}点`}
                  >
                    {c.rank}. {c.subject}
                  </button>
                ))}
              </div>
            </div>
          )}
          <details className="collapse" onToggle={(e) => e.currentTarget.open && loadBacklogText()}>
            <summary>
              <h4 style={{ display: 'inline' }}>ネタ帳を見る</h4>
              <span className="collapse-hint">channel/backlog.md の全文</span>
            </summary>
            {backlogError ? (
              <span style={{ color: 'var(--text-secondary)' }}>{backlogError}</span>
            ) : backlogText === null ? (
              <div className="empty">読み込み中…</div>
            ) : (
              <pre className="doc-view" style={{ maxHeight: '360px', overflowY: 'auto' }}>
                {backlogText}
              </pre>
            )}
          </details>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span className="mono">動画の長さ</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
              {DURATION_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={`btn ${presetSec === p.sec && presetMaxSec === (p.maxSec ?? null) && customSec.trim() === '' ? 'btn-primary' : 'btn-ghost'}`}
                  aria-pressed={presetSec === p.sec && presetMaxSec === (p.maxSec ?? null) && customSec.trim() === ''}
                  onClick={() => {
                    setPresetSec(p.sec);
                    setPresetMaxSec(p.maxSec ?? null);
                    setCustomSec('');
                  }}
                >
                  {p.label}
                </button>
              ))}
              <input
                type="number"
                value={customSec}
                onChange={(e) => setCustomSec(e.target.value)}
                placeholder="秒数を直接指定"
                min={10}
                max={3600}
                style={{ ...inputStyle, height: '32px', padding: '0 10px', width: '140px' }}
              />
              {customInvalid && (
                <span style={{ color: 'var(--status-err)' }}>10〜3600秒で指定してください</span>
              )}
            </div>
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
        </>
      )}

      {tab === 'refine' && (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span className="mono">チャンネルの改善(/channel-refine)</span>
            <textarea
              rows={2}
              value={channelText}
              onChange={(e) => setChannelText(e.target.value)}
              placeholder="例: 冒頭のフックが弱い動画が多い"
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span className="mono">個別の動画の改善(対象エピソードを選択)</span>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
              <select
                value={episodeId}
                onChange={(e) => setEpisodeId(e.target.value)}
                style={{ ...inputStyle, height: '36px' }}
              >
                {episodes.length === 0 && <option value="">(エピソードなし)</option>}
                {episodes.map((ep) => (
                  <option key={ep.episodeId} value={ep.episodeId}>
                    {ep.episodeId}
                    {ep.subject ? ` — ${ep.subject}` : ''}
                  </option>
                ))}
              </select>
              <textarea
                rows={2}
                value={episodeText}
                onChange={(e) => setEpisodeText(e.target.value)}
                placeholder="例: ep010の字幕がはみ出している"
                style={{ ...inputStyle, resize: 'vertical', flex: 1 }}
              />
            </div>
            {episodes.length === 0 && episodeText.trim() !== '' && (
              <span style={{ color: 'var(--status-err)' }}>
                エピソードが無いため個別動画の改善は送信できません
              </span>
            )}
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span className="mono">工場の改善(/system-refine)</span>
            <textarea
              rows={2}
              value={factoryText}
              onChange={(e) => setFactoryText(e.target.value)}
              placeholder="例: レビュー工程のチェック項目を増やしたい"
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </label>
          <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
            記入した欄の数だけジョブを作成し、キューで順番に実行します
          </span>
        </>
      )}

      {tab === 'scout' && (
        <span style={{ color: 'var(--text-secondary)' }}>
          ネタ帳(backlog.md)の候補を探索・採点して補充します
        </span>
      )}

      {tab === 'ask' && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span className="mono">質問内容(読み取り専用で回答します。ファイルは変更しません)</span>
          <textarea
            rows={3}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="例: ep010は今どの工程?残り作業は?"
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        </label>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={launch}>
          {starting ? (tab === 'refine' ? '送信中…' : '起動中…') : tab === 'refine' ? 'まとめて送信' : '起動'}
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
        </div>
      </details>
    </section>
  );
}
