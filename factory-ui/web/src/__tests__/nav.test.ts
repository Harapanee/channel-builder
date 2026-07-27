import { describe, expect, it } from 'vitest';
import { hashFor, parseHash } from '../nav';

describe('parseHash', () => {
  it('#/root をルートターミナルとして解釈する', () => {
    expect(parseHash('#/root')).toEqual({ dir: '', tab: null, item: null });
  });

  it('日本語dirを含むチャンネル+タブ+item付きhashを解釈する', () => {
    expect(parseHash('#/ch/%E4%B8%96%E7%95%8C%E5%8F%B2%E3%81%AE%E8%A3%8F%E8%B7%AF%E5%9C%B0/jobs/abc')).toEqual({
      dir: '世界史の裏路地',
      tab: 'jobs',
      item: 'abc',
    });
  });

  it('タブなし(dirのみ)のhashを解釈する', () => {
    expect(parseHash('#/ch/mychannel')).toEqual({ dir: 'mychannel', tab: null, item: null });
  });

  it('不正なhashはダッシュボード扱い(全てnull)', () => {
    expect(parseHash('#/unknown/path')).toEqual({ dir: null, tab: null, item: null });
    expect(parseHash('')).toEqual({ dir: null, tab: null, item: null });
    expect(parseHash('#/')).toEqual({ dir: null, tab: null, item: null });
  });

  it('encodeURIComponentで往復する(dir/itemの特殊文字を復元できる)', () => {
    const dir = '世界史の裏路地';
    const item = 'job/with space';
    const hash = `#/ch/${encodeURIComponent(dir)}/jobs/${encodeURIComponent(item)}`;
    expect(parseHash(hash)).toEqual({ dir, tab: 'jobs', item });
  });

  it('#/root/jobs(/<id>) はルートジョブとして解釈する', () => {
    expect(parseHash('#/root/jobs')).toEqual({ dir: '', tab: 'jobs', item: null });
    expect(parseHash('#/root/jobs/abc-123')).toEqual({ dir: '', tab: 'jobs', item: 'abc-123' });
  });
});

describe('hashFor', () => {
  it('dir=nullはダッシュボードの#/を返す', () => {
    expect(hashFor(null, null, null)).toBe('#/');
    expect(hashFor(null, 'jobs', 'abc')).toBe('#/');
  });

  it("dir=''はルートターミナルの#/rootを返す(tab=jobsのときはルートジョブになる)", () => {
    expect(hashFor('', null, null)).toBe('#/root');
    expect(hashFor('', 'jobs', 'abc')).toBe('#/root/jobs/abc');
  });

  it('日本語dirをencodeURIComponentしたchハッシュを返す', () => {
    expect(hashFor('世界史の裏路地', 'jobs', 'abc')).toBe(
      `#/ch/${encodeURIComponent('世界史の裏路地')}/jobs/abc`,
    );
  });

  it('タブなしのときはitemを無視する(タブが確定しないとitemはパース不能なため)', () => {
    expect(hashFor('mychannel', null, 'abc')).toBe('#/ch/mychannel');
  });

  it('parseHash(hashFor(...)) は往復する', () => {
    const cases: Array<[string | null, string | null, string | null]> = [
      [null, null, null],
      ['', null, null],
      ['mychannel', null, null],
      ['mychannel', 'jobs', 'abc'],
      ['世界史の裏路地', 'episodes', 'ep 010'],
    ];
    for (const [dir, tab, item] of cases) {
      expect(parseHash(hashFor(dir, tab, item))).toEqual({ dir, tab, item });
    }
  });

  it('hashFor: dir="" + tab=jobs はルートジョブのhashになる', () => {
    expect(hashFor('', 'jobs', 'abc-123')).toBe('#/root/jobs/abc-123');
    expect(hashFor('', 'jobs', null)).toBe('#/root/jobs');
    expect(hashFor('', null, null)).toBe('#/root');
  });
});
