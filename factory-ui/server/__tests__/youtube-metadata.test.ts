import { describe, it, expect } from 'vitest';
import { validateMetadata } from '../youtube-metadata';

describe('validateMetadata', () => {
  const base = {
    title: 'テスト動画',
    description: '説明文',
    tags: ['タグ1', 'タグ2'],
    categoryId: '24',
  };

  it('最小構成を受理し privacyStatus は private が既定', () => {
    const m = validateMetadata(base);
    expect(m.title).toBe('テスト動画');
    expect(m.privacyStatus).toBe('private');
    expect(m.thumbnail).toBeUndefined();
  });

  it('全項目を受理する', () => {
    const m = validateMetadata({ ...base, privacyStatus: 'unlisted', thumbnail: 'publish/thumb.png' });
    expect(m.privacyStatus).toBe('unlisted');
    expect(m.thumbnail).toBe('publish/thumb.png');
  });

  it.each([
    [null, 'オブジェクト'],
    [{ ...base, title: '' }, 'title'],
    [{ ...base, title: 'x'.repeat(101) }, 'title'],       // YouTube上限100文字
    [{ ...base, description: undefined }, 'description'],
    [{ ...base, tags: 'not-array' }, 'tags'],
    [{ ...base, categoryId: 12 }, 'categoryId'],
    [{ ...base, privacyStatus: 'secret' }, 'privacyStatus'],
    [{ ...base, thumbnail: '../evil.png' }, 'thumbnail'], // トラバーサル拒否
    [{ ...base, thumbnail: '/abs/evil.png' }, 'thumbnail'],
  ])('不正入力 %j は invalid: を含むメッセージで throw', (raw, hint) => {
    expect(() => validateMetadata(raw)).toThrowError(new RegExp(`^invalid: .*${hint}`));
  });

  it('descriptionが5000文字超はthrow', () => {
    expect(() => validateMetadata({ ...base, description: 'x'.repeat(5001) })).toThrow(/^invalid: /);
  });

  it('aiDisclosure/productionNotes/publishAt を通し、publishAt+非privateを拒否する', () => {
    const base = { title: 't', description: 'd', tags: [], categoryId: '27' };
    expect(validateMetadata({ ...base, aiDisclosure: true, productionNotes: 'x', publishAt: '2026-07-20T09:00:00+09:00' }))
      .toMatchObject({ aiDisclosure: true, publishAt: '2026-07-20T09:00:00+09:00' });
    expect(() => validateMetadata({ ...base, publishAt: 'not-a-date' })).toThrow(/publishAt/);
    expect(() => validateMetadata({ ...base, publishAt: '2026-07-20T09:00:00Z', privacyStatus: 'public' })).toThrow(/publishAt/);
    expect(() => validateMetadata({ ...base, aiDisclosure: 'yes' })).toThrow(/aiDisclosure/);
  });
});
