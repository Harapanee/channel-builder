import { useCallback, useEffect, useState } from 'react';
import { getBible, putBible } from '../api';
import { YoutubeClientSettings } from './YoutubeClientSettings';

/**
 * チャンネル教義(channel/bible.md)の直接編集タブ(claude を介さない)。
 *
 * getBible(dir) で読み込み、`.editor` を散文向け(font-body・16px・1.6行間。DESIGN.md の
 * 「16=読ませる本文(bibleエディタ等)」に合わせたトークンのみのインライン上書き)で編集し、
 * 保存前に確認ダイアログを挟んで putBible(dir, content) で上書きする。
 * 検証エラー(空・巨大入力)はサーバーが 400 を返す。文言はエラーメッセージにそのまま出す
 * (他コンポーネントと同じ「e.message をそのまま出す」規約)。
 */
export function SettingsTab({ dir }: { dir: string }) {
  const [original, setOriginal] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await getBible(dir);
      setOriginal(res.content);
      setDraft(res.content);
      setLoadError(null);
    } catch (e) {
      setLoadError(`bible.md の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [dir]);

  useEffect(() => {
    setOriginal(null);
    setDraft('');
    setLoadError(null);
    setSaveError(null);
    setSaved(false);
    reload();
  }, [dir, reload]);

  const dirty = original !== null && draft !== original;

  async function save() {
    if (!dirty || saving) return;
    const ok = window.confirm('channel/bible.md を上書き保存します。よろしいですか?(旧内容は bible.md.bak に残ります)');
    if (!ok) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await putBible(dir, draft);
      setOriginal(draft);
      setSaved(true);
    } catch (e) {
      setSaveError(`保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    if (original === null) return;
    setDraft(original);
    setSaveError(null);
    setSaved(false);
  }

  // bible部分のレンダリングを関数に切り出し、YouTube連携セクションは常に表示する
  function renderBible() {
    if (loadError) {
      return <div style={{ color: 'var(--status-err)' }}>{loadError}</div>;
    }

    if (original === null) {
      return <div className="empty">読み込み中…</div>;
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <span className="mono">channel/bible.md</span>
          {dirty && <span className="mono">未保存の変更があります</span>}
        </div>

        <textarea
          className="editor"
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: '16px',
            lineHeight: '1.6',
            minHeight: '480px',
            maxWidth: '720px', // 和文40〜45字相当。全幅まで伸びると1行が長くなり読みにくいため制限する
          }}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setSaved(false);
          }}
          disabled={saving}
          spellCheck={false}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
            保存
          </button>
          <button className="btn btn-ghost" disabled={!dirty || saving} onClick={discard}>
            変更を破棄
          </button>
          {saving && <span className="mono">保存中…</span>}
          {saved && !dirty && <span style={{ color: 'var(--status-ok)' }}>保存しました</span>}
          {saveError && <span style={{ color: 'var(--status-err)' }}>{saveError}</span>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <YoutubeClientSettings />
      {renderBible()}
    </div>
  );
}
