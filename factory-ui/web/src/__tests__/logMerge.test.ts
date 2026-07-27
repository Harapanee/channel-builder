import { describe, expect, it } from 'vitest';
import { mergeLogLines } from '../logMerge';

describe('mergeLogLines', () => {
  it('bufferedがfetchedと完全重複するとき、fetchedのみを返す', () => {
    const fetched = ['a', 'b', 'c'];
    const buffered = ['a', 'b', 'c'];
    expect(mergeLogLines(fetched, buffered)).toEqual(['a', 'b', 'c']);
  });

  it('部分重複(fetchedの末尾とbufferedの先頭が一致)のとき重複分を除いて連結する', () => {
    const fetched = ['a', 'b', 'c'];
    const buffered = ['b', 'c', 'd'];
    expect(mergeLogLines(fetched, buffered)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('重複なしのとき単純に連結する', () => {
    const fetched = ['a', 'b'];
    const buffered = ['c', 'd'];
    expect(mergeLogLines(fetched, buffered)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('fetchedが空のとき、bufferedのみを返す', () => {
    const buffered = ['x', 'y'];
    expect(mergeLogLines([], buffered)).toEqual(['x', 'y']);
  });

  it('bufferedが空のとき、fetchedのみを返す', () => {
    const fetched = ['x', 'y'];
    expect(mergeLogLines(fetched, [])).toEqual(['x', 'y']);
  });

  it('両方空のとき空配列を返す', () => {
    expect(mergeLogLines([], [])).toEqual([]);
  });
});
