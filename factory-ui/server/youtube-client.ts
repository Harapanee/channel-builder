import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * factory-ui/youtube-client.json(OAuthクライアントシークレット)のUI設置用管理。
 * 読み込み側(youtube-google.ts の loadYoutubeApi)はファイルを直接読むため、
 * ここは「検証して原文のまま保存する」ことに徹する。
 */

const MASK_LEN = 12;

function clientPath(root: string): string {
  return path.join(root, 'factory-ui', 'youtube-client.json');
}

/**
 * Google Cloudのダウンロード形式({"installed":{...}} / {"web":{...}})を検証し、
 * client_id を返す。不正は `invalid: <理由>` を throw(ルート層で400)。
 * 初めての人が原因を特定できるよう、欠けているキーを名指しする。
 */
export function validateClientJson(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('invalid: JSONオブジェクトではありません。ダウンロードしたJSONの中身をそのまま貼り付けてください');
  }
  const o = raw as Record<string, unknown>;
  const inner = o.installed ?? o.web;
  if (typeof inner !== 'object' || inner === null) {
    throw new Error(
      'invalid: installed / web キーがありません。Google Cloud ConsoleからダウンロードしたOAuthクライアントのJSONか確認してください',
    );
  }
  const c = inner as Record<string, unknown>;
  if (typeof c.client_id !== 'string' || c.client_id === '') {
    throw new Error('invalid: client_id がありません(または空です)');
  }
  if (typeof c.client_secret !== 'string' || c.client_secret === '') {
    throw new Error(
      'invalid: client_secret がありません。「ウェブアプリケーション」型のOAuthクライアントか確認してください',
    );
  }
  return c.client_id;
}

/** 設置状態。clientId は先頭12文字+`…` にマスク(secretは絶対に出さない) */
export function getClientStatus(root: string): { configured: boolean; clientId?: string } {
  try {
    const raw = JSON.parse(fs.readFileSync(clientPath(root), 'utf8')) as unknown;
    const clientId = validateClientJson(raw);
    return { configured: true, clientId: clientId.slice(0, MASK_LEN) + '…' };
  } catch {
    // 不在・壊れ・不正は一律「未設置」(loadYoutubeApi が null を返すのと整合)
    return { configured: false };
  }
}

/** 検証してから原文のまま保存する(不正ならthrowし、ファイルは触らない) */
export async function saveClientJson(root: string, raw: unknown): Promise<void> {
  validateClientJson(raw);
  await fsp.writeFile(clientPath(root), JSON.stringify(raw, null, 2));
}

/** 冪等削除(未設置でも成功扱い) */
export async function deleteClientJson(root: string): Promise<void> {
  await fsp.rm(clientPath(root), { force: true });
}
