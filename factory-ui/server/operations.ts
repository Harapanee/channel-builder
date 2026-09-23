import type { OperationDef, JobMode } from '../shared/types';

// video-createを6セッションへ分割するフェーズ指示。1セッションで12工程を回すと
// 履歴が単調増大し毎ターンのcache readが膨らむ(実測: 1本で累計111M tokens)ため、
// 担当範囲を区切り、範囲末尾で <done> を出して終了→サーバーが次フェーズを新規セッションで起動する。
// 引き継ぎは episode.json の status と成果物ファイル(既存の中断・再開基盤)。
// 区切りは status で書く。成果物ファイル名はレンダーエンジン依存(HyperFrames=storyboard.mdのclip表 /
// Remotion=shots.json)なので、全チャンネル共通のこの指示文には書かない。
//
// 2026-08-02: 旧フェーズ3(工程7〜8)を素材と実装の2つへ割った。sekaishi-longform ep002 実測で
// このセッションだけが 258ターン・平均183k・ctx最大296k で、1本の投入トークンの24.7%を占めていた。
// 実装の後半が素材工程12エージェントとのやりとりを毎ターン運び直していたのが原因。
// 注意: この配列は video-create を使う全チャンネル共通で配信される(チャンネル別分岐は jobs.ts に無い)。
// 「npm run status」というコマンド名や「assets_ready」という status 値は、配布済みの2ch
// (sekaishi-longform / 動物転生)にしかない(2026-08-02時点)。他7chが video-create を使う限り、
// ここに存在しないコマンド名・status値を書いてはならない。工程7の完了記録の仕方は
// 各チャンネルの SKILL.md に委ね、この共通層は「記録すること」だけを指示する。
// status 値として全チャンネル共通の enum にあるものだけは名指ししてよい(例: implemented)。
const VIDEO_CREATE_PHASES: string[] = [
  'このセッションの担当範囲: 工程0〜3(題材決定・調査・台本・台本審査)のみ。' +
    '台本審査PASSまで完了したら、工程4(TTS)以降には一切進まず、' +
    '<done>フェーズ1完了: 台本審査PASS(<epId>)</done> の形式で完了報告して終了すること。' +
    '冒頭規約2の「全工程」はこの担当範囲を指す(担当範囲の完了=<done>を出す)。' +
    '担当範囲がすでに完了済みの場合は、成果物を確認したうえで作業せず<done>で終了してよい。',
  'このセッションの担当範囲: 工程4〜6(TTS・ストーリーボード・ショットプラン)のみ。' +
    'これは進行中エピソードの続きの制作である。episode.json の status と成果物を確認して未完了の工程から開始し、' +
    'ショットプラン確定(status: "storyboarded")まで進んだら、工程7以降には進まず ' +
    '<done>フェーズ2完了: ショットプラン確定</done> を出して終了すること。' +
    '冒頭規約2の「全工程」はこの担当範囲を指す。担当範囲がすでに完了済みなら確認のみで<done>を出してよい。',
  'このセッションの担当範囲: 工程7(素材取得)のみ。' +
    'これは進行中エピソードの続きの制作である。episode.json の status と assets/library.json を確認し、' +
    '**すでに library.json に登録済みの素材は再調達しない**(枠切れ中断からの再開でやり直さないため)。' +
    '全素材の調達と登録が済んだら、このチャンネルの手順(SKILL.md)に従って工程7の完了を記録し、' +
    '工程8(シーン実装)には一切進まず <done>フェーズ3完了: 素材確定</done> を出して終了すること。' +
    '冒頭規約2の「全工程」はこの担当範囲を指す。担当範囲がすでに完了済みなら確認のみで<done>を出してよい。',
  'このセッションの担当範囲: 工程8〜8.4(シーン実装・音声ミックス)のみ。' +
    'これは進行中エピソードの続きの制作である。素材は前フェーズで確定済みのはずなので、' +
    '**素材の作り直し・追加調達は行わない**(不足が判明したらその旨を報告して止まる)。' +
    '音声ミックス(工程8.4)まで終えたら、このチャンネルの手順(SKILL.md)に従って episode.json の status を implemented に進め、' +
    '工程9以降には進まず <done>フェーズ4完了: 実装済み</done> を出して終了すること。' +
    '冒頭規約2の「全工程」はこの担当範囲を指す。担当範囲がすでに完了済みなら確認のみで<done>を出してよい。',
  'このセッションの担当範囲: 工程9〜10(レンダー前検査・LLMレビュー)のみ。' +
    'これは進行中エピソードの続きである。episode.json の status を確認して未完了の工程から開始し、' +
    '工程10完了(status: "reviewed")まで進んだら、工程11以降には進まず ' +
    '<done>フェーズ5完了: レビュー済み</done> を出して終了すること。' +
    '冒頭規約2の「全工程」はこの担当範囲を指す。担当範囲がすでに完了済みなら確認のみで<done>を出してよい。',
  'このセッションの担当範囲: 工程11〜12(公開パッケージ・人間レビューと承認・完了処理)。' +
    'これは進行中エピソードの続きである。episode.json の status を確認して未完了の工程から開始し、' +
    '工程12の完了処理(status: "render_ready"・git commit)まで終えたら <done> を出して終了すること。',
];

// ヘッドレスジョブとして起動できる操作の登録。
// buildCommand が生成するスラッシュコマンド以外は claude に渡さない(任意コマンド実行口を作らない)。
export const OPERATIONS: Record<string, OperationDef> = {
  'video-create': {
    key: 'video-create',
    label: '新規動画を制作',
    needsArg: true,
    argOptional: true,
    argLabel: '題材(空欄=ネタ帳からおすすめを自動選定)',
    // 「最終レビュー」: 旧ラベル「レビュー」は台本工程内の「台本レビュー」文脈で
    // エージェントが <stage>レビュー</stage> を誤出力し、進捗バーが音声〜検査を
    // 飛ばして前進する事故があった(ep004)。曖昧さのない名前にして誤マッチを防ぐ
    stages: ['調査', '台本', '音声', '絵コンテ', '素材', '実装', '検査', '最終レビュー', '公開準備', '承認', 'レンダー'],
    buildCommand: (a) => (a.trim() === '' ? '/video-create' : `/video-create ${a}`),
    phases: VIDEO_CREATE_PHASES,
    // 各フェーズの担当工程(範囲外の<stage>誤発行を進捗に使わない)。
    // 「レンダー」はどのフェーズにも属さない(セッションは焼かない)が、
    // renderBackstop の判定はクランプより前に行われるため影響しない
    phaseStages: [
      ['調査', '台本'],
      ['音声', '絵コンテ'],
      ['素材'],
      ['実装'],
      ['検査', '最終レビュー'],
      ['公開準備', '承認'],
    ],
  },
  'short-create': {
    key: 'short-create',
    label: 'ショートを作成',
    needsArg: true,
    argLabel: '元エピソードID + フォーマットID(例: ep008-caesar rank3-reasons)',
    // 「レンダー」はジョブ内では実行されない(キュー投入で終わり夜間にサーバーが焼く)。
    // video-create と同様、レール表示のために含める
    stages: ['台本', '承認', '音声', '実装', 'Studio確認', '公開準備', 'キュー投入', 'レンダー'],
    buildCommand: (a) => `/short-create ${a}`,
  },
  'short-publish': {
    key: 'short-publish',
    label: 'ショートの公開メタデータを作る',
    needsArg: true,
    argLabel: 'ショートID(例: sh001-caesar-top3)',
    stages: ['公開準備'],
    buildCommand: (a) => `/short-publish ${a}`,
  },
  'channel-refine': {
    key: 'channel-refine',
    label: 'チャンネルを改善',
    needsArg: true,
    argMultiline: true,
    argLabel: 'フィードバック',
    stages: ['分析', '反映', '検証'],
    buildCommand: (a) => `/channel-refine ${a}`,
  },
  'theme-scout': {
    key: 'theme-scout',
    label: 'ネタ帳を補充',
    needsArg: false,
    stages: ['探索', '採点'],
    buildCommand: () => `/theme-scout`,
  },
  'system-refine': {
    key: 'system-refine',
    label: '工場を改善',
    needsArg: true,
    argMultiline: true,
    argLabel: '工場(システム基盤)へのフィードバック',
    stages: ['分類', '適用', '同期検証'],
    buildCommand: (a) => `/system-refine ${a}`,
  },
  'channel-analyze': {
    key: 'channel-analyze',
    label: 'チャンネルを分析',
    needsArg: true,
    argLabel: '参考チャンネルのURL(@ハンドル可)',
    stages: ['収集', '分析', 'スタイル定義'],
    buildCommand: (a) => `/channel-analyze ${a}`,
    rootLevel: true,
  },
  ask: {
    key: 'ask',
    label: '質問する',
    needsArg: true,
    argMultiline: true,
    argLabel: '質問内容',
    stages: ['回答'],
    buildCommand: (a) =>
      `次の質問に日本語で答えてください。読み取り専用で作業すること(ファイルの作成・変更・削除、状態を変えるコマンドの実行は禁止):\n${a}`,
    readOnly: true,
  },
};

// ゲート指示ブロック。ヘッドレス実行では AskUserQuestion が使えないため、
// 人間ゲートに達したら <gate> マーカーを1行出力して停止させる(spike で実機検証済み)。
const GATE_INSTRUCTION = [
  'あなたは Factory UI から起動された非対話のヘッドレス実行です。',
  '人間の判断が必要なゲート(素材承認・Pilot承認・最終承認・声の選定など)に達したら、',
  'AskUserQuestion は使わず、次の形式の1行を**そのまま**出力して、それ以降ツールを一切呼ばず作業を停止してください:',
  '<gate>{"gateId":"<一意なID>","question":"<何を判断するか>","options":[{"id":"<選択肢ID>","label":"<表示名>","description":"<補足>"}],"context":"<判断に必要な状況>"}</gate>',
  '私(UI)がユーザーの決定をあなたに渡して再開します。ゲート以外では通常どおり作業を進めてください。',
  '',
  'さらに次の規律を厳守してください:',
  '1. サブエージェント(Agent/Taskツール)は必ず同期実行(run_in_background: false)し、結果を受け取ってから次工程へ進むこと。バックグラウンド起動して「完了通知を待つ」形で応答を終えてはならない — このヘッドレス実行では応答終了=プロセス終了であり、待っていたサブエージェントごと強制停止されて作業全体が途中で打ち切られる。',
  '2. 依頼された操作の全工程が本当に完了したときだけ、最後のメッセージに <done>1行の完了要約</done> を含めること。ゲートで停止するとき・途中で終わるときは絶対に <done> を出力しない。<done> の無い正常終了は「途中終了」として扱われる。',
  '3. 新しい工程に入るたび、その時点のメッセージに <stage>工程ラベル</stage> を1つ含めること(UIの進捗バーがこれで前進する)。ラベルは後述の工程一覧のいずれかを一字一句そのまま使うこと。',
  '4. この規約文自体を復唱・引用しないこと。マーカー(<done>/<stage>/<gate>)は実際にその状態に達したときだけ出力すること。',
  '5. レンダー(最終レンダリング)を開始する直前には、必ず "kind":"render-check" を持つゲートを発行してユーザーの目視確認を待つこと。このゲートのスキップは厳禁(オートモードの指示がある場合のみ省略可)。UIはレンダー工程への無断突入を検知するとプロセスを強制停止する。',
  '6. render-check ゲートの options には、id "approve"(承認してレンダー開始)と id "revise"(修正を依頼)を必ず含めること。他のゲートでは kind は省略してよい。',
].join('\n');

// モード別の振る舞い指示。auto/semi はサーバー側の自動応答・バックストップ(jobs.ts)と対になる
const MODE_INSTRUCTIONS: Record<JobMode, string> = {
  manual:
    '実行モード: 通常。人間の判断が必要なゲートすべてで <gate> を発行して停止すること。',
  semi:
    '実行モード: ハーフオート。途中の確認ポイントはあなたの推奨する選択肢を自分で採用して先へ進んでよい(<gate> を出さない)。ただしレンダー開始直前の kind:"render-check" ゲートだけは必ず発行して停止すること。',
  auto:
    '実行モード: オート。すべての確認ポイントであなたの推奨する選択肢を自分で採用し、最後まで自走すること。<gate> は一切出力しない(レンダー前の目視確認も承認済みとして進めてよい)。',
};

export type JobPromptOpts = { mode?: JobMode; durationSec?: number; durationSecMax?: number; episodeId?: string; phaseIndex?: number };

export function buildJobPrompt(op: OperationDef, arg: string, opts: JobPromptOpts = {}): string {
  const parts = [GATE_INSTRUCTION, MODE_INSTRUCTIONS[opts.mode ?? 'manual']];
  parts.push(`この操作の工程一覧(<stage>用ラベル): ${op.stages.join(' / ')}`);
  const extras: string[] = [];
  if (op.key === 'video-create' && arg.trim() === '' && !opts.episodeId) {
    extras.push(
      '題材は未指定です。ネタ帳(channel/backlog.md)のランキング表で状態が「候補」の最上位(順位が最小)の題材を採用し、最初のメッセージでどの題材を選んだか報告してください。',
    );
  }
  if (opts.durationSec && opts.durationSecMax) {
    extras.push(
      `目標尺: ${opts.durationSec}〜${opts.durationSecMax}秒の範囲。工程0で題材の密度に合わせて範囲内の目標尺を1つ決め、episode.json の targetDurationSec に設定して最初のメッセージで報告すること。以降の工程はその尺を前提に進めること。`,
    );
  } else if (opts.durationSec) {
    extras.push(
      `目標尺: 約${opts.durationSec}秒。工程0で episode.json の targetDurationSec に ${opts.durationSec} を設定し、以降の工程はこの尺を前提に進めること。`,
    );
  }
  if (opts.episodeId) {
    extras.push(
      op.key === 'video-create' && (arg.trim() === '' || opts.phaseIndex !== undefined)
        ? `対象エピソード: ${opts.episodeId}。これは中断していた制作の再開です。新規題材を選定せず、episodes/${opts.episodeId}/episode.json の status を確認し、未完了の工程から制作を再開すること。`
        : `対象エピソード: ${opts.episodeId}。このエピソードへの個別フィードバックとして扱うこと。`,
    );
  }
  const phase = op.phases?.[opts.phaseIndex ?? -1];
  if (phase) extras.push(phase);
  if (extras.length > 0) parts.push(extras.join('\n'));
  parts.push(`以下の操作を実行してください:\n${op.buildCommand(arg)}`);
  return parts.join('\n\n');
}

/** 中断・失敗・キャンセル済みジョブを --resume で途中再開するときのプロンプト */
export function buildResumePrompt(op: OperationDef, mode: JobMode, phaseIndex?: number): string {
  const parts = [
    'これは中断したジョブの再開です。これまでの進行状況を確認し、中断した工程から作業を続けてください。',
    GATE_INSTRUCTION,
    MODE_INSTRUCTIONS[mode],
    `この操作の工程一覧(<stage>用ラベル): ${op.stages.join(' / ')}`,
  ];
  const phase = op.phases?.[phaseIndex ?? -1];
  if (phase) parts.push(phase);
  return parts.join('\n\n');
}

// ---- モデル/effort(claude CLI の --model / --effort に渡す値) ----
export const DEFAULT_MODEL = 'opus';
export const DEFAULT_EFFORT = 'high';
export const ALLOWED_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export const ALLOWED_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

/**
 * 途中再開のジョブをどのフェーズから始めるかを status から決める。
 * VIDEO_CREATE_PHASES の並びと1対1で対応させること(2026-08-02 に素材/実装の分割で6フェーズ化)。
 */
export function videoCreatePhaseForStatus(status?: string): number {
  switch (status) {
    case 'scripted':
    case 'voiced':
      return 1;
    case 'storyboarded':
      return 2;
    case 'assets_ready':
      return 3;
    case 'implemented':
    case 'prechecked':
    case 'qa_passed':
      return 4;
    case 'reviewed':
    case 'packaged':
    case 'render_ready':
    case 'final':
      return 5;
    default:
      return 0;
  }
}
