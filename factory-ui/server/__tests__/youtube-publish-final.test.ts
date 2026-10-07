import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkArgs, checkLocalPreflight } from '../youtube-publish-guard';
import { localPublishTimes } from '../youtube-slot';

function ep(opts: { result?: boolean; video?: boolean; publishAt?: string } = {}): { ch: string; epDir: string } {
  const ch = fs.mkdtempSync(path.join(os.tmpdir(), 'final-'));
  const epDir = path.join(ch, 'episodes', 'ep001');
  fs.mkdirSync(path.join(epDir, 'publish'), { recursive: true });
  fs.mkdirSync(path.join(epDir, 'out'), { recursive: true });
  if (opts.video !== false) fs.writeFileSync(path.join(epDir, 'out', 'final.mp4'), 'x');
  if (opts.result) fs.writeFileSync(path.join(epDir, 'publish', 'upload-result.json'), '{"videoId":"v"}');
  if (opts.publishAt) fs.writeFileSync(path.join(epDir, 'publish', 'metadata.json'), JSON.stringify({ publishAt: opts.publishAt }));
  return { ch, epDir };
}

describe('checkArgs(I3: 未知のフラグで止める)', () => {
  it('既知のフラグだけなら空', () => {
    expect(checkArgs(['.', 'ep1', '--auto-slot', '--min-lead-hours', '3', '--file', 'out/a.mp4'])).toEqual([]);
  });
  it('打ち間違いは理由を返す', () => {
    expect(checkArgs(['.', 'ep1', '--showslot'])[0]).toMatch(/--showslot/);
  });
});

describe('checkLocalPreflight(I1: metadata を書く前にアップロード可否を確かめる)', () => {
  it('未アップロード・動画ありなら空', () => {
    expect(checkLocalPreflight(ep().epDir, 'out/final.mp4')).toEqual([]);
  });
  it('upload-result があれば duplicate', () => {
    expect(checkLocalPreflight(ep({ result: true }).epDir, 'out/final.mp4')[0]).toMatch(/upload-result/);
  });
  it('動画が無ければ止める', () => {
    expect(checkLocalPreflight(ep({ video: false }).epDir, 'out/final.mp4')[0]).toMatch(/final\.mp4/);
  });
});

describe('localPublishTimes(I2: ローカルの予約記録も枠を埋める)', () => {
  it('upload-result がある回の metadata.publishAt だけを返す', () => {
    const a = ep({ result: true, publishAt: '2026-10-08T18:00:00+09:00' });
    const b = path.join(a.ch, 'episodes', 'ep002', 'publish');
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(b, 'metadata.json'), JSON.stringify({ publishAt: '2026-10-09T18:00:00+09:00' })); // 未アップロード
    expect(localPublishTimes(a.ch)).toEqual(['2026-10-08T18:00:00+09:00']);
  });
  it('episodes が無ければ空', () => {
    expect(localPublishTimes(fs.mkdtempSync(path.join(os.tmpdir(), 'none-')))).toEqual([]);
  });
});
