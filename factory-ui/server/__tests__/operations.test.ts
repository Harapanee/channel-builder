import { describe, it, expect } from 'vitest';
import { OPERATIONS, buildJobPrompt, buildResumePrompt } from '../operations';

const vc = OPERATIONS['video-create']!;
const cr = OPERATIONS['channel-refine']!;

describe('OPERATIONS 登録', () => {
  it('system-refine と ask が登録されている', () => {
    expect(OPERATIONS['system-refine']?.label).toBe('工場を改善');
    expect(OPERATIONS['system-refine']?.stages).toEqual(['分類', '適用', '同期検証']);
    expect(OPERATIONS['ask']?.label).toBe('質問する');
    expect(OPERATIONS['ask']?.stages).toEqual(['回答']);
  });

  it('video-create は argOptional。空引数で /video-create 単体になる', () => {
    expect(vc.argOptional).toBe(true);
    expect(vc.buildCommand('')).toBe('/video-create');
    expect(vc.buildCommand('織田信長')).toBe('/video-create 織田信長');
  });
});

describe('buildJobPrompt', () => {
  it('render-check規約(approve/revise)とスキップ厳禁が常に含まれる', () => {
    const p = buildJobPrompt(vc, 'x');
    expect(p).toContain('render-check');
    expect(p).toContain('approve');
    expect(p).toContain('revise');
    expect(p).toContain('スキップは厳禁');
  });

  it('mode=auto はゲートを出さない指示、semi はrender-checkのみ停止の指示', () => {
    expect(buildJobPrompt(vc, 'x', { mode: 'auto' })).toContain('<gate> は一切出力しない');
    const semi = buildJobPrompt(vc, 'x', { mode: 'semi' });
    expect(semi).toContain('ハーフオート');
    expect(semi).toContain('kind:"render-check"');
  });

  it('題材空欄はネタ帳からの自動選定を指示する', () => {
    const p = buildJobPrompt(vc, '');
    expect(p).toContain('backlog.md');
    expect(p.trimEnd().endsWith('/video-create')).toBe(true);
  });

  it('durationSec は targetDurationSec 指示になる', () => {
    const p = buildJobPrompt(vc, 'x', { durationSec: 180 });
    expect(p).toContain('targetDurationSec');
    expect(p).toContain('180');
  });

  it('episodeId は個別フィードバック指示になる', () => {
    const p = buildJobPrompt(cr, '声が小さい', { episodeId: 'ep010' });
    expect(p).toContain('対象エピソード: ep010');
  });

  it('video-createでarg空+episodeId指定は再開指示になり、ネタ帳選定文言を含まない', () => {
    const p = buildJobPrompt(OPERATIONS['video-create']!, '', { episodeId: 'ep009-columbus' });
    expect(p).toContain('未完了の工程から制作を再開');
    expect(p).toContain('ep009-columbus');
    expect(p).not.toContain('ネタ帳');
  });

  it('video-createでargあり+episodeId指定は従来どおり個別フィードバック扱い', () => {
    const p = buildJobPrompt(OPERATIONS['video-create']!, 'テロップ直して', { episodeId: 'ep009-columbus' });
    expect(p).toContain('個別フィードバック');
  });

  it('video-create以外でarg空+episodeId指定は再開文言を含まず個別フィードバック扱い', () => {
    const p = buildJobPrompt(cr, '', { episodeId: 'ep010' });
    expect(p).not.toContain('未完了の工程から制作を再開');
    expect(p).toContain('個別フィードバック');
    expect(p).toContain('ep010');
  });

  it('ask は読み取り専用の指示になる', () => {
    const p = buildJobPrompt(OPERATIONS['ask']!, '今の進捗は?');
    expect(p).toContain('読み取り専用');
    expect(p).toContain('今の進捗は?');
  });
});

describe('buildResumePrompt', () => {
  it('再開指示+マーカー規約+工程一覧+モード指示を含む', () => {
    const p = buildResumePrompt(vc, 'semi');
    expect(p).toContain('中断したジョブの再開');
    expect(p).toContain('<done>');
    expect(p).toContain('調査 / 台本');
    expect(p).toContain('ハーフオート');
  });
});
