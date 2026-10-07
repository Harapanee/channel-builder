import { describe, it, expect } from 'vitest';
import { applySlot } from '../youtube-slot';

const NOTICE = 'メンバーシップに加入すると、本編を一般公開の24時間前に見られます。';
const base = {
  title: 't',
  description: `要旨\n\n${NOTICE}\n\n#tag`,
  tags: [],
  categoryId: '27',
  privacyStatus: 'private',
  memberEarlyAccess: { hours: 24 },
};

describe('applySlot', () => {
  it('publishAt を枠の JST 表記で書き、24時間以上先ならメンバー先行を残す', () => {
    const r = applySlot(base, new Date('2026-10-09T18:00:00+09:00'), new Date('2026-10-07T12:00:00+09:00'));
    expect(r.meta.publishAt).toBe('2026-10-09T18:00:00+09:00');
    expect(r.meta.memberEarlyAccess).toEqual({ hours: 24 });
    expect(r.meta.description).toContain(NOTICE);
    expect(r.notes).toEqual([]);
  });
  it('先行時間が取れない枠ではメンバー先行と案内文を外し、理由を notes に出す', () => {
    const r = applySlot(base, new Date('2026-10-07T18:00:00+09:00'), new Date('2026-10-07T12:00:00+09:00'));
    expect(r.meta.memberEarlyAccess).toBeUndefined();
    expect(r.meta.description).toBe('要旨\n\n#tag');
    expect(r.notes[0]).toMatch(/メンバー先行/);
  });
  it('privacyStatus を private にそろえる', () => {
    const r = applySlot({ ...base, privacyStatus: 'public' }, new Date('2026-10-09T18:00:00+09:00'), new Date('2026-10-07T12:00:00+09:00'));
    expect(r.meta.privacyStatus).toBe('private');
  });
});
