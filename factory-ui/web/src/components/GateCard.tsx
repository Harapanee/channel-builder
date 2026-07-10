import { useEffect, useState } from 'react';
import type { GateRequest } from '../../../shared/types';
import { getStudioStatus, respondGate, startStudio, stopStudio } from '../api';

/**
 * render-check用: Remotion Studio の起動・リンク・停止(サーバーが該当チャンネルで
 * `npm run studio` を起動し、疎通確認後にURLが返る)。
 */
function StudioLauncher({ dir, episodeId }: { dir: string; episodeId?: string }) {
  const [state, setState] = useState<'idle' | 'starting' | 'ready'>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 画面を開き直しても稼働中なら状態を合わせる
  useEffect(() => {
    getStudioStatus()
      .then((s) => {
        if (s.running && s.dir === dir && s.status === 'ready') {
          setUrl(s.url);
          setState('ready');
        }
      })
      .catch(() => {});
  }, [dir]);

  async function handleStart() {
    setState('starting');
    setError(null);
    try {
      const res = await startStudio(dir, episodeId);
      setUrl(res.url);
      setState('ready');
    } catch (e) {
      setState('idle');
      setError(`Studioの起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleStop() {
    try {
      await stopStudio();
    } catch {
      // 停止失敗は致命的でないので黙って状態だけ戻す
    }
    setUrl(null);
    setState('idle');
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '10px' }}>
      {state === 'ready' && url ? (
        <>
          <a className="btn btn-primary" href={url} target="_blank" rel="noreferrer">
            Studioを開く
          </a>
          <button type="button" className="btn btn-ghost" onClick={handleStop}>
            Studioを停止
          </button>
        </>
      ) : (
        <button type="button" className="btn btn-ghost" disabled={state === 'starting'} onClick={handleStart}>
          {state === 'starting' ? 'Studio起動中…(初回は1分ほどかかることがあります)' : '🎬 Studioで確認'}
        </button>
      )}
      {error && <span style={{ color: 'var(--status-err)' }}>{error}</span>}
    </div>
  );
}

/**
 * ゲート応答カード。question + context + options ボタン + フィードバック記入欄(任意)。
 * kind==='render-check' は「レンダー前の目視確認」で、revise(修正を依頼)には
 * フィードバック必須(未記入なら送信不可)。
 */
export function GateCard({
  jobId,
  gate,
  dir,
  episodeId,
}: {
  jobId: string;
  gate: GateRequest;
  dir?: string;
  episodeId?: string;
}) {
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [sentLabel, setSentLabel] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isRenderCheck = gate.kind === 'render-check';

  async function respond(optionId: string, label: string) {
    setSendingId(optionId);
    setError(null);
    try {
      await respondGate(jobId, optionId, feedback.trim() === '' ? undefined : feedback.trim());
      setSentLabel(label);
    } catch (e) {
      setError(`応答の送信に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSendingId(null);
    }
  }

  /** render-check の修正依頼(revise)はフィードバック必須 */
  function disabledFor(optionId: string): boolean {
    if (sendingId !== null) return true;
    return isRenderCheck && optionId === 'revise' && feedback.trim() === '';
  }

  return (
    <div className="gate-card">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {isRenderCheck && <span className="badge warn">レンダー前の目視確認</span>}
        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{gate.question}</span>
        {gate.context && <span style={{ color: 'var(--text-secondary)' }}>{gate.context}</span>}
      </div>

      {isRenderCheck && dir !== undefined && sentLabel === null && <StudioLauncher dir={dir} episodeId={episodeId} />}

      {sentLabel ? (
        <div className="gate-options">
          <span className="badge warn">送信済み・再開待ち「{sentLabel}」</span>
        </div>
      ) : (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '10px' }}>
            <span className="mono">
              フィードバック{isRenderCheck ? '(「修正を依頼」では必須)' : '(任意)'}
            </span>
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={3}
              placeholder="決定にあわせて反映してほしい指示があれば記入"
              style={{
                padding: '8px 12px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-s)',
                background: 'var(--surface)',
                color: 'var(--text-primary)',
                fontSize: '14px',
                fontFamily: 'var(--font-body)',
                resize: 'vertical',
              }}
            />
          </label>
          <div className="gate-options">
            {gate.options.map((opt, i) => (
              <button
                key={opt.id}
                type="button"
                className={`btn ${i === 0 ? 'btn-primary' : 'btn-ghost'}`}
                title={opt.description}
                disabled={disabledFor(opt.id)}
                onClick={() => respond(opt.id, opt.label)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}

      {error && <div style={{ marginTop: '10px', color: 'var(--status-err)' }}>{error}</div>}
    </div>
  );
}
