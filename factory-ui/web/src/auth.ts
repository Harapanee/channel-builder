/**
 * factory-ui サーバーへのアクセストークン(server/auth.ts が発行する `.auth-token`)を
 * localStorage に保持する。サーバー起動ログまたは `factory-ui/.auth-token` の中身を
 * ユーザーが一度入力すれば、以後はこのモジュール経由で全リクエストに自動添付される。
 */

const STORAGE_KEY = 'factory-ui-token';

/** 保存済みトークンを読む。未設定・localStorage不可の環境では null。 */
export function getToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** トークンを保存する。 */
export function setToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    /* プライベートモード等でlocalStorageが使えない場合は無視(再入力を促す挙動に落ちる) */
  }
}

/** トークンを消す(401受信時に呼ぶ)。 */
export function clearToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 無視 */
  }
}
