import { describe, expect, it } from 'vitest';
import { extractTime, formatClock, parseTimestamp } from '../logTime';

describe('parseTimestamp', () => {
  it('サーバーが注入した epoch ms(number)をそのまま返す', () => {
    expect(parseTimestamp(1_752_000_000_000)).toBe(1_752_000_000_000);
  });

  it('claude CLI が付ける ISO8601 文字列を epoch ms に変換する', () => {
    expect(parseTimestamp('2026-07-13T05:38:38.792Z')).toBe(Date.parse('2026-07-13T05:38:38.792Z'));
  });

  it('時刻を持たない行(null / undefined)は undefined', () => {
    expect(parseTimestamp(null)).toBeUndefined();
    expect(parseTimestamp(undefined)).toBeUndefined();
  });

  it('解釈できない値(不正な文字列・NaN・オブジェクト)は undefined', () => {
    expect(parseTimestamp('いつか')).toBeUndefined();
    expect(parseTimestamp(Number.NaN)).toBeUndefined();
    expect(parseTimestamp({ at: 1 })).toBeUndefined();
  });
});

describe('extractTime', () => {
  it('スタンプ済みの行(number)から時刻を取り出す', () => {
    const line = JSON.stringify({ type: 'assistant', timestamp: 1_752_000_000_000 });
    expect(extractTime(line)).toBe(1_752_000_000_000);
  });

  it('CLI 由来の ISO 文字列を持つ行から時刻を取り出す', () => {
    const line = JSON.stringify({ type: 'user', timestamp: '2026-07-13T05:38:38.792Z' });
    expect(extractTime(line)).toBe(Date.parse('2026-07-13T05:38:38.792Z'));
  });

  it('スタンプ導入前のログ(timestampなし)は undefined', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'task_progress' });
    expect(extractTime(line)).toBeUndefined();
  });

  it('非JSON行・空行は undefined(落ちない)', () => {
    expect(extractTime('npm warn deprecated foo@1.0.0')).toBeUndefined();
    expect(extractTime('')).toBeUndefined();
    expect(extractTime('null')).toBeUndefined();
    expect(extractTime('[1,2]')).toBeUndefined();
  });
});

describe('formatClock', () => {
  it('HH:MM:SS(24時間・ゼロ埋め)に整形する', () => {
    // ローカル時刻の成分から作る(テストをタイムゾーン非依存にする)
    const t = new Date(2026, 6, 14, 9, 5, 3).getTime();
    expect(formatClock(t)).toBe('09:05:03');
  });

  it('午前0時は 00:00:00(24:00:00 にしない)', () => {
    const t = new Date(2026, 6, 14, 0, 0, 0).getTime();
    expect(formatClock(t)).toBe('00:00:00');
  });

  it('午後は24時間表記', () => {
    const t = new Date(2026, 6, 14, 14, 32, 7).getTime();
    expect(formatClock(t)).toBe('14:32:07');
  });
});
