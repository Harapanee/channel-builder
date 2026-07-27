/**
 * claude CLI の stream-json 行は timestamp が null のまま出力される。
 * 工程別の所要時間計測のため、永続化時に壁時計時刻(epoch ms)を注入する。
 * JSONでない行・既に時刻を持つ行はそのまま返す。
 */
export function stampLogLine(line: string, now: number): string {
  try {
    const obj = JSON.parse(line) as Record<string, unknown> | null;
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return line;
    if (obj.timestamp !== null && obj.timestamp !== undefined) return line;
    obj.timestamp = now;
    return JSON.stringify(obj);
  } catch {
    return line;
  }
}
