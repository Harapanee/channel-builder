/**
 * 過去ログ(fetch)とWS購読で先に届いた行(buffered)を重複なく連結する。
 * サーバーは「ファイル追記 → WS配信」の順なので、fetch中に届いたWS行は
 * fetch結果の末尾に含まれていることが多い。fetched の末尾と buffered の先頭の
 * 最長一致を除いて連結することで、取りこぼしも二重表示も防ぐ。
 * JobDetail.tsx から移設。
 */
export function mergeLogLines(fetched: string[], buffered: string[]): string[] {
  const max = Math.min(fetched.length, buffered.length);
  for (let k = max; k > 0; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (fetched[fetched.length - k + i] !== buffered[i]) {
        match = false;
        break;
      }
    }
    if (match) return [...fetched, ...buffered.slice(k)];
  }
  return [...fetched, ...buffered];
}
