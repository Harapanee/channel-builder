import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../ringbuffer';

describe('RingBuffer', () => {
  it('pushした内容をreadで結合して返す', () => {
    const rb = new RingBuffer(1024);
    rb.push('hello ');
    rb.push('world');
    expect(rb.read()).toBe('hello world');
  });

  it('maxBytesを超えると古いチャンクから破棄される', () => {
    const rb = new RingBuffer(10);
    rb.push('aaaa');
    rb.push('bbbb');
    rb.push('cccc'); // 12バイト > 10 → 'aaaa' が落ちる
    expect(rb.read()).toBe('bbbbcccc');
    expect(rb.bytes).toBe(8);
  });

  it('単一チャンクが上限を超える場合はそのチャンクだけが残る', () => {
    const rb = new RingBuffer(4);
    rb.push('aa');
    rb.push('bbbbbb');
    expect(rb.read()).toBe('bbbbbb');
  });

  it('bytesはUTF-8のバイト数で数える(マルチバイト文字)', () => {
    const rb = new RingBuffer(1024);
    rb.push('あ'); // UTF-8で3バイト
    expect(rb.bytes).toBe(3);
  });

  it('空のときreadは空文字を返す', () => {
    const rb = new RingBuffer(8);
    expect(rb.read()).toBe('');
    expect(rb.bytes).toBe(0);
  });
});
