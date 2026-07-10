import { useEffect, useState } from 'react';
import type { SkillInfo } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import { getSkills, listSessions, sendInput } from '../api';
import { TerminalTab } from './TerminalTab';

/**
 * 「上級」ターミナルドロワー。TerminalTab(無改変)+スキルヒントパネル。
 * ヒントはチャンネルのスキル一覧から取得した一行説明。
 * クリックで、稼働中セッションへ スキル名をプリフィルする(Enterは送らない)。
 */
export function TerminalDrawer({
  dir,
  ws,
  onClose,
}: {
  dir: string;
  ws: FactoryWS;
  onClose: () => void;
}) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null); // null=読み込み中
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [hintsOpen, setHintsOpen] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const [prefillError, setPrefillError] = useState<string | null>(null);

  useEffect(() => {
    setSkills(null);
    setSkillsError(null);
    getSkills(dir)
      .then((r) => setSkills(r.skills))
      .catch((e) => {
        setSkills([]);
        setSkillsError(
          `ヒント(スキル一覧)の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  }, [dir]);

  async function prefill(name: string) {
    setPrefillError(null);
    try {
      const sessions = await listSessions();
      const target = sessions
        .filter((s) => s.cwd === dir && s.status === 'running')
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!target) {
        setPrefillError('稼働中のターミナルセッションがありません(下のターミナルを起動してから使ってください)');
        return;
      }
      await sendInput(target.id, `/${name} `, false);
    } catch (e) {
      setPrefillError(`プリフィルに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className={`terminal-drawer${maximized ? ' maximized' : ''}`}>
      <div className="terminal-drawer-header">
        <span>上級: ターミナル</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn btn-ghost" onClick={() => setHintsOpen((v) => !v)}>
            {hintsOpen ? 'ヒントを隠す' : 'ヒントを表示'}
          </button>
          <button className="btn btn-ghost" onClick={() => setMaximized((v) => !v)}>
            {maximized ? '標準サイズ' : '最大化'}
          </button>
          <button className="btn btn-ghost" onClick={onClose} aria-label="ターミナルドロワーを閉じる">
            閉じる
          </button>
        </div>
      </div>
      {hintsOpen && (
        <div
          style={{
            padding: '8px 16px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            maxHeight: '160px',
            overflowY: 'auto',
          }}
        >
          {skills === null ? (
            <span style={{ color: 'var(--text-secondary)' }}>ヒントを読み込み中…</span>
          ) : skillsError ? (
            <span style={{ color: 'var(--status-err)' }}>{skillsError}</span>
          ) : skills.length === 0 ? (
            <span style={{ color: 'var(--text-secondary)' }}>
              このチャンネルにスキルヒントはありません(.claude/skills が未整備)
            </span>
          ) : (
            skills.map((s) => (
              <button
                key={s.name}
                type="button"
                className="btn btn-ghost"
                style={{ justifyContent: 'flex-start', textAlign: 'left', height: 'auto', padding: '4px 8px' }}
                title="クリックでターミナルに入力(Enterは送りません)"
                onClick={() => prefill(s.name)}
              >
                <span className="mono">/{s.name}</span>
                <span style={{ color: 'var(--text-secondary)', marginLeft: '8px' }}>{s.description}</span>
              </button>
            ))
          )}
          {prefillError && <span style={{ color: 'var(--status-err)' }}>{prefillError}</span>}
        </div>
      )}
      <div className="terminal-drawer-body">
        <TerminalTab dir={dir} ws={ws} />
      </div>
    </div>
  );
}
