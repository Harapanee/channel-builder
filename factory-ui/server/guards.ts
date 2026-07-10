/**
 * ローカルUI用のリクエスト・ガード。127.0.0.1バインドは「他ホストからの接続」しか防がず、
 * 悪意あるWebページからのブラウザ経由攻撃(DNS rebinding / クロスオリジンのドライブバイ)は防げない。
 * WebSocketはCORS対象外・fetchのno-corsも到達するため、Host と Origin のホスト名を検証して
 * claude PTYの入力口が第三者ページから開かれるのを防ぐ。
 */

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Host(`host:port`)または Origin(`scheme://host:port`)からホスト名を取り出す。不正はnull */
function hostnameOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = value.includes('://') ? new URL(value) : new URL(`http://${value}`);
    return url.hostname;
  } catch {
    return null;
  }
}

function isLocalHostname(hostname: string | null): boolean {
  return hostname !== null && ALLOWED_HOSTNAMES.has(hostname);
}

/**
 * リクエストがローカル発と信頼できるか。
 * - Host のホスト名がループバックであること(DNS rebinding 対策。Host は HTTP/1.1 で常に存在)
 * - Origin が存在する場合はそのホスト名もループバックであること(クロスオリジンのドライブバイ対策)
 * 非ブラウザクライアント(curl/node等)は Origin を送らないため、正しい Host さえあれば許可される。
 */
export function isLocalRequest(headers: { host?: string; origin?: string }): boolean {
  if (!isLocalHostname(hostnameOf(headers.host))) return false;
  if (headers.origin !== undefined && !isLocalHostname(hostnameOf(headers.origin))) return false;
  return true;
}
