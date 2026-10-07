import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPublishConfig } from '../youtube-publish-config';

function ch(json?: unknown): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pubcfg-'));
  fs.mkdirSync(path.join(d, 'channel'));
  if (json !== undefined) fs.writeFileSync(path.join(d, 'channel', 'youtube-publish.json'), JSON.stringify(json));
  return d;
}

describe('readPublishConfig', () => {
  it('ファイルが無ければ既定値', () => {
    expect(readPublishConfig(ch())).toEqual({ playlists: { episode: [], short: [] }, minLeadHours: 24 });
  });
  it('値を読み、省略キーは既定で埋める', () => {
    expect(readPublishConfig(ch({ playlists: { episode: ['PLabc'] } }))).toEqual({
      playlists: { episode: ['PLabc'], short: [] },
      minLeadHours: 24,
    });
  });
  it('再生リストIDが文字列でなければ invalid:', () => {
    expect(() => readPublishConfig(ch({ playlists: { episode: [1] } }))).toThrow(/^invalid: /);
  });
  it('minLeadHours が負なら invalid:', () => {
    expect(() => readPublishConfig(ch({ minLeadHours: -1 }))).toThrow(/^invalid: /);
  });
});

describe('readPublishConfig dailySlotHourJst', () => {
  it('省略時は undefined(自動枠なし)', () => {
    expect(readPublishConfig(ch({})).dailySlotHourJst).toBeUndefined();
  });
  it('0〜23 の整数を読む', () => {
    expect(readPublishConfig(ch({ dailySlotHourJst: 18 })).dailySlotHourJst).toBe(18);
  });
  it('範囲外は invalid:', () => {
    expect(() => readPublishConfig(ch({ dailySlotHourJst: 24 }))).toThrow(/^invalid: /);
  });
});
