import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** factory-ui/.auth-token を読み、無ければ生成して保存する(起動時に一度だけ呼ぶ)。 */
export function loadOrCreateToken(factoryUiDir: string): string {
  const p = path.join(factoryUiDir, '.auth-token');
  try {
    const t = fs.readFileSync(p, 'utf8').trim();
    if (t !== '') return t;
  } catch {
    /* 初回起動 */
  }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(p, token + '\n', { mode: 0o600 });
  return token;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * /api 配下の認証ミドルウェア(index.tsが装着。テストも同じ実体を使う)。
 * /health と /youtube/callback(Google認可リダイレクト着地点)は免除。
 *
 * 401には `WWW-Authenticate: Bearer realm="factory-ui"` を付ける。
 * これは「factory-ui自身のトークン不備」の機械可読な印で、フロントの handleUnauthorized は
 * この印がある401だけ clearToken+全画面ゲートを出す。ドメイン401(YouTubeの
 * needs_reauth / no_auth 等)にはこのヘッダが付かないため、パネル内のエラー表示に届く。
 */
export function createAuthMiddleware(token: string) {
  return (
    req: { path: string; headers: { authorization?: string }; url?: string },
    res: {
      set(field: string, value: string): unknown;
      status(code: number): { json(body: unknown): unknown };
    },
    next: () => void,
  ): void => {
    if (req.path === '/health' || req.path === '/youtube/callback') {
      next();
      return;
    }
    if (!isAuthorized(token, req)) {
      res.set('WWW-Authenticate', 'Bearer realm="factory-ui"');
      res.status(401).json({ error: 'unauthorized: トークンが必要です' });
      return;
    }
    next();
  };
}

/** Authorization: Bearer <token> または URLクエリ ?token= を検証する。 */
export function isAuthorized(
  token: string,
  req: { headers: { authorization?: string }; url?: string },
): boolean {
  const auth = req.headers.authorization;
  if (auth !== undefined && auth.startsWith('Bearer ') && safeEqual(auth.slice(7), token)) {
    return true;
  }
  try {
    const q = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('token');
    if (q !== null) return safeEqual(q, token);
  } catch {
    /* 不正URL */
  }
  return false;
}
