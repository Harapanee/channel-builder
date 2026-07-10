import { useCallback, useEffect, useState } from 'react';
import type { EpisodeSummary, YoutubeAuthStatus, YoutubeUploadJob } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import {
  getFileText,
  getYoutubeAuthUrl,
  getYoutubeStatus,
  getYoutubeVideos,
  listYoutubeUploads,
  startYoutubeUpload,
} from '../api';

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.ceil(n / 1024)} KB`;
}

/**
 * YouTubeアップロードパネル(エピソード詳細内)。
 * - 未連携: 連携ボタン(認可URLを別タブで開く。完了後「状態を再確認」)
 * - 連携済: 動画ファイル選択+メタデータ確認+アップロード実行+WS進捗表示
 * - 過去の成功(publish/upload-result.json)があれば動画URLと再アップロード(force)を出す
 */
export function YoutubePanel({
  dir,
  episode,
  ws,
  onOpenSettings,
}: {
  dir: string;
  episode: EpisodeSummary;
  ws: FactoryWS;
  onOpenSettings?: () => void;
}) {
  const [auth, setAuth] = useState<YoutubeAuthStatus | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [files, setFiles] = useState<{ file: string; size: number }[]>([]);
  const [videoFile, setVideoFile] = useState<string>('out/final.mp4');
  const [metaText, setMetaText] = useState<string | null>(null);
  const [result, setResult] = useState<{ videoId?: string; url?: string } | null>(null);
  const [job, setJob] = useState<YoutubeUploadJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setAuthError(null);
    try {
      setAuth(await getYoutubeStatus(dir));
    } catch (e) {
      setAuth(null);
      setAuthError(e instanceof Error ? e.message : String(e));
    }
    try {
      const { files } = await getYoutubeVideos(dir, episode.episodeId);
      setFiles(files);
      if (files.length > 0 && !files.some((f) => f.file === 'out/final.mp4')) {
        setVideoFile(files[0].file);
      }
    } catch {
      setFiles([]);
    }
    getFileText(dir, `episodes/${episode.episodeId}/publish/metadata.json`)
      .then(setMetaText)
      .catch(() => setMetaText(null));
    getFileText(dir, `episodes/${episode.episodeId}/publish/upload-result.json`)
      .then((t) => setResult(JSON.parse(t) as { videoId?: string; url?: string }))
      .catch(() => setResult(null));
    try {
      const { jobs } = await listYoutubeUploads();
      setJob(jobs.find((j) => j.dir === dir && j.epId === episode.episodeId) ?? null);
    } catch {
      /* 一覧が取れなくてもパネル本体は出す */
    }
  }, [dir, episode.episodeId]);

  useEffect(() => {
    // エピソード切替時に前エピソードの選択・表示状態を持ち越さない
    // (videoFileはreload()内のフォールバック=final.mp4が無ければ先頭、の前提を揃えるため既定値に戻す)
    setJob(null);
    setError(null);
    setVideoFile('out/final.mp4');
    setAuth(null);
    setFiles([]);
    setMetaText(null);
    setResult(null);
    reload();
  }, [reload]);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (msg.type === 'youtube-upload' && msg.job.dir === dir && msg.job.epId === episode.episodeId) {
        setJob(msg.job);
        if (msg.job.status === 'done') reload(); // upload-result.json を反映
      }
    });
  }, [ws, dir, episode.episodeId, reload]);

  async function connect() {
    setError(null);
    try {
      const { url } = await getYoutubeAuthUrl(dir);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function upload(force: boolean) {
    if (starting) return;
    const size = files.find((f) => f.file === videoFile)?.size ?? 0;
    let title = '(metadata.json 不明)';
    let privacy = 'private';
    try {
      const m = JSON.parse(metaText ?? '') as { title?: string; privacyStatus?: string };
      if (m.title) title = m.title;
      if (m.privacyStatus) privacy = m.privacyStatus;
    } catch {
      /* 確認ダイアログの表示のみに使う。実検証はサーバー側 */
    }
    const ok = window.confirm(
      `YouTubeへアップロードします。\n\nタイトル: ${title}\n公開設定: ${privacy}\nファイル: ${videoFile}(${fmtBytes(size)})${force ? '\n\n※再アップロード(既存の記録を上書き)' : ''}`,
    );
    if (!ok) return;
    setStarting(true);
    setError(null);
    try {
      setJob(await startYoutubeUpload({ channel: dir, epId: episode.episodeId, videoFile, force }));
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
                <button className="btn btn-primary" type="button" onClick={connect}>
                  {auth.reason === 'needs_reauth' ? 'YouTube再連携' : 'YouTube連携'}
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
            <span style={{ color: 'var(--status-err)' }}>
              publish/metadata.json がありません。アップロードには必須です。
            </span>
          ) : (
            <details className="collapse">
              <summary>
                <span className="mono">publish/metadata.json</span>
                <span className="collapse-hint">クリックで確認</span>
              </summary>
              <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{metaText}</pre>
            </details>
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
                disabled={starting || uploading || metaText === null}
                onClick={() => upload(result !== null)}
              >
                {result !== null ? '再アップロード' : 'YouTubeへアップロード'}
              </button>
            </div>
          )}

          {job && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
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

      {error && <span style={{ color: 'var(--status-err)' }}>{error}</span>}
    </section>
  );
}
