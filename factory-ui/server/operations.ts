import type { OperationDef, JobMode } from '../shared/types';

// ヘッドレスジョブとして起動できる操作の登録。
// buildCommand が生成するスラッシュコマンド以外は claude に渡さない(任意コマンド実行口を作らない)。
export const OPERATIONS: Record<string, OperationDef> = {
  'video-create': {
    key: 'video-create',
    label: '新規動画を制作',
    needsArg: true,
    argOptional: true,
    argLabel: '題材(空欄=ネタ帳からおすすめを自動選定)',
    stages: ['調査', '台本', '音声', '絵コンテ', '素材', '実装', '検査', 'レビュー', '公開準備', '承認', 'レンダー'],
    buildCommand: (a) => (a.trim() === '' ? '/video-create' : `/video-create ${a}`),
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

export type JobPromptOpts = { mode?: JobMode; durationSec?: number; episodeId?: string };

export function buildJobPrompt(op: OperationDef, arg: string, opts: JobPromptOpts = {}): string {
  const parts = [GATE_INSTRUCTION, MODE_INSTRUCTIONS[opts.mode ?? 'manual']];
  parts.push(`この操作の工程一覧(<stage>用ラベル): ${op.stages.join(' / ')}`);
  const extras: string[] = [];
  if (op.key === 'video-create' && arg.trim() === '' && !opts.episodeId) {
    extras.push(
      '題材は未指定です。ネタ帳(channel/backlog.md)のランキング表で状態が「候補」の最上位(順位が最小)の題材を採用し、最初のメッセージでどの題材を選んだか報告してください。',
    );
  }
  if (opts.durationSec) {
    extras.push(
      `目標尺: 約${opts.durationSec}秒。工程0で episode.json の targetDurationSec に ${opts.durationSec} を設定し、以降の工程はこの尺を前提に進めること。`,
    );
  }
  if (opts.episodeId) {
    extras.push(
      op.key === 'video-create' && arg.trim() === ''
        ? `対象エピソード: ${opts.episodeId}。これは中断していた制作の再開です。新規題材を選定せず、episodes/${opts.episodeId}/episode.json の status を確認し、未完了の工程から制作を再開すること。`
        : `対象エピソード: ${opts.episodeId}。このエピソードへの個別フィードバックとして扱うこと。`,
    );
  }
  if (extras.length > 0) parts.push(extras.join('\n'));
  parts.push(`以下の操作を実行してください:\n${op.buildCommand(arg)}`);
  return parts.join('\n\n');
}

/** 中断・失敗・キャンセル済みジョブを --resume で途中再開するときのプロンプト */
export function buildResumePrompt(op: OperationDef, mode: JobMode): string {
  return [
    'これは中断したジョブの再開です。これまでの進行状況を確認し、中断した工程から作業を続けてください。',
    GATE_INSTRUCTION,
    MODE_INSTRUCTIONS[mode],
    `この操作の工程一覧(<stage>用ラベル): ${op.stages.join(' / ')}`,
  ].join('\n\n');
}

// ---- モデル/effort(claude CLI の --model / --effort に渡す値) ----
export const DEFAULT_MODEL = 'opus';
export const DEFAULT_EFFORT = 'xhigh';
export const ALLOWED_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export const ALLOWED_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
