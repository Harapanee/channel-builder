export type ChannelSummary = {
  dir: string;            // フォルダ名(表示とURLパラメータに使用)
  channelId: string;
  channelName: string;
  status: string;         // building | pilot_iterating | approved 等
  systemVersion: string;
  stage?: number;
  approvedEpisodes: string[];
  episodeCount: number;
};

export type EpisodeSummary = {
  episodeId: string;      // episodes/<episodeId> のフォルダ名
  subject?: string;
  status?: string;
  targetDurationSec?: number;
  hasPreview: boolean;    // out/preview.mp4 が存在
  hasFinal: boolean;      // out/final.mp4 が存在
  hasScript: boolean;     // script.md が存在
  reviewFiles: string[];  // review/ 直下のファイル名(ソート済み)
  stages: JobStage[];     // video-create工程レール(episode.jsonのstatus由来の進捗)
};

export type SessionInfo = {
  id: string;
  cwd: string;            // ルートからの相対フォルダ名。'' はファクトリールート
  status: 'running' | 'exited';
  exitCode?: number;
  createdAt: number;
};

export type ImageEntry = { path: string; mtimeMs: number; size: number };
export type VoiceEntry = { path: string; name: string };

export type ClientMsg =
  | { type: 'attach'; sessionId: string }
  | { type: 'input'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number };

export type ServerMsg =
  | { type: 'scrollback'; sessionId: string; data: string }
  | { type: 'pty-data'; sessionId: string; data: string }
  | { type: 'session-status'; sessionId: string; status: 'running' | 'exited'; exitCode?: number }
  | { type: 'sessions-changed' }
  | { type: 'fs-update'; dir: string; kind: 'system' | 'episode' | 'media' | 'images' }
  | { type: 'job-update'; job: JobDetail }
  | { type: 'job-log'; jobId: string; line: string }
  | { type: 'gate-open'; jobId: string; gate: GateRequest }
  | { type: 'rate-limit'; info: RateLimitInfo }
  | { type: 'render-queue'; items: RenderQueueItem[] }
  | { type: 'youtube-upload'; job: YoutubeUploadJob };

// ---- ジョブ(ヘッドレスclaude操作)----

export type JobStatus =
  | 'queued'
  | 'running'
  | 'awaiting_gate'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** ジョブの実行モード。auto=全確認を推奨で自走 / semi=レンダー前確認だけ停止 / manual=全ゲート停止 */
export type JobMode = 'manual' | 'semi' | 'auto';

/** ジョブ作成時の元リクエスト(キュー起動・再試行でプロンプトを再構築するために保持) */
export type JobRequest = { arg: string; durationSec?: number; episodeId?: string };

export type JobStage = { key: string; label: string; state: 'pending' | 'active' | 'done' };

export type JobSummary = {
  id: string;
  dir: string; // 対象チャンネルフォルダ('' はファクトリールート)
  operation: string; // operations.ts のキー(例: 'video-create')
  title: string; // 表示用(例: 'ユリウス・カエサル')
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  exitCode?: number;
  error?: string;
  mode: JobMode;   // 実行モード(既定 manual)
  model: string;   // claude --model に渡す値(既定 opus)
  effort: string;  // claude --effort に渡す値(既定 xhigh)
  episodeId?: string; // 関連エピソード(refine等はrequest指定、video-createは題材から解決)
};

export type JobDetail = JobSummary & {
  sessionId?: string; // claude セッション(--resume用)
  stages: JobStage[]; // 進捗タイムライン
  artifacts: string[]; // 生成物(チャンネル相対パス)
  gate?: GateRequest; // awaiting_gate のとき現在のゲート
  rateLimit?: RateLimitInfo; // 直近のrate_limit_event
  request: JobRequest;      // 作成時の元リクエスト
  resultText?: string;      // 最終resultの本文(マーカー除去済み。質問オペの回答表示に使う)
  renderApproved?: boolean; // レンダー前目視確認(render-check)が承認済みか
};

export type GateOption = { id: string; label: string; description: string };
export type GateRequest = {
  gateId: string;
  question: string;
  options: GateOption[];
  context: string;
  kind?: string; // 'render-check' = レンダー前の目視確認ゲート
};

export type RateLimitInfo = {
  utilization: number;
  rateLimitType: string;
  resetsAt: number;
  status: string;
};

// 操作テンプレート(UIに出すメタ。buildCommand はサーバー内でのみ使う)
export type OperationDef = {
  key: string; // 'video-create' 等
  label: string; // UI表示
  needsArg: boolean; // 題材等の引数が要るか
  argOptional?: boolean;  // true: 引数欄はあるが空でも起動できる(video-createの題材)
  argMultiline?: boolean; // true: UIはtextareaで入力させる(改善・質問)
  argLabel?: string; // 引数の入力ラベル
  stages: string[]; // 制作ラインの工程ラベル(ステージレール描画に使う)
  buildCommand: (arg: string) => string; // 例: (a) => `/video-create ${a}`
  readOnly?: boolean; // true=読み取り専用オペ。spawn時にツール制限を付ける
};

// ---- 夜間レンダーキュー ----

export type RenderQueueItemStatus = 'waiting' | 'running' | 'done' | 'failed' | 'canceled';

/** 夜間レンダーキューの1エピソード分。サーバーが render-episode.sh final を直列実行する */
export type RenderQueueItem = {
  id: string;              // UUID
  dir: string;             // チャンネルフォルダ名(ジョブと同じ相対表現)
  epId: string;            // 例 ep001-oda-nobunaga
  status: RenderQueueItemStatus;
  enqueuedAt: string;      // ISO
  startedAt?: string;
  finishedAt?: string;
  durationSec?: number;    // 動画実尺(out/.render-status-final.json 由来)
  qaExit?: number;         // 0=QA全pass
  reason?: string;         // 失敗理由(infinity_gate / qa_failed 等)
  pid?: number;            // 実行中レンダープロセスのpid(サーバー再起動後のキャンセルに必要)
};

// ---- ネタ帳・スキルヒント ----

/** channel/backlog.md のランキング表から抽出した「状態=候補」の題材 */
export type BacklogCandidate = { rank: number; subject: string; score: number };

/** チャンネルの .claude/skills/<name>/SKILL.md から抽出したヒント */
export type SkillInfo = { name: string; description: string };

// ---- YouTubeアップロード ----

/** チャンネルのYouTube連携状態(GET /api/youtube/status) */
export type YoutubeAuthStatus =
  | { connected: false; reason: 'no_client' | 'no_token' | 'needs_reauth' }
  | { connected: true; channelTitle: string };

export type YoutubeUploadStatus = 'uploading' | 'setting_thumbnail' | 'done' | 'failed';

/** 1回のアップロードジョブ。wshub経由で 'youtube-upload' として配信する */
export type YoutubeUploadJob = {
  id: string;              // UUID
  dir: string;             // チャンネルフォルダ名
  epId: string;            // 例 ep001-mola
  videoFile: string;       // エピソード相対(例 'out/final.mp4')
  status: YoutubeUploadStatus;
  bytesSent: number;
  bytesTotal: number;
  videoId?: string;        // 成功時のYouTube動画ID
  url?: string;            // https://www.youtube.com/watch?v=...
  error?: string;
  startedAt: string;       // ISO
  finishedAt?: string;
};

/** episodes/<ep>/publish/metadata.json の検証済み内容 */
export type YoutubeMetadata = {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: 'private' | 'unlisted' | 'public';
  thumbnail?: string;      // エピソード相対パス(例 'publish/thumbnail.png')
};
