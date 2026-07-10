import { describe, it, expect } from 'vitest';
import { isLocalRequest } from '../guards';

describe('isLocalRequest — DNS rebinding / cross-origin drive-by ガード', () => {
  it('Host=127.0.0.1・Origin無し(curl/node等の非ブラウザ)は許可', () => {
    expect(isLocalRequest({ host: '127.0.0.1:4700' })).toBe(true);
  });

  it('Host=localhost:4700 も許可', () => {
    expect(isLocalRequest({ host: 'localhost:4700' })).toBe(true);
  });

  it('IPv6ループバック [::1] を許可', () => {
    expect(isLocalRequest({ host: '[::1]:4700' })).toBe(true);
  });

  it('同一オリジン(Origin=http://127.0.0.1:4700)を許可', () => {
    expect(isLocalRequest({ host: '127.0.0.1:4700', origin: 'http://127.0.0.1:4700' })).toBe(true);
  });

  it('vite dev(Origin=http://localhost:5173, Host=127.0.0.1:4700)を許可', () => {
    expect(isLocalRequest({ host: '127.0.0.1:4700', origin: 'http://localhost:5173' })).toBe(true);
  });

  it('クロスオリジンのドライブバイ(Origin=http://evil.com, 直IP Host)を拒否', () => {
    expect(isLocalRequest({ host: '127.0.0.1:4700', origin: 'http://evil.com' })).toBe(false);
  });

  it('DNS rebinding(Host=attacker.com:4700)を拒否', () => {
    expect(isLocalRequest({ host: 'attacker.com:4700' })).toBe(false);
  });

  it('Host欠落は拒否', () => {
    expect(isLocalRequest({})).toBe(false);
  });

  it('外部IPをHostに詐称しても拒否', () => {
    expect(isLocalRequest({ host: '10.0.0.5:4700' })).toBe(false);
  });

  it('パース不能なHostは拒否', () => {
    expect(isLocalRequest({ host: 'http://[bad' })).toBe(false);
  });

  it('Originのサブドメイン偽装(127.0.0.1.evil.com)を拒否', () => {
    expect(isLocalRequest({ host: '127.0.0.1:4700', origin: 'http://127.0.0.1.evil.com' })).toBe(false);
  });
});
