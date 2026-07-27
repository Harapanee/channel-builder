import { useState, type CSSProperties } from 'react';
import { createJob } from '../api';
import { EFFORT_HINT, MODEL_HINT } from './OperationLauncher';

const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

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
 * チャンネルアナライザーのランチャー(ダッシュボード設置)。
 * 参考チャンネルのURLを受けて /channel-analyze をルートジョブ(dir='')として起動する。
 * 進捗・ログ・完了は既存のジョブ詳細ビュー(#/root/jobs/<id>)で見る。
 * 成果物はスタイル定義 docs/style-profiles/<slug>.md — /channel-builder への受け渡しは人間が確認後に手動。
 */
export function ChannelAnalyzePanel({ onStarted }: { onStarted: (jobId: string) => void }) {
  const [url, setUrl] = useState('');
  const [model, setModel] = useState('opus');
  const [effort, setEffort] = useState('high');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = url.trim();
  const looksValid = /^(@|https?:\/\/)/.test(trimmed);

  async function launch() {
    setStarting(true);
    setError(null);
    try {
      const j = await createJob({ dir: '', operation: 'channel-analyze', arg: trimmed, model, effort });
      setUrl('');
      onStarted(j.id);
    } catch (e) {
      setError(`分析ジョブの起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="panel" style={{ padding: '16px' }}>
      <details className="collapse">
        <summary>
          <h3 style={{ display: 'inline' }}>チャンネルアナライザー</h3>
          <span className="collapse-hint">参考チャンネルを分析してスタイル定義を作る</span>
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span className="mono">参考チャンネルのURL(@ハンドル可)</span>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="例: https://www.youtube.com/@example または @example"
              style={{ ...inputStyle, height: '36px', padding: '0 12px' }}
            />
          </label>
          {trimmed !== '' && !looksValid && (
            <span style={{ color: 'var(--status-err)' }}>
              URL(https://…)か @ハンドルで指定してください
            </span>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={starting || !looksValid}
              onClick={launch}
            >
              {starting ? '起動中…' : '分析を開始'}
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
            </span>
          </div>
          <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
            {MODEL_HINT} / {EFFORT_HINT}
          </span>
          <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
            成果物はスタイル定義(docs/style-profiles/)。内容を確認してから「+ 新チャンネル」の /channel-builder に渡してください
          </span>
        </div>
      </details>
    </section>
  );
}
