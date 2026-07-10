/**
 * PTYスクロールバック用のリングバッファ。チャンク単位で保持し、
 * 合計バイト数が上限を超えたら古いチャンクから破棄する。
 * 直近のチャンクは上限超過でも必ず1つは残す(全損を防ぐ)。
 */
export class RingBuffer {
  private chunks: string[] = [];
  private total = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: string): void {
    if (chunk === '') return;
    this.chunks.push(chunk);
    this.total += Buffer.byteLength(chunk);
    while (this.total > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.total -= Buffer.byteLength(dropped);
    }
  }

  read(): string {
    return this.chunks.join('');
  }

  get bytes(): number {
    return this.total;
  }
}
