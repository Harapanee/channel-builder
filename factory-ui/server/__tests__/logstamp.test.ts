import { describe, expect, it } from 'vitest';
import { stampLogLine } from '../logstamp';

describe('stampLogLine', () => {
  it('timestampがnullのJSON行に現在時刻を注入する', () => {
    const line = '{"type":"assistant","timestamp":null,"text":"x"}';
    const out = JSON.parse(stampLogLine(line, 1783900000000));
    expect(out.timestamp).toBe(1783900000000);
    expect(out.text).toBe('x');
  });
  it('timestampフィールドが無いJSON行にも注入する', () => {
    const out = JSON.parse(stampLogLine('{"type":"system"}', 42));
    expect(out.timestamp).toBe(42);
  });
  it('既に値があるtimestampは上書きしない', () => {
    const out = JSON.parse(stampLogLine('{"timestamp":100}', 42));
    expect(out.timestamp).toBe(100);
  });
  it('JSONでない行はそのまま返す', () => {
    expect(stampLogLine('plain text', 42)).toBe('plain text');
  });
  it('JSON配列行はそのまま返す', () => {
    expect(stampLogLine('[1,2,3]', 42)).toBe('[1,2,3]');
  });
  it('JSONのnullリテラル行はそのまま返す', () => {
    expect(stampLogLine('null', 42)).toBe('null');
  });
});
