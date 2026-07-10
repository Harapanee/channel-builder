import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteYoutubeClient, getYoutubeClient, putYoutubeClient } from '../api';

type ClientInfo = { configured: boolean; clientId?: string; redirectUri: string };

/** Google Cloud手順ガイドの1ステップ(番号+タイトル+直リンク+折りたたみ詳細) */
function GuideStep({
  n,
  title,
  href,
  linkLabel,
  children,
}: {
  n: number;
  title: string;
  href?: string;
  linkLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="collapse">
      <summary>
        <span className="mono">{n}. </span>
        <span style={{ fontWeight: 600 }}>{title}</span>
        {href && (
          <>
            {' '}
            <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
              {linkLabel ?? 'Consoleを開く'}
            </a>
          </>
        )}
        <span className="collapse-hint">詳細</span>
      </summary>
      <div style={{ paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '4px' }}>{children}</div>
    </details>
  );
}

/**
 * ファクトリー共通のYouTube OAuthクライアント設置セクション(設定タブ)。
 * 初めての人向けに Google Cloud 手順ガイド(直リンク+折りたたみ詳細)と、
 * JSON貼り付け/ファイル選択の設置フォームを提供する。設置は即有効(再起動不要)。
 */
export function YoutubeClientSettings() {
  const [info, setInfo] = useState<ClientInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [jsonText, setJsonText] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      setInfo(await getYoutubeClient());
    } catch (e) {
      setInfo(null);
      setLoadError(`設置状態の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function copyRedirectUri() {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard不可の環境ではURI自体が画面に出ているので手動コピーできる */
    }
  }

  function pickFile() {
    fileRef.current?.click();
  }

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // 同じファイルの再選択を許可
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setJsonText(String(reader.result ?? ''));
    reader.onerror = () => setMessage({ kind: 'err', text: 'ファイルの読み込みに失敗しました' });
    reader.readAsText(file);
  }

  async function save() {
    if (saving || jsonText.trim() === '') return;
    setSaving(true);
    setMessage(null);
    let raw: unknown;
    try {
      raw = JSON.parse(jsonText);
    } catch {
      setMessage({ kind: 'err', text: 'JSONとして読めません。ダウンロードしたファイルの中身を丸ごと貼り付けてください' });
      setSaving(false);
      return;
    }
    try {
      await putYoutubeClient(raw);
      setJsonText('');
      setMessage({ kind: 'ok', text: '設置完了。各チャンネルのエピソード詳細から「YouTube連携」に進めます(再起動は不要です)' });
      await reload();
    } catch (e) {
      setMessage({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const ok = window.confirm('クライアントJSONを削除します。全チャンネルのYouTube連携が使えなくなります(再設置すれば復帰)。よろしいですか?');
    if (!ok) return;
    setMessage(null);
    try {
      await deleteYoutubeClient();
      await reload();
    } catch (e) {
      setMessage({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <section className="panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '720px' }}>
      <h3>YouTube連携(ファクトリー共通)</h3>

      {loadError && <span style={{ color: 'var(--status-err)' }}>{loadError}</span>}

      {info?.configured ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--status-ok)' }}>設置済み</span>
          <span className="mono">クライアントID: {info.clientId}</span>
          <button className="btn btn-ghost" type="button" onClick={remove}>
            削除
          </button>
        </div>
      ) : (
        <span className="mono">未設置 — 下の手順でOAuthクライアントJSONを用意して貼り付けてください</span>
      )}

      <details className="collapse" open={!info?.configured}>
        <summary>
          <h3 style={{ display: 'inline' }}>Google Cloud側の準備(初回のみ・5ステップ)</h3>
          <span className="collapse-hint">クリックで開閉</span>
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '8px' }}>
          <GuideStep n={1} title="Google Cloudプロジェクトを作成" href="https://console.cloud.google.com/projectcreate">
            <span>Googleアカウントでログインし、プロジェクト名は自由(例: youtube-factory)。既存プロジェクトがあればそれでもOK。</span>
          </GuideStep>
          <GuideStep n={2} title="YouTube Data API v3 を有効化" href="https://console.cloud.google.com/apis/library/youtube.googleapis.com">
            <span>リンク先で対象プロジェクトを選び「有効にする」を押す。</span>
          </GuideStep>
          <GuideStep n={3} title="OAuth同意画面を設定" href="https://console.cloud.google.com/auth/overview">
            <span>・User Type は「外部(External)」を選択(公開ステータスは「テスト」のままでよい)</span>
            <span>・アプリ名・サポートメール・開発者メールは自分の情報でよい</span>
            <span>
              ・<b>「テストユーザー」に自分のGoogleアカウントを追加する</b>(忘れると認可時に「アクセスをブロック: このアプリは確認されていません」で進めなくなる、いちばん多いつまずきポイント)
            </span>
          </GuideStep>
          <GuideStep n={4} title="OAuthクライアントIDを作成" href="https://console.cloud.google.com/apis/credentials">
            <span>・「認証情報を作成」→「OAuthクライアントID」</span>
            <span>
              ・アプリケーションの種類は <b>「ウェブアプリケーション」</b> を選ぶ(「デスクトップ」ではない)
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              ・「承認済みのリダイレクトURI」に次を追加:
              <code className="mono">{info?.redirectUri ?? ''}</code>
              <button className="btn btn-ghost" type="button" onClick={copyRedirectUri}>
                {copied ? 'コピーしました' : 'コピー'}
              </button>
            </span>
          </GuideStep>
          <GuideStep n={5} title="JSONをダウンロード">
            <span>作成完了画面(または認証情報一覧のダウンロードアイコン)から「JSONをダウンロード」。そのファイルを下のフォームで貼り付けるか選択する。</span>
          </GuideStep>
        </div>
      </details>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span style={{ fontWeight: 600 }}>{info?.configured ? 'クライアントJSONを差し替える' : 'クライアントJSONを設置する'}</span>
        <textarea
          className="editor mono"
          style={{ minHeight: '120px' }}
          placeholder='ダウンロードしたJSONの中身を丸ごと貼り付け(例: {"web":{"client_id":"...","client_secret":"..."}})'
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          disabled={saving}
          spellCheck={false}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" type="button" onClick={pickFile} disabled={saving}>
            ファイルを選択…
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onFileChosen} />
          <button className="btn btn-primary" type="button" onClick={save} disabled={saving || jsonText.trim() === ''}>
            保存
          </button>
          {saving && <span className="mono">保存中…</span>}
        </div>
        {message && (
          <span style={{ color: message.kind === 'ok' ? 'var(--status-ok)' : 'var(--status-err)' }}>{message.text}</span>
        )}
      </div>
    </section>
  );
}
