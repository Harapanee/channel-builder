import { describe, it, expect } from 'vitest';
import { parseLine, extractGate, stripMarkers } from '../streamparse';
import type { GateRequest } from '../../shared/types';

// スパイクで実観測したイベント形に厳密に合わせる:
//   docs/superpowers/notes/2026-07-09-gate-spike-result.md

const gateObj: GateRequest = {
  gateId: 'approve-materials',
  question: '生成した素材を承認しますか?',
  options: [
    { id: 'yes', label: '承認して次へ', description: '4枚で進める' },
    { id: 'redo', label: '作り直す', description: '別案を生成' },
  ],
  context: '素材を4枚生成済み。preview/ に配置。',
};

const gateMarker = `<gate>${JSON.stringify(gateObj)}</gate>`;

describe('parseLine — stream-json 1行を構造化イベントへ', () => {
  it('init行: session_id/cwd を抽出する', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-abc',
      cwd: '/Users/x/channel',
      tools: ['Bash', 'Read'],
    });
    expect(parseLine(line)).toEqual({
      kind: 'init',
      sessionId: 'sess-abc',
      cwd: '/Users/x/channel',
    });
  });

  it('system の init 以外の subtype は unknown', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'hook_started' });
    expect(parseLine(line)).toEqual({ kind: 'unknown' });
  });

  it('assistant text行: text を取り出す', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'こんにちは' }] },
    });
    expect(parseLine(line)).toEqual({ kind: 'text', text: 'こんにちは' });
  });

  it('assistant tool_use行: tool 名を取り出す', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    });
    expect(parseLine(line)).toEqual({ kind: 'tool', name: 'Bash' });
  });

  it('assistant text に <gate> を含む: gate を抽出(gateId/options含む)、元textも保持する', () => {
    const text = `準備できました。${gateMarker}`;
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    });
    const ev = parseLine(line);
    expect(ev).toEqual({ kind: 'gate', gate: gateObj, text });
    // 契約: gateId と options が保持される。text も保持される(<stage>同居時にjobs.ts側で使う)
    expect(ev?.kind).toBe('gate');
    if (ev?.kind === 'gate') {
      expect(ev.gate.gateId).toBe('approve-materials');
      expect(ev.gate.options).toHaveLength(2);
      expect(ev.gate.options[0].id).toBe('yes');
      expect(ev.text).toBe(text);
    }
  });

  it('thinking など未対応ブロックは飛ばして text を拾う', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '...' },
          { type: 'text', text: '本文' },
        ],
      },
    });
    expect(parseLine(line)).toEqual({ kind: 'text', text: '本文' });
  });

  it('rate_limit_event行: utilization 等を info に格納', () => {
    const line = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        utilization: 0.91,
        rateLimitType: 'seven_day',
        resetsAt: 1783926000,
        status: 'allowed_warning',
      },
    });
    expect(parseLine(line)).toEqual({
      kind: 'rate-limit',
      info: {
        utilization: 0.91,
        rateLimitType: 'seven_day',
        resetsAt: 1783926000,
        status: 'allowed_warning',
      },
    });
  });

  it('result:success行: success=true / sessionId / result を返す', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'sess-xyz',
      result: '最終テキスト',
    });
    expect(parseLine(line)).toEqual({
      kind: 'result',
      success: true,
      sessionId: 'sess-xyz',
      result: '最終テキスト',
    });
  });

  it('result:error行: success=false', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      session_id: 'sess-err',
      result: '失敗',
    });
    expect(parseLine(line)).toEqual({
      kind: 'result',
      success: false,
      sessionId: 'sess-err',
      result: '失敗',
    });
  });

  it('result.result に <gate> が乗っても result 種別を返す(session_id を失わない)', () => {
    // ゲートは result.result にも出るが、resume に session_id が要るため
    // parseLine は result を返し、呼び出し側が extractGate(result) する契約。
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'sess-gate',
      result: gateMarker,
    });
    const ev = parseLine(line);
    expect(ev?.kind).toBe('result');
    if (ev?.kind === 'result') {
      expect(ev.sessionId).toBe('sess-gate');
      expect(extractGate(ev.result)).toEqual(gateObj);
    }
  });

  it('不正JSON: throw せず unknown を返す', () => {
    expect(() => parseLine('{ not json')).not.toThrow();
    expect(parseLine('{ not json')).toEqual({ kind: 'unknown' });
  });

  it('未知の type: unknown を返す', () => {
    const line = JSON.stringify({ type: 'stream_event', foo: 1 });
    expect(parseLine(line)).toEqual({ kind: 'unknown' });
  });

  it('空行: null を返す', () => {
    expect(parseLine('')).toBeNull();
  });

  it('空白のみの行: null を返す', () => {
    expect(parseLine('   \t ')).toBeNull();
  });
});

describe('extractGate — text から最初の <gate>...</gate> を JSON.parse', () => {
  it('gate を含む text から GateRequest を抽出', () => {
    expect(extractGate(`前置き ${gateMarker} 後置き`)).toEqual(gateObj);
  });

  it('複数ある場合は最初の gate を返す(非貪欲)', () => {
    const first: GateRequest = { gateId: 'g1', question: 'q1', options: [], context: 'c1' };
    const second: GateRequest = { gateId: 'g2', question: 'q2', options: [], context: 'c2' };
    const text = `<gate>${JSON.stringify(first)}</gate> ... <gate>${JSON.stringify(second)}</gate>`;
    expect(extractGate(text)?.gateId).toBe('g1');
  });

  it('改行を含む gate 本文も抽出できる', () => {
    const text = `A\n<gate>\n${JSON.stringify(gateObj)}\n</gate>\nB`;
    expect(extractGate(text)).toEqual(gateObj);
  });

  it('gate が無ければ null', () => {
    expect(extractGate('ゲートはありません')).toBeNull();
  });

  it('gate 内が不正JSONなら null(throw しない)', () => {
    expect(() => extractGate('<gate>{ broken</gate>')).not.toThrow();
    expect(extractGate('<gate>{ broken</gate>')).toBeNull();
  });

  it('閉じタグが無ければ null', () => {
    expect(extractGate(`<gate>${JSON.stringify(gateObj)}`)).toBeNull();
  });

  it('kind欠落でも gateId が render-check を含めば kind を補完する', () => {
    const g = { gateId: 'ep009-columbus-render-check', question: 'q', options: [], context: 'c' };
    expect(extractGate(`<gate>${JSON.stringify(g)}</gate>`)?.kind).toBe('render-check');
  });

  it('kind が明示されていればそのまま(上書きしない)', () => {
    const g = { gateId: 'render-check-x', kind: 'other', question: 'q', options: [], context: 'c' };
    expect(extractGate(`<gate>${JSON.stringify(g)}</gate>`)?.kind).toBe('other');
  });

  it('render-check と無関係な gateId には kind を付けない', () => {
    const g = { gateId: 'voice-pick', question: 'q', options: [], context: 'c' };
    expect(extractGate(`<gate>${JSON.stringify(g)}</gate>`)?.kind).toBeUndefined();
  });
});

describe('stripMarkers', () => {
  it('done/stage/gate マーカーを除去し、doneの中身(要約)は残す', () => {
    const t = '前置き <stage>QA</stage> 本文 <done>全工程完了</done> <gate>{"gateId":"g"}</gate>';
    expect(stripMarkers(t)).toBe('前置き  本文 全工程完了');
  });
  it('マーカーが無ければtrimのみ', () => {
    expect(stripMarkers('  回答です  ')).toBe('回答です');
  });
});
