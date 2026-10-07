import { describe, it, expect } from 'vitest';
import { checkAutoPublish } from '../youtube-publish-guard';
import type { YoutubeMetadata } from '../../shared/types';

const base: YoutubeMetadata = { title: 't', description: 'd', tags: [], categoryId: '27', privacyStatus: 'private' };
const now = new Date('2026-10-07T00:00:00+09:00');

describe('checkAutoPublish', () => {
  it('private + 24時間以上先の publishAt は通す', () => {
    expect(checkAutoPublish({ ...base, publishAt: '2026-10-08T00:00:00+09:00' }, now, 24)).toEqual([]);
  });
  it('publishAt が無ければ止める', () => {
    expect(checkAutoPublish(base, now, 24)[0]).toMatch(/publishAt/);
  });
  it('近すぎる publishAt は止める', () => {
    expect(checkAutoPublish({ ...base, publishAt: '2026-10-07T23:00:00+09:00' }, now, 24)[0]).toMatch(/24時間/);
  });
  it('過去の publishAt は止める', () => {
    expect(checkAutoPublish({ ...base, publishAt: '2026-10-01T00:00:00+09:00' }, now, 24)).not.toEqual([]);
  });
  it('public / unlisted は止める', () => {
    expect(checkAutoPublish({ ...base, privacyStatus: 'public' }, now, 24).join()).toMatch(/private/);
    expect(checkAutoPublish({ ...base, privacyStatus: 'unlisted' }, now, 24).join()).toMatch(/private/);
  });
});
