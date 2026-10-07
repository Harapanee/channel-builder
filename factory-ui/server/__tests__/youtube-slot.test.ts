import { describe, it, expect } from 'vitest';
import { nextFreeSlot } from '../youtube-slot';

const opts = { hourJst: 18, minLeadHours: 2 };
const iso = (d: Date) => d.toISOString();

describe('nextFreeSlot', () => {
  it('今日の18時が空いていて間に合えば今日', () => {
    const now = new Date('2026-10-07T11:50:00+09:00');
    const occ = ['2026-10-06T18:00:31+09:00'];
    expect(iso(nextFreeSlot(occ, now, opts))).toBe(iso(new Date('2026-10-07T18:00:00+09:00')));
  });
  it('埋まっている日は飛ばす(予約済み・公開済みの両方)', () => {
    const now = new Date('2026-10-07T11:50:00+09:00');
    const occ = ['2026-10-07T18:00:00+09:00', '2026-10-08T18:00:00+09:00'];
    expect(iso(nextFreeSlot(occ, now, opts))).toBe(iso(new Date('2026-10-09T18:00:00+09:00')));
  });
  it('今日の枠まで猶予が足りなければ翌日', () => {
    const now = new Date('2026-10-07T16:30:00+09:00');
    expect(iso(nextFreeSlot([], now, opts))).toBe(iso(new Date('2026-10-08T18:00:00+09:00')));
  });
  it('同じ日の別時刻の公開もその日を埋める(JST の日付で判定)', () => {
    const now = new Date('2026-10-07T08:00:00+09:00');
    const occ = ['2026-10-07T01:00:00Z']; // = 10:00 JST
    expect(iso(nextFreeSlot(occ, now, opts))).toBe(iso(new Date('2026-10-08T18:00:00+09:00')));
  });
  it('UTC では前日でも JST で翌日になる時刻を正しく扱う', () => {
    const now = new Date('2026-10-07T23:30:00+09:00'); // UTC 14:30
    expect(iso(nextFreeSlot([], now, opts))).toBe(iso(new Date('2026-10-08T18:00:00+09:00')));
  });
  it('途中の穴を先に埋める(連続性を優先)', () => {
    const now = new Date('2026-10-07T09:00:00+09:00');
    const occ = ['2026-10-07T18:00:00+09:00', '2026-10-09T18:00:00+09:00'];
    expect(iso(nextFreeSlot(occ, now, opts))).toBe(iso(new Date('2026-10-08T18:00:00+09:00')));
  });
});
