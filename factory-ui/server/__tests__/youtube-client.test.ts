import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  validateClientJson,
  getClientStatus,
  saveClientJson,
  deleteClientJson,
} from '../youtube-client';

const VALID = { installed: { client_id: '123456789012-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-xyz' } };

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ytc-'));
  fs.mkdirSync(path.join(root, 'factory-ui'), { recursive: true });
  return root;
}

describe('validateClientJson', () => {
  it('installed形式とweb形式を受理しclient_idを返す', () => {
    expect(validateClientJson(VALID)).toBe(VALID.installed.client_id);
    expect(validateClientJson({ web: VALID.installed })).toBe(VALID.installed.client_id);
  });

  it.each([
    [null, 'JSON'],
    ['string', 'JSON'],
    [{}, 'installed'],                                             // installed/web欠落
    [{ installed: { client_id: 'x' } }, 'client_secret'],          // secret欠落
    [{ web: { client_secret: 'y' } }, 'client_id'],                // id欠落
    [{ installed: { client_id: '', client_secret: 'y' } }, 'client_id'], // 空文字
  ])('不正入力は invalid: と原因語を含めて throw(%#)', (raw, hint) => {
    expect(() => validateClientJson(raw)).toThrowError(new RegExp(`^invalid: .*${hint}`));
  });
});

describe('保存・状態・削除', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });

  it('未設置は configured:false、保存後はマスク済みclientIdを返す', async () => {
    expect(getClientStatus(root)).toEqual({ configured: false });
    await saveClientJson(root, VALID);
    expect(getClientStatus(root)).toEqual({ configured: true, clientId: '123456789012…' });
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'factory-ui', 'youtube-client.json'), 'utf8'));
    expect(onDisk).toEqual(VALID); // 中身は原文のまま保存(loadYoutubeApiがそのまま読める)
  });

  it('不正JSONの保存はthrowしファイルを作らない', async () => {
    await expect(saveClientJson(root, {})).rejects.toThrow(/^invalid: /);
    expect(getClientStatus(root).configured).toBe(false);
  });

  it('削除は冪等(未設置でも例外なし)', async () => {
    await saveClientJson(root, VALID);
    await deleteClientJson(root);
    expect(getClientStatus(root).configured).toBe(false);
    await deleteClientJson(root); // 2回目も例外なし
  });

  it('壊れたファイルが置かれていても configured:false(loadYoutubeApiのnull挙動と整合)', () => {
    fs.writeFileSync(path.join(root, 'factory-ui', 'youtube-client.json'), '{oops');
    expect(getClientStatus(root)).toEqual({ configured: false });
  });
});
