import type { GateRequest, RateLimitInfo } from '../shared/types';

// `claude -p --output-format=stream-json --verbose` の 1 行(改行区切りJSON)を
// 構造化イベントへ変換するパーサ。イベント形の根拠は実観測のスパイクメモ:
//   docs/superpowers/notes/2026-07-09-gate-spike-result.md
// 契約は Task 4(JobManager)が依存するため逐語遵守。

export type ParsedEvent =
  | { kind: 'init'; sessionId: string; cwd: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'gate'; gate: GateRequest; text: string }
  | { kind: 'rate-limit'; info: RateLimitInfo }
  | { kind: 'result'; success: boolean; sessionId: string; result: string }
  | { kind: 'unknown' };

const UNKNOWN: ParsedEvent = { kind: 'unknown' };

// 最初の <gate>...</gate>(本文に改行を含みうるので [\s\S]、最初の閉じで止めるため非貪欲)
const GATE_RE = /<gate>([\s\S]*?)<\/gate>/;

// 完了マーカー。ヘッドレスagentは全工程完了時のみ <done>要約</done> を出力する規約
// (operations.ts のジョブプロンプトで指示)。exit 0 でもこれが無ければ途中終了とみなす。
const DONE_RE = /<done>[\s\S]*?<\/done>/;

// 工程マーカー。agentは新しい工程に入るたび <stage>工程ラベル</stage> を出力する規約
// (operations.ts のジョブプロンプトで指示)。ゲートが無い区間でも進捗バーを前進させる。
const STAGE_RE = /<stage>([^<]*)<\/stage>/;

/** text から最初の <stage>ラベル</stage> を取り出す。無ければ null */
export function extractStage(text: string): string | null {
  const m = STAGE_RE.exec(text);
  if (!m) return null;
  const label = m[1]!.trim();
  return label === '' ? null : label;
}

/** text に完了マーカー <done>...</done> が含まれるか(assistant text / result.result 両方に適用可) */
export function hasDone(text: string): boolean {
  return DONE_RE.test(text);
}

/**
 * UI表示用にマーカーを取り除く。<done>要約</done> は中身(要約)を残し、
 * <stage>/<gate> は丸ごと除去する。前後の空白はtrim。
 */
export function stripMarkers(text: string): string {
  return text
    .replace(/<done>([\s\S]*?)<\/done>/g, '$1')
    .replace(/<stage>[^<]*<\/stage>/g, '')
    .replace(/<gate>[\s\S]*?<\/gate>/g, '')
    .trim();
}

/**
 * 改行区切りJSON行を1行受け取り解釈する。
 * - 空行(空白のみ含む)は null(partial なバッファ結合は呼び出し側の責務)。
 * - 不正JSONは throw せず { kind: 'unknown' } を返す。
 */
export function parseLine(line: string): ParsedEvent | null {
  if (line.trim() === '') return null;

  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return UNKNOWN;
  }
  if (obj === null || typeof obj !== 'object') return UNKNOWN;

  switch (obj.type) {
    case 'system':
      if (obj.subtype === 'init') {
        return {
          kind: 'init',
          sessionId: typeof obj.session_id === 'string' ? obj.session_id : '',
          cwd: typeof obj.cwd === 'string' ? obj.cwd : '',
        };
      }
      return UNKNOWN;

    case 'assistant':
      return parseAssistant(obj);

    case 'rate_limit_event': {
      const info = obj.rate_limit_info;
      if (info && typeof info === 'object') {
        return { kind: 'rate-limit', info: info as RateLimitInfo };
      }
      return UNKNOWN;
    }

    case 'result':
      return {
        kind: 'result',
        // 明示的な success 以外(error_max_turns 等)はすべて失敗扱い。
        success: obj.subtype === 'success',
        sessionId: typeof obj.session_id === 'string' ? obj.session_id : '',
        result: typeof obj.result === 'string' ? obj.result : '',
      };

    default:
      return UNKNOWN;
  }
}

// assistant の message.content[] を先頭から走査し、最初に解釈できたブロックで確定する。
// text ブロックは <gate> を含めば gate(元textも保持。<stage>同居時にjobs.ts側で拾うため)、
// なければ text。tool_use は tool。thinking など未対応ブロックは読み飛ばす。
function parseAssistant(obj: any): ParsedEvent {
  const content = obj?.message?.content;
  if (!Array.isArray(content)) return UNKNOWN;

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'text' && typeof block.text === 'string') {
      const gate = extractGate(block.text);
      if (gate) return { kind: 'gate', gate, text: block.text };
      return { kind: 'text', text: block.text };
    }

    if (block.type === 'tool_use' && typeof block.name === 'string') {
      return { kind: 'tool', name: block.name };
    }
  }

  return UNKNOWN;
}

/**
 * text から最初の <gate>...</gate> を取り出し JSON.parse する。
 * マッチ無し・parse失敗・オブジェクトでない場合は null(throw しない)。
 * ゲートは assistant text と result.result の両方に出るため、呼び出し側は
 * result 種別のイベントに対しても本関数を適用できる。
 */
export function extractGate(text: string): GateRequest | null {
  const m = GATE_RE.exec(text);
  if (!m) return null;

  try {
    const parsed = JSON.parse(m[1].trim());
    if (parsed !== null && typeof parsed === 'object') {
      const gate = parsed as GateRequest;
      // モデルが kind を出し忘れても、gateId の命名から render-check を補完する
      // (UIのStudioボタン表示・レンダーキュー登録がkindに依存するため)
      if (gate.kind === undefined && typeof gate.gateId === 'string' && gate.gateId.includes('render-check')) {
        gate.kind = 'render-check';
      }
      return gate;
    }
    return null;
  } catch {
    return null;
  }
}
