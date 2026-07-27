/**
 * ログ行の時刻(左の桁)を解釈・整形する純関数。フィードと生ログの両方が使う。
 *
 * timestamp は3通りある:
 *  - number: サーバーが永続化時に注入した壁時計(epoch ms) — server/logstamp.ts
 *  - string: claude CLI 自身が付けた ISO8601(user行など。stampLogLineは上書きしない)
 *  - 無し  : スタンプ導入前に書かれた行・非JSON行 → undefined を返し、呼び出し側は桁を空ける
 */

/** timestamp フィールドの値を epoch ms に正規化する。解釈できなければ undefined */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/** 生のJSONL 1行から時刻を取り出す(生ログビュー用。既にパース済みなら parseTimestamp を直接使う) */
export function extractTime(line: string): number | undefined {
  let d: unknown;
  try {
    d = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return undefined;
  return parseTimestamp((d as Record<string, unknown>).timestamp);
}

/** epoch ms → HH:MM:SS(ローカル時刻・24時間・ゼロ埋め) */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
