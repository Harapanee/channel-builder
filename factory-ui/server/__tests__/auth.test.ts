import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { loadOrCreateToken, isAuthorized, createAuthMiddleware } from '../auth';

describe('loadOrCreateToken', () => {
  let dir: string;

  beforeEach(async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-token-'));
    dir = await fs.realpath(tmp);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('初回は .auth-token を生成して返す', () => {
    const token = loadOrCreateToken(dir);
    expect(token.length).toBeGreaterThan(20);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('生成したトークンを .auth-token に保存する', async () => {
    const token = loadOrCreateToken(dir);
    const saved = await fs.readFile(path.join(dir, '.auth-token'), 'utf8');
    expect(saved.trim()).toBe(token);
  });

  it('既存の .auth-token があれば再利用する(再起動でトークンが変わらない)', () => {
    const first = loadOrCreateToken(dir);
    const second = loadOrCreateToken(dir);
    expect(second).toBe(first);
  });

  it('空の .auth-token は無視して新規生成する', async () => {
    await fs.writeFile(path.join(dir, '.auth-token'), '');
    const token = loadOrCreateToken(dir);
    expect(token.length).toBeGreaterThan(20);
  });
});

describe('isAuthorized', () => {
  const token = 'my-secret-token-1234567890';

  it('正しいBearerヘッダで認可', () => {
    expect(isAuthorized(token, { headers: { authorization: `Bearer ${token}` } })).toBe(true);
  });

  it('誤ったBearerヘッダは拒否', () => {
    expect(isAuthorized(token, { headers: { authorization: 'Bearer wrong-token' } })).toBe(false);
  });

  it('長さが違うBearerトークンも拒否(timingSafeEqualの長さ不一致パス)', () => {
    expect(isAuthorized(token, { headers: { authorization: 'Bearer short' } })).toBe(false);
  });

  it('正しい?token=クエリで認可', () => {
    expect(isAuthorized(token, { headers: {}, url: `/api/factory?token=${token}` })).toBe(true);
  });

  it('誤った?token=クエリは拒否', () => {
    expect(isAuthorized(token, { headers: {}, url: '/api/factory?token=wrong' })).toBe(false);
  });

  it('ヘッダもクエリも無ければ拒否', () => {
    expect(isAuthorized(token, { headers: {}, url: '/api/factory' })).toBe(false);
  });

  it('不正なURLでも例外を投げず拒否', () => {
    expect(isAuthorized(token, { headers: {}, url: 'http://[bad' })).toBe(false);
  });

  it('url未指定でも例外を投げず拒否', () => {
    expect(isAuthorized(token, { headers: {} })).toBe(false);
  });
});

describe('express配線(index.tsと同じcreateAuthMiddlewareを使用)', () => {
  const token = 'wired-test-token-abcdef';

  function buildApp() {
    const app = express();
    app.use('/api', createAuthMiddleware(token));
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    app.get('/api/factory', (_req, res) => res.json({ name: 'test', channels: [] }));
    app.get('/api/youtube/callback', (_req, res) => res.status(400).json({ error: 'code missing' }));
    return app;
  }

  it('/api/health はトークンなしで200(免除)', async () => {
    const res = await request(buildApp()).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('/api/factory はトークンなしで401', async () => {
    const res = await request(buildApp()).get('/api/factory');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/トークン/);
  });

  it('認証ミドルウェアの401には WWW-Authenticate: Bearer realm="factory-ui" が付く(ドメイン401との区別)', async () => {
    const res = await request(buildApp()).get('/api/factory');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('realm="factory-ui"');
  });

  it('/api/factory はBearerヘッダで200', async () => {
    const res = await request(buildApp()).get('/api/factory').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('/api/factory は?token=クエリで200', async () => {
    const res = await request(buildApp()).get(`/api/factory?token=${token}`);
    expect(res.status).toBe(200);
  });

  it('/api/youtube/callback はトークンなしでも401にならない(免除)', async () => {
    const res = await request(buildApp()).get('/api/youtube/callback');
    expect(res.status).not.toBe(401);
  });
});
