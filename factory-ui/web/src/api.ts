import type {
  AnalyticsData,
  BacklogCandidate,
  ChannelSummary,
  EpisodeSummary,
  ImageEntry,
  JobDetail,
  JobMode,
  JobSummary,
  MetricsResponse,
  OperationDef,
  RenderQueueItem,
  SessionInfo,
  ShortFormatSummary,
  ShortSummary,
  SkillInfo,
  ThumbTestData,
  UploadKind,
  VoiceEntry,
  YoutubeAuthStatus,
  YoutubeUploadJob,
} from '../../shared/types';
import { clearToken, getToken } from './auth';

/**
 * REST API(Task 7)向けの型付きフェッチャ集。
 * ここに定義した関数名は Task 12 が直接依存するため変更しないこと。
 *
 * `:dir` を含むパスは必ず encodeURIComponent する(日本語チャンネル名フォルダに対応するため)。
 *
 * 全 `/api/*` はトークン認証必須(Task 3)。fetchJson が Authorization: Bearer ヘッダを自動添付する。
 * factory-ui自身のトークン不備の401(WWW-Authenticate: realm="factory-ui" 付き)を受けたら
 * トークンをクリアし `factory-ui-auth-required` を発火してアプリ側に全画面ゲートを出させる。
 * ドメイン401(YouTubeのneeds_reauth / no_auth 等。ヘッダ無し)は通常のエラーとしてthrowし、
 * 呼び出し元のcatch(パネル内バナー等)に委ねる。
 */

export type FactoryResponse = { name: string; channels: ChannelSummary[] };
export type ChannelResponse = {
  system: Record<string, unknown>;
  episodes: EpisodeSummary[];
  shorts: ShortSummary[];
  shortFormats: ShortFormatSummary[];
};
export type ImagesResponse = { images: ImageEntry[] };
export type VoicesResponse = { voices: VoiceEntry[] };

/** Authorization: Bearer ヘッダをマージした Headers を返す(トークン未設定なら無添付)。 */
function authHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  const token = getToken();
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

/**
 * factory-ui認証の401(WWW-Authenticate: realm="factory-ui" 付き)ならトークンを破棄し、
 * 全画面ゲートを出すためのイベントを発火する。ヘッダの無い401はドメイン401
 * (YouTubeのneeds_reauth / no_auth 等)なので何もしない(fetchJsonが通常throwする)。
 */
function handleUnauthorized(res: Response): void {
  if (
    res.status === 401 &&
    (res.headers.get('WWW-Authenticate')?.includes('realm="factory-ui"') ?? false)
  ) {
    clearToken();
    window.dispatchEvent(new Event('factory-ui-auth-required'));
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: authHeaders(init?.headers) });
  handleUnauthorized(res);
  if (!res.ok) {
    // サーバーは失敗時 {error: string} を返す。原因を握りつぶさず表示に含める
    let reason = '';
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error !== '') reason = `: ${body.error}`;
    } catch {
      /* 本文がJSONでない(古いサーバー・プロキシ等)場合はステータスのみ */
    }
    throw new Error(`${init?.method ?? 'GET'} ${url} -> ${res.status}${reason}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

function channelPath(dir: string, suffix = ''): string {
  return `/api/channels/${encodeURIComponent(dir)}${suffix}`;
}

/** GET /api/factory */
export function getFactory(): Promise<FactoryResponse> {
  return fetchJson<FactoryResponse>('/api/factory');
}

/** GET /api/metrics — チャンネル別+合計の制作メトリクス(ダッシュボード統計セクション用)。 */
export function getMetrics(): Promise<MetricsResponse> {
  return fetchJson<MetricsResponse>('/api/metrics');
}

/** GET /api/channels/:dir */
export function getChannel(dir: string): Promise<ChannelResponse> {
  return fetchJson<ChannelResponse>(channelPath(dir));
}

/** GET /api/channels/:dir/file?path=(.md/.json/.txt のみ) */
export async function getFileText(dir: string, path: string): Promise<string> {
  const url = `${channelPath(dir, '/file')}?path=${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: authHeaders() });
  handleUnauthorized(res);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status}`);
  }
  return res.text();
}

/**
 * GET /api/channels/:dir/media?path= の URL を組み立てるだけ(fetch はしない)。
 * <video src=...> / <img src=...> / <audio src=...> にそのまま渡す用途。
 * これらのタグにはヘッダを付けられないため、トークンはクエリで渡す。
 */
export function mediaUrl(dir: string, path: string): string {
  const token = getToken();
  const tokenPart = token !== null ? `&token=${encodeURIComponent(token)}` : '';
  return `${channelPath(dir, '/media')}?path=${encodeURIComponent(path)}${tokenPart}`;
}

/** GET /api/channels/:dir/images?limit= */
export function getImages(dir: string): Promise<ImagesResponse> {
  return fetchJson<ImagesResponse>(channelPath(dir, '/images'));
}

/** GET /api/channels/:dir/voices */
export function getVoices(dir: string): Promise<VoicesResponse> {
  return fetchJson<VoicesResponse>(channelPath(dir, '/voices'));
}

/** GET /api/sessions */
export function listSessions(): Promise<SessionInfo[]> {
  return fetchJson<SessionInfo[]>('/api/sessions');
}

/** POST /api/sessions */
export function createSession(body: { cwd: string; continue?: boolean }): Promise<SessionInfo> {
  return fetchJson<SessionInfo>('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** POST /api/sessions/:id/input — submit=true で末尾に改行(Enter)を付加して送信する */
export async function sendInput(id: string, text: string, submit: boolean): Promise<void> {
  await fetchJson<void>(`/api/sessions/${encodeURIComponent(id)}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, submit }),
  });
}

/** POST /api/sessions/:id/kill */
export async function killSession(id: string): Promise<void> {
  await fetchJson<void>(`/api/sessions/${encodeURIComponent(id)}/kill`, { method: 'POST' });
}

/** POST /api/sessions/:id/restart */
export function restartSession(id: string): Promise<SessionInfo> {
  return fetchJson<SessionInfo>(`/api/sessions/${encodeURIComponent(id)}/restart`, {
    method: 'POST',
  });
}

// ---- ジョブ(ヘッドレスclaude操作)API(Task 8 サーバー契約) ---------------

/**
 * UI に渡す操作テンプレートのメタ。`buildCommand`(任意コマンド実行口)は
 * サーバー内専用でレスポンスに含まれないため、型からも除外する。
 */
export type OperationMeta = Omit<OperationDef, 'buildCommand'>;

/** POST /api/jobs のリクエストボディ。arg以外は省略時サーバー既定(manual / opus / high)。 */
export type CreateJobBody = {
  dir: string;
  operation: string;
  arg?: string;
  mode?: JobMode;
  model?: string;
  effort?: string;
  durationSec?: number;
  /** durationSec と併せて範囲指定(下限=durationSec・上限=durationSecMax)。単一値指定なら省略 */
  durationSecMax?: number;
  episodeId?: string;
};

/** ライブラリ資産の採否。サーバーはこの2値のみ受理する。 */
export type CurateDecision = 'approve' | 'reject';

/** GET /api/operations — 操作テンプレートのメタ一覧(buildCommand は除外済み)。 */
export function getOperations(): Promise<OperationMeta[]> {
  return fetchJson<OperationMeta[]>('/api/operations');
}

/** GET /api/jobs — ジョブ一覧(サマリ)。 */
export function listJobs(): Promise<JobSummary[]> {
  return fetchJson<JobSummary[]>('/api/jobs');
}

/** GET /api/jobs/:id — ジョブ詳細(進捗・成果物・ゲート・rate-limit を含む)。 */
export function getJob(id: string): Promise<JobDetail> {
  return fetchJson<JobDetail>(`/api/jobs/${encodeURIComponent(id)}`);
}

/** GET /api/jobs/:id/log — 過去ログ(WS購読前の分。log.jsonl の末尾最大2000行)。 */
export function getJobLog(id: string): Promise<{ lines: string[] }> {
  return fetchJson<{ lines: string[] }>(`/api/jobs/${encodeURIComponent(id)}/log`);
}

/** POST /api/jobs — ジョブを新規作成し、作成されたサマリ(201)を返す。 */
export function createJob(body: CreateJobBody): Promise<JobSummary> {
  return fetchJson<JobSummary>('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** POST /api/jobs/:id/cancel — 実行中/確認待ち/待機中(queued)ジョブへ中断要求(204)。queuedは未実行のままcancelledになる。 */
export async function cancelJob(id: string): Promise<void> {
  await fetchJson<void>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}

/** POST /api/jobs/:id/gate — 選択肢ID+任意のフィードバックを応答(204)。 */
export async function respondGate(id: string, optionId: string, feedback?: string): Promise<void> {
  await fetchJson<void>(`/api/jobs/${encodeURIComponent(id)}/gate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(feedback ? { optionId, feedback } : { optionId }),
  });
}

/** POST /api/jobs/:id/resume — 中断/失敗/キャンセル済みジョブを途中から再開(200=JobDetail)。
 *  409 = sessionId無し(最初からの再試行にフォールバックする)。 */
export function resumeJob(id: string): Promise<JobDetail> {
  return fetchJson<JobDetail>(`/api/jobs/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** POST /api/jobs/:id/mode — 走行中ジョブの実行モードを切替(200=JobDetail)。終了済みは409。 */
export function setJobMode(id: string, mode: JobMode): Promise<JobDetail> {
  return fetchJson<JobDetail>(`/api/jobs/${encodeURIComponent(id)}/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
}

/** DELETE /api/jobs/:id — 終了ジョブを削除(204)。実行中・待機中は409。 */
export async function deleteJob(id: string): Promise<void> {
  await fetchJson<void>(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** POST /api/jobs/clear-finished — 終了済み(中断・失敗・完了)の一括削除(200 {cleared:n}、冪等)。 */
export function clearFinishedJobs(): Promise<{ cleared: number }> {
  return fetchJson<{ cleared: number }>('/api/jobs/clear-finished', { method: 'POST' });
}

/** GET /api/channels/:dir/backlog — ネタ帳の「候補」一覧(おすすめ=順位昇順)。未作成は空。 */
export function getBacklog(dir: string): Promise<{ candidates: BacklogCandidate[] }> {
  return fetchJson<{ candidates: BacklogCandidate[] }>(channelPath(dir, '/backlog'));
}

/** GET /api/channels/:dir/skills — ターミナルヒント用のスキル一覧。 */
export function getSkills(dir: string): Promise<{ skills: SkillInfo[] }> {
  return fetchJson<{ skills: SkillInfo[] }>(channelPath(dir, '/skills'));
}

// ---- 夜間レンダーキュー API ------------------------------------------------

/** GET /api/render-queue — 夜間レンダーキューの一覧。 */
export function getRenderQueue(): Promise<{ items: RenderQueueItem[] }> {
  return fetchJson<{ items: RenderQueueItem[] }>('/api/render-queue');
}

/** POST /api/render-queue/start — 夜間消化を開始(204)。実行中/空キューは409。 */
export async function startRenderQueue(): Promise<void> {
  await fetchJson<void>('/api/render-queue/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** POST /api/render-queue/enqueue — 手動登録(201=item)。render_ready未満(short は studio_checked 未満)/重複は409。 */
export function enqueueRenderQueue(dir: string, epId: string, kind?: 'short'): Promise<RenderQueueItem> {
  return fetchJson<RenderQueueItem>('/api/render-queue/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(kind ? { dir, epId, kind } : { dir, epId }),
  });
}

/** POST /api/render-queue/clear-finished — 終了済み(done/failed/canceled)の一括削除(200 {cleared:n}、冪等)。 */
export function clearRenderQueueFinished(): Promise<{ cleared: number }> {
  return fetchJson<{ cleared: number }>('/api/render-queue/clear-finished', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** POST /api/render-queue/:id/start — waiting1本だけを単発レンダー開始(204)。実行中/非waitingは409。 */
export async function startRenderQueueItem(id: string): Promise<void> {
  await fetchJson<void>(`/api/render-queue/${encodeURIComponent(id)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** POST /api/render-queue/:id/cancel — waitingは削除、runningはプロセス停止(204)。 */
export async function cancelRenderQueueItem(id: string): Promise<void> {
  await fetchJson<void>(`/api/render-queue/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

// ---- チャンネル直接編集 API(Task 8 サーバー契約) --------------------------

/**
 * POST /api/channels/:dir/episodes/:episodeId/approve — エピソードを承認する(204)。
 * サーバーは Content-Type: application/json を要求する(requireJson)。意味のある
 * ボディは無いが、要求を満たすため空オブジェクトを送る。
 */
export async function approveEpisode(dir: string, epId: string): Promise<void> {
  await fetchJson<void>(channelPath(dir, `/episodes/${encodeURIComponent(epId)}/approve`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** POST /api/channels/:dir/shorts/:shortId/studio-checked — ショートのStudio確認を承認する(204)。 */
export async function approveShortStudioCheck(dir: string, shortId: string): Promise<void> {
  await fetchJson<void>(channelPath(dir, `/shorts/${encodeURIComponent(shortId)}/studio-checked`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** POST /api/channels/:dir/library/:entryId/curate — ライブラリ資産を採否する(204)。 */
export async function curateLibrary(
  dir: string,
  entryId: string,
  decision: CurateDecision,
): Promise<void> {
  await fetchJson<void>(channelPath(dir, `/library/${encodeURIComponent(entryId)}/curate`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision }),
  });
}

/** GET /api/channels/:dir/bible — channel/bible.md の中身(散文)を返す。 */
export function getBible(dir: string): Promise<{ content: string }> {
  return fetchJson<{ content: string }>(channelPath(dir, '/bible'));
}

/** PUT /api/channels/:dir/bible — channel/bible.md を上書きする(204)。 */
export async function putBible(dir: string, content: string): Promise<void> {
  await fetchJson<void>(channelPath(dir, '/bible'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

// ---------------------------------------------------------------- studio

export type StudioStatusResponse =
  | { running: false }
  | { running: true; dir: string; url: string; status: 'starting' | 'ready' };

/** GET /api/studio — Remotion Studio の稼働状況。 */
export async function getStudioStatus(): Promise<StudioStatusResponse> {
  return fetchJson<StudioStatusResponse>('/api/studio');
}

/** POST /api/studio/start — 指定チャンネル(+対象エピソード)で Studio を起動し、疎通後にURLを返す。 */
export async function startStudio(dir: string, episodeId?: string): Promise<{ url: string }> {
  return fetchJson<{ url: string }>('/api/studio/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(episodeId ? { dir, episodeId } : { dir }),
  });
}

/** POST /api/studio/start — ショート対象(shorts/<shortId>)で Studio を起動し、疎通後にURLを返す。 */
export async function startStudioShort(dir: string, shortId: string): Promise<{ url: string }> {
  return fetchJson<{ url: string }>('/api/studio/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir, shortId }),
  });
}

/** POST /api/studio/stop — Studio を停止(204)。 */
export async function stopStudio(): Promise<void> {
  await fetchJson<void>('/api/studio/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

// ---- YouTubeアップロード API ------------------------------------------------

/** GET /api/youtube/status?channel= — チャンネルのYouTube連携状態。 */
export function getYoutubeStatus(dir: string): Promise<YoutubeAuthStatus> {
  return fetchJson<YoutubeAuthStatus>(`/api/youtube/status?channel=${encodeURIComponent(dir)}`);
}

/** POST /api/youtube/auth — 認可URLを得る(別タブで開く)。クライアント未設置は503。 */
export function getYoutubeAuthUrl(dir: string): Promise<{ url: string }> {
  return fetchJson<{ url: string }>('/api/youtube/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: dir }),
  });
}

/** GET /api/youtube/videos?channel=&ep=&kind= — out/のmp4候補一覧。 */
export function getYoutubeVideos(
  dir: string,
  id: string,
  kind: UploadKind = 'episode',
): Promise<{ files: { file: string; size: number }[] }> {
  return fetchJson(
    `/api/youtube/videos?channel=${encodeURIComponent(dir)}&ep=${encodeURIComponent(id)}&kind=${kind}`,
  );
}

/** POST /api/youtube/upload — アップロード開始(201=ジョブ)。重複409/未連携401。 */
export function startYoutubeUpload(body: {
  channel: string;
  epId: string;
  videoFile: string;
  kind?: UploadKind;
  force?: boolean;
}): Promise<YoutubeUploadJob> {
  return fetchJson<YoutubeUploadJob>('/api/youtube/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** GET /api/youtube/uploads — アップロードジョブ一覧(新しい順)。 */
export function listYoutubeUploads(): Promise<{ jobs: YoutubeUploadJob[] }> {
  return fetchJson<{ jobs: YoutubeUploadJob[] }>('/api/youtube/uploads');
}

/** GET /api/youtube/client — クライアントJSONの設置状態(clientIdはマスク済み)。 */
export function getYoutubeClient(): Promise<{ configured: boolean; clientId?: string; redirectUri: string }> {
  return fetchJson('/api/youtube/client');
}

/** PUT /api/youtube/client — ダウンロードJSONをそのまま送って設置(204)。不正は400。 */
export async function putYoutubeClient(raw: unknown): Promise<void> {
  await fetchJson<void>('/api/youtube/client', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(raw),
  });
}

/** DELETE /api/youtube/client — クライアントJSONを削除(204、冪等)。 */
export async function deleteYoutubeClient(): Promise<void> {
  await fetchJson<void>('/api/youtube/client', { method: 'DELETE' });
}

// ---- アナリティクス還流・サムネABテスト API(Task 7) ------------------------

/** POST /api/youtube/analytics/fetch — YouTube Analyticsから実測値を取得しanalytics.jsonへ保存(200)。
 *  未アップロードは404、スコープ不足/再連携要は401。 */
export function fetchYoutubeAnalytics(channel: string, epId: string): Promise<AnalyticsData> {
  return fetchJson<AnalyticsData>('/api/youtube/analytics/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, epId }),
  });
}

/** GET /api/channels/:dir/episodes/:epId/analytics — 保存済みのanalytics.json(未取得は404)。 */
export function getAnalytics(dir: string, epId: string): Promise<AnalyticsData> {
  return fetchJson<AnalyticsData>(channelPath(dir, `/episodes/${encodeURIComponent(epId)}/analytics`));
}

/** PUT /api/channels/:dir/episodes/:epId/analytics/manual — CTR・インプレッションの手動転記(204)。
 *  analytics.json未取得(先に分析取得が必要)は404。 */
export async function putAnalyticsManual(
  dir: string,
  epId: string,
  patch: { impressions?: number; impressionsCtr?: number },
): Promise<void> {
  await fetchJson<void>(channelPath(dir, `/episodes/${encodeURIComponent(epId)}/analytics/manual`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/** GET /api/channels/:dir/episodes/:epId/thumb-test — 保存済みのサムネAB結果(未記録は404)。 */
export function getThumbTest(dir: string, epId: string): Promise<ThumbTestData> {
  return fetchJson<ThumbTestData>(channelPath(dir, `/episodes/${encodeURIComponent(epId)}/thumb-test`));
}

/** PUT /api/channels/:dir/episodes/:epId/thumb-test — サムネAB結果を記録(204)。winner不正/sharesの不正キーは400。 */
export async function putThumbTest(
  dir: string,
  epId: string,
  body: { winner: string; shares?: Record<string, number>; note?: string },
): Promise<void> {
  await fetchJson<void>(channelPath(dir, `/episodes/${encodeURIComponent(epId)}/thumb-test`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
