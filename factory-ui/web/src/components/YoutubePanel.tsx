import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UploadKind, YoutubeAuthStatus, YoutubeUploadJob } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import {
  getFileText,
  getYoutubeAuthUrl,
  getYoutubeStatus,
  getYoutubeVideos,
  listYoutubeUploads,
  startYoutubeUpload,
} from '../api';
import { useConfirm } from './ConfirmDialog';
import { parsePublishTitles } from '../publishTitles';

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.ceil(n / 1024)} KB`;
}

/**
 * YouTubeアップロードパネル(エピソード/ショート詳細内)。
 * - 未連携: 連携ボタン(認可URLを別タブで開く。完了後「状態を再確認」)
 * - 連携済: 動画ファイル選択+メタデータ確認+アップロード実行+WS進捗表示
 * - 過去の成功(publish/upload-result.json)があれば動画URLと再アップロード(force)を出す
 *
 * kind='short' のときは shorts/<id>/ を見る(エピソードと同形のpublish/を前提とする)。
 */
export function YoutubePanel({
  dir,
  kind,
  id,
  ws,
  onOpenSettings,
  onCreateMetadata,
  creatingMetadata,
  createMetadataError,
}: {
  dir: string;
  kind: UploadKind;
  id: string;
  ws: FactoryWS;
  onOpenSettings?: () => void;
  /** metadata.json が無いとき出す生成ボタン(ショート専用。押すと /short-publish ジョブを起動する) */
  onCreateMetadata?: () => void;
  /** onCreateMetadata実行中かどうか(連打による二重ジョブ起動を防ぐためボタンをdisabledにする) */
  creatingMetadata?: boolean;
  /** onCreateMetadataの起動失敗メッセージ(ボタン直下に表示。呼び出し元の操作ログとは別出し) */
  createMetadataError?: string | null;
}) {
  const baseDir = kind === 'short' ? 'shorts' : 'episodes';
  const [auth, setAuth] = useState<YoutubeAuthStatus | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [files, setFiles] = useState<{ file: string; size: number }[]>([]);
  const [videoFile, setVideoFile] = useState<string>('out/final.mp4');
  const [metaText, setMetaText] = useState<string | null>(null);
  const [titleCandidates, setTitleCandidates] = useState<string[]>([]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [result, setResult] = useState<{ videoId?: string; url?: string } | null>(null);
  const [job, setJob] = useState<YoutubeUploadJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 付随情報(動画ファイル一覧・アップロード状況)の取得失敗。パネル本体は出しつつ1行で知らせる
  const [loadWarning, setLoadWarning] = useState<string | null>(null);
  const confirm = useConfirm();

  const reload = useCallback(async () => {
    setAuthError(null);
    setLoadWarning(null);
    try {
      setAuth(await getYoutubeStatus(dir));
    } catch (e) {
      setAuth(null);
      setAuthError(e instanceof Error ? e.message : String(e));
    }
    try {
      const { files } = await getYoutubeVideos(dir, id, kind);
      setFiles(files);
      if (files.length > 0 && !files.some((f) => f.file === 'out/final.mp4')) {
        setVideoFile(files[0].file);
      }
    } catch (e) {
      setFiles([]);
      setLoadWarning(
        `動画ファイル一覧の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    getFileText(dir, `${baseDir}/${id}/publish/metadata.json`)
      .then(setMetaText)
      .catch(() => setMetaText(null));
    getFileText(dir, `${baseDir}/${id}/publish/PUBLISH.md`)
      .then((t) => setTitleCandidates(parsePublishTitles(t)))
      .catch(() => setTitleCandidates([]));
    getFileText(dir, `${baseDir}/${id}/publish/upload-result.json`)
      .then((t) => setResult(JSON.parse(t) as { videoId?: string; url?: string }))
      .catch(() => setResult(null));
    try {
      const { jobs } = await listYoutubeUploads();
      setJob(
        jobs.find((j) => j.dir === dir && j.epId === id && (j.kind ?? 'episode') === kind) ?? null,
      );
    } catch (e) {
      // 一覧が取れなくてもパネル本体は出す(先に立った警告を優先して1行だけ表示)
      setLoadWarning(
        (prev) =>
          prev ?? `アップロード状況の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, [dir, kind, id, baseDir]);

  useEffect(() => {
    // 対象(エピソード/ショート)の切替時に前の選択・表示状態を持ち越さない
    // (videoFileはreload()内のフォールバック=final.mp4が無ければ先頭、の前提を揃えるため既定値に戻す)
    setJob(null);
    setError(null);
    setLoadWarning(null);
    setConnecting(false);
    setVideoFile('out/final.mp4');
    setAuth(null);
    setFiles([]);
    setMetaText(null);
    setResult(null);
    setTitleCandidates([]);
    setCopiedIdx(null);
    reload();
  }, [reload]);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (
        msg.type === 'youtube-upload' &&
        msg.job.dir === dir &&
        msg.job.epId === id &&
        (msg.job.kind ?? 'episode') === kind
      ) {
        setJob(msg.job);
        if (msg.job.status === 'done') reload(); // upload-result.json を反映
      }
      if (msg.type === 'ws-status' && msg.connected) {
        reload(); // 再接続: 切断中の進捗・結果を取りこぼしている可能性があるため再取得
      }
    });
  }, [ws, dir, kind, id, reload]);

  // publish/metadata.json の確認表示・アップロード可否判定に使う(不正JSONはnull=確認情報なしとして扱う)
  const parsedMeta = useMemo(() => {
    if (metaText === null) return null;
    try {
      return JSON.parse(metaText) as {
        title?: string;
        privacyStatus?: string;
        publishAt?: string;
      };
    } catch {
      return null;
    }
  }, [metaText]);

  async function connect() {
    if (connecting) return;
    setConnecting(true);
    setError(null);
    try {
      const { url } = await getYoutubeAuthUrl(dir);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }

  async function copyTitle(title: string, idx: number) {
    try {
      await navigator.clipboard.writeText(title);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((cur) => (cur === idx ? null : cur)), 1500);
    } catch (e) {
      setError(`コピーに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function upload(force: boolean) {
    if (starting) return;
    const size = files.find((f) => f.file === videoFile)?.size ?? 0;
    const title = parsedMeta?.title ?? '(metadata.json 不明)';
    const privacy = parsedMeta?.privacyStatus ?? 'private';
    const ok = await confirm({
      title: 'YouTubeへアップロードしますか?',
      body: `タイトル: ${title}\n公開設定: ${privacy}\nファイル: ${videoFile}(${fmtBytes(size)})${force ? '\n※再アップロード(既存の記録を上書き)' : ''}`,
      confirmLabel: 'アップロード',
    });
    if (!ok) return;
    setStarting(true);
    setError(null);
    try {
      setJob(await startYoutubeUpload({ channel: dir, epId: id, videoFile, kind, force }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  const uploading = job !== null && (job.status === 'uploading' || job.status === 'setting_thumbnail');
  const pct = job && job.bytesTotal > 0 ? Math.floor((job.bytesSent / job.bytesTotal) * 100) : 0;

  return (
    <section className="panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <h3>YouTubeアップロード</h3>

      {auth === null && !authError && <div className="empty">連携状態を確認中…</div>}
      {authError && <span style={{ color: 'var(--status-err)' }}>連携状態の取得に失敗: {authError}</span>}

      {auth && !auth.connected && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {auth.reason === 'no_client' ? (
            <>
              <span style={{ fontWeight: 600 }}>セットアップが必要です(Step 1/3)</span>
              <span>
                流れ: ①設定タブでクライアントJSONを設置 → ②このパネルでチャンネルを連携 → ③アップロード
              </span>
              <span className="mono">
                設定タブに Google Cloud 側の手順ガイド(初回のみ・5ステップ)があります。設置すると再起動なしでここに戻って続けられます。
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                {onOpenSettings && (
                  <button className="btn btn-primary" type="button" onClick={onOpenSettings}>
                    設定タブでセットアップを始める
                  </button>
                )}
                <button className="btn btn-ghost" type="button" onClick={reload}>
                  状態を再確認
                </button>
              </div>
            </>
          ) : (
            <>
              <span style={{ fontWeight: 600 }}>
                {auth.reason === 'needs_reauth'
                  ? '再連携が必要です(トークンが失効しました)'
                  : 'Step 2/3: このチャンネルをYouTubeと連携'}
              </span>
              <span className="mono">
                認可画面でアカウントを選ぶとき、<b>このチャンネルに対応するブランドアカウント</b>を選んでください(間違えると別チャンネルにアップロードされます)
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <button className="btn btn-primary" type="button" onClick={connect} disabled={connecting}>
                  {connecting ? '接続中…' : auth.reason === 'needs_reauth' ? 'YouTube再連携' : 'YouTube連携'}
                </button>
                <button className="btn btn-ghost" type="button" onClick={reload}>
                  状態を再確認
                </button>
                <span className="mono">別タブでGoogle認可 → 完了後「状態を再確認」</span>
              </div>
            </>
          )}
        </div>
      )}

      {auth?.connected && (
        <>
          <span className="mono">連携先: {auth.channelTitle}</span>

          {result?.url && (
            <span>
              アップロード済み:{' '}
              <a href={result.url} target="_blank" rel="noopener noreferrer">
                {result.url}
              </a>
            </span>
          )}

          {metaText === null ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <span style={{ color: 'var(--status-err)' }}>
                publish/metadata.json がありません。アップロードには必須です。
              </span>
              {onCreateMetadata && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={onCreateMetadata}
                    disabled={creatingMetadata}
                  >
                    公開メタデータを作る
                  </button>
                  <span aria-live="polite">
                    {createMetadataError && (
                      <span style={{ color: 'var(--status-err)' }}>{createMetadataError}</span>
                    )}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <details className="collapse">
              <summary>
                <span className="mono">publish/metadata.json</span>
                <span className="collapse-hint">クリックで確認</span>
              </summary>
              <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{metaText}</pre>
            </details>
          )}

          {parsedMeta?.publishAt && (
            <span className="mono">
              公開予約: {new Date(parsedMeta.publishAt).toLocaleString('ja-JP')}
            </span>
          )}

          {titleCandidates.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontWeight: 600 }}>タイトル案(PUBLISH.mdより)</span>
              {titleCandidates.map((t, i) => (
                <div key={t} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => copyTitle(t, i)}
                    aria-label={`タイトル案をコピー: ${t}`}
                  >
                    {copiedIdx === i ? 'コピーしました' : 'コピー'}
                  </button>
                  <span className="mono">{t}</span>
                </div>
              ))}
            </div>
          )}

          {files.length === 0 ? (
            <div className="empty">out/ にmp4がありません(本番レンダー後にアップロードできます)</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <select value={videoFile} onChange={(e) => setVideoFile(e.target.value)} disabled={uploading}>
                {files.map((f) => (
                  <option key={f.file} value={f.file}>
                    {f.file}({fmtBytes(f.size)})
                  </option>
                ))}
              </select>
              <button
                className="btn btn-primary"
                type="button"
                disabled={
                  starting ||
                  uploading ||
                  metaText === null
                }
                onClick={() => upload(result !== null)}
              >
                {result !== null ? '再アップロード' : 'YouTubeへアップロード'}
              </button>
            </div>
          )}

          {job && (
            <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {uploading && (
                <span className="mono">
                  {job.status === 'setting_thumbnail'
                    ? 'サムネイルを設定中…'
                    : `アップロード中 ${pct}%(${fmtBytes(job.bytesSent)} / ${fmtBytes(job.bytesTotal)})`}
                </span>
              )}
              {job.status === 'done' && job.url && (
                <span style={{ color: 'var(--status-ok)' }}>
                  完了:{' '}
                  <a href={job.url} target="_blank" rel="noopener noreferrer">
                    {job.url}
                  </a>
                  (非公開アップロードの場合は YouTube Studio で公開してください。未審査OAuthアプリでは動画がロックされることがあります)
                </span>
              )}
              {job.status === 'failed' && (
                <span style={{ color: 'var(--status-err)' }}>
                  失敗: {job.error}
                  {job.error?.includes('quota') ? '(APIクォータ超過の可能性。日次リセット後に再試行)' : ''}
                </span>
              )}
            </div>
          )}
        </>
      )}

      <span aria-live="polite">
        {loadWarning && <span style={{ color: 'var(--status-err)' }}>{loadWarning}</span>}
        {error && <span style={{ color: 'var(--status-err)' }}>{error}</span>}
      </span>
    </section>
  );
}
