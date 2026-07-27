import { useCallback, useEffect, useState } from 'react';
import { getBible, putBible } from '../api';
import { useConfirm } from './ConfirmDialog';
import { VoicesTab } from './VoicesTab';
import { YoutubeClientSettings } from './YoutubeClientSettings';

/** 未保存下書きの退避先(dir 単位。別チャンネルの下書きと混ざらないようキーに含める) */
function draftKey(dir: string): string {
  return `factory-ui:bible-draft:${dir}`;
}

/**
 * チャンネル教義(channel/bible.md)の直接編集タブ(claude を介さない)。
 *
 * getBible(dir) で読み込み、`.editor` を散文向け(font-body・16px・1.6行間。DESIGN.md の
 * 「16=読ませる本文(bibleエディタ等)」に合わせたトークンのみのインライン上書き)で編集し、
 * 保存前に確認ダイアログを挟んで putBible(dir, content) で上書きする。
 * 検証エラー(空・巨大入力)はサーバーが 400 を返す。文言はエラーメッセージにそのまま出す
 * (他コンポーネントと同じ「e.message をそのまま出す」規約)。
 *
 * 下書き保全: 編集中(保存前)の内容を localStorage に自動退避する。リロード後に
 * 前回の下書きが残っていれば「復元/破棄」を提示し、保存成功(または破棄)で消す。
 * さらに未保存の編集がある間は beforeunload でページ離脱を警告する。
 */
export function SettingsTab({ dir }: { dir: string }) {
  const [original, setOriginal] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // 前回セッションから復元可能な未保存下書き(復元/破棄の判断待ち)
  const [pendingDraft, setPendingDraft] = useState<string | null>(null);
  const confirm = useConfirm();

  const reload = useCallback(async () => {
    try {
      const res = await getBible(dir);
      // 読み込み前に localStorage の下書きを拾っておく(下の自動退避 effect が
      // draft===original を見てキーを消すため、state に先に確保する)
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(draftKey(dir));
      } catch {
        // localStorage 不可の環境では下書き保全なしで動く
      }
      setPendingDraft(stored !== null && stored !== res.content ? stored : null);
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
    setPendingDraft(null);
    reload();
  }, [dir, reload]);

  const dirty = original !== null && draft !== original;

  // 編集内容の自動退避: dirty なら書き込み、原本と一致(保存成功・破棄を含む)したら消す
  useEffect(() => {
    if (original === null) return;
    try {
      if (draft !== original) {
        localStorage.setItem(draftKey(dir), draft);
      } else {
        localStorage.removeItem(draftKey(dir));
      }
    } catch {
      // 書き込めない環境(容量超過等)では黙って諦める(保存自体は通常フローで可能)
    }
  }, [draft, original, dir]);

  // 未保存の編集がある間はページ離脱時にブラウザ標準の確認ダイアログを出す
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // Chrome互換(これが無いとダイアログが出ないブラウザがある)
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  async function save() {
    if (!dirty || saving) return;
    const ok = await confirm({
      title: 'channel/bible.md を上書き保存しますか?',
      body: '旧内容は bible.md.bak に残ります。',
      confirmLabel: '保存する',
    });
    if (!ok) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await putBible(dir, draft);
      setOriginal(draft);
      setSaved(true);
      setPendingDraft(null);
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

  function restorePendingDraft() {
    if (pendingDraft === null) return;
    setDraft(pendingDraft); // dirty になり、自動退避 effect が localStorage へ書き戻す
    setPendingDraft(null);
    setSaved(false);
  }

  function discardPendingDraft() {
    setPendingDraft(null);
    try {
      localStorage.removeItem(draftKey(dir));
    } catch {
      // 消せなくても実害なし(次回読み込み時に原本一致なら提示されない)
    }
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

        {pendingDraft !== null && (
          <div
            className="gate-card"
            style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', maxWidth: '720px' }}
          >
            <span>保存されていない下書きがあります(前回の編集内容)</span>
            <button className="btn btn-primary" type="button" onClick={restorePendingDraft}>
              復元
            </button>
            <button className="btn btn-ghost" type="button" onClick={discardPendingDraft}>
              破棄
            </button>
          </div>
        )}

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
          <span aria-live="polite">
            {saving && <span className="mono">保存中…</span>}
            {saved && !dirty && <span style={{ color: 'var(--status-ok)' }}>保存しました</span>}
            {saveError && <span style={{ color: 'var(--status-err)' }}>{saveError}</span>}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <YoutubeClientSettings />
      <section style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <h3>チャンネル教義(bible.md)</h3>
        {renderBible()}
      </section>
      {/* 音声試聴は読み取り専用の参照情報なので専用タブにせず設定に同居させる */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <h3>ナレーション音声(試聴)</h3>
        <VoicesTab dir={dir} />
      </section>
    </div>
  );
}
