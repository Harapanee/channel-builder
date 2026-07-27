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
  thumbnailFiles: string[]; // publish/ 直下の画像ファイル名(ソート済み)
  selectedThumbnail?: string; // publish/metadata.json の thumbnail(エピソード相対パス)
  stages: JobStage[];     // video-create工程レール(episode.jsonのstatus由来の進捗)
};

export type ShortSummary = {
  shortId: string;         // shorts/<shortId> のフォルダ名
  title?: string;
  formatId?: string;       // channel/short-formats/<formatId>.json への参照
  sourceEpisodeId?: string; // 元エピソード
  status?: string;         // scripted → … → rendered(short-create スキルが更新)
  hasScript: boolean;      // script.md が存在
  hasFinal: boolean;       // out/final.mp4 が存在
  hasMetadata: boolean;    // publish/metadata.json が存在(公開準備の完了印。/short-publish が生成)
  reviewFiles: string[];   // review/ 直下のファイル名(ソート済み)
  stages: JobStage[];      // short-create工程レール(short.jsonのstatus由来の進捗)
};

/** channel/short-formats/<formatId>.json の表示用サマリ(構造の型はUIでは表示のみ) */
export type ShortFormatSummary = {
  formatId: string;
  name?: string;
  targetDurationSec?: number;
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
  | { type: 'fs-update'; dir: string; kind: 'system' | 'episode' | 'short' | 'media' }
  | { type: 'job-update'; job: JobDetail }
  | { type: 'job-removed'; jobId: string }
  | { type: 'job-log'; jobId: string; line: string }
  | { type: 'gate-open'; jobId: string; gate: GateRequest }
  | { type: 'rate-limit'; info: RateLimitInfo }
  | { type: 'render-queue'; items: RenderQueueItem[] }
  | { type: 'youtube-upload'; job: YoutubeUploadJob }
  // クライアント側(FactoryWS)が合成する接続状態通知。サーバーは送らない。
  // connected:true は「再接続に成功した」通知でもあるため、購読側はこれを機に一覧を再取得する。
  | { type: 'ws-status'; connected: boolean };

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
export type JobRequest = { arg: string; durationSec?: number; durationSecMax?: number; episodeId?: string };

export type JobStage = {
  key: string;
  label: string;
  state: 'pending' | 'active' | 'done' | 'queued';
  startedAt?: number; // epoch ms。工程別所要時間の計測用
  endedAt?: number;
};

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
  effort: string;  // claude --effort に渡す値(既定 high)
  episodeId?: string; // 関連エピソード(refine等はrequest指定、video-createは題材から解決)
  shortId?: string; // 関連ショート(short-createはargの epId+formatId から解決)
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
  /** レンダーを夜間キューへ委譲した(=ジョブ成功でもレンダー工程は未実行)。キュー成功時にサーバーが解除する */
  renderQueued?: boolean;
  /** フェーズ分割ジョブの現在フェーズ(0起点)。undefined=分割導入前の旧ジョブ(単一セッションで完走) */
  phaseIndex?: number;
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
  /** フェーズ分割実行の指示文(video-create)。各要素が1セッションの担当範囲。
   * 定義があるオペは、フェーズ末尾の<done>ごとに新規セッションで次フェーズを起動する
   * (1セッション肥大によるcache read増とusage浪費を防ぐ。Phase 6設計書 B-1) */
  phases?: string[];
  /** phases と同じ長さの配列で、各フェーズが <stage> マーカーとして発行してよい
   * 工程ラベルの集合。セッションはフェーズ末尾の監査などで担当範囲外のラベルを
   * 誤発行することがあり(実測 ep001-shoyu: 素材・実装の実作業が「検査」枠に計上)、
   * 範囲外マーカーは進捗前進に使わない(jobs.ts maybeStage のクランプ)。
   * 未定義のフェーズ/オペはクランプなし(全ラベル許容) */
  phaseStages?: string[][];
  /** true=ファクトリールート(dir='')で実行する操作。チャンネルdirでの起動は拒否される(jobs.tsのガード) */
  rootLevel?: boolean;
};

// ---- 夜間レンダーキュー ----

export type RenderQueueItemStatus = 'waiting' | 'running' | 'done' | 'failed' | 'canceled';

/** 夜間レンダーキューの1エピソード分。サーバーが render-episode.sh final を直列実行する */
export type RenderQueueItem = {
  id: string;              // UUID
  dir: string;             // チャンネルフォルダ名(ジョブと同じ相対表現)
  epId: string;            // 例 ep001-oda-nobunaga(kind='short' のときは shortId 例 sh001-xxx)
  kind?: 'short';          // 省略時はエピソード(後方互換: 既存キューJSONにこのキーは無い)
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

/** アップロード対象の種別。永続化JSON互換のため kind キー省略=エピソード(render-queue と同じ流儀) */
export type UploadKind = 'episode' | 'short';

/** 1回のアップロードジョブ。wshub経由で 'youtube-upload' として配信する */
export type YoutubeUploadJob = {
  id: string;              // UUID
  dir: string;             // チャンネルフォルダ名
  epId: string;            // エピソードID or ショートID(例 ep001-mola / sh001-caesar-top3)
  kind?: 'short';          // 省略=episode
  videoFile: string;       // 対象フォルダ相対(例 'out/final.mp4')
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
  aiDisclosure?: boolean;      // AI生成コンテンツ開示(containsSyntheticMediaに対応)
  productionNotes?: string;    // 制作メモ(社内用途。YouTube APIへは送らない)
  publishAt?: string;          // ISO8601公開予約日時。指定時はprivacyStatusがprivate必須
};

// ---- アナリティクス還流・サムネABテスト ----

/** 視聴維持率カーブの1点(dimension=elapsedVideoTimeRatio × metric=audienceWatchRatio) */
export type RetentionPoint = { elapsedRatio: number; watchRatio: number };

/** episodes/<ep>/analytics.json。YouTube Analytics APIの実測値+手動転記(CTR等)。
 *  チャンネルの src/schemas/analytics.schema.json(additionalProperties:false)と対応。 */
export type AnalyticsData = {
  videoId: string;
  fetchedAt: string;                   // 取得日時(ISO8601)
  views?: number;
  estimatedMinutesWatched?: number;
  averageViewDuration?: number;        // 平均視聴時間(秒)
  averageViewPercentage?: number;      // 平均視聴率(%)
  subscribersGained?: number;
  likes?: number;
  comments?: number;
  retentionCurve?: RetentionPoint[];
  manual?: {
    impressions?: number;
    impressionsCtr?: number;           // インプレッションCTR%(YouTube Studioから手動転記)
  };
};

/** episodes/<ep>/publish/thumb-test.json。YouTube Studio「テストと比較」の結果の手動記録。 */
export type ThumbTestData = {
  winner: 'thumb-1' | 'thumb-2' | 'thumb-3';
  shares?: Record<string, number>;     // 各案の視聴シェア%(任意)
  note?: string;                       // 所感(なぜ勝ったかの仮説)
  recordedAt: string;                  // 記録日(YYYY-MM-DD)
};

// ---- メトリクスダッシュボード ----

/** チャンネル1件分の制作メトリクス集計(GET /api/metrics)。 */
export type ChannelMetrics = {
  dir: string;
  channelName: string;
  episodeCount: number;         // episodes/*/episode.json を持つディレクトリ数
  finalCount: number;           // うち episode.json の status === 'final' の数
  renderMinutesTotal: number;   // .channel-system.json の metrics[].renderMinutes 合計
  wallClockHoursTotal: number;  // 同 metrics[].wallClockHours 合計
  imageGenTotal: number;        // 同 metrics[].imageGenCount 合計
};

/** 全チャンネル横断の合計(dir・channelNameを除く同名フィールドの合計)。 */
export type MetricsTotals = Omit<ChannelMetrics, 'dir' | 'channelName'>;

export type MetricsResponse = {
  channels: ChannelMetrics[];
  totals: MetricsTotals;
};
