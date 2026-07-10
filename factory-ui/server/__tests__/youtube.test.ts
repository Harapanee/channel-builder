import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { YoutubeManager, type YoutubeApi, type StoredToken } from '../youtube';
import type { YoutubeUploadJob } from '../../shared/types';
import { validateMetadata } from '../youtube-metadata';

/** テスト用ファクトリールート: <tmp>/<dir>/channel/ を持つ疑似チャンネルを作る */
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-test-'));
  fs.mkdirSync(path.join(root, 'ch-a', 'channel'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ch-a', '.channel-system.json'), '{}');
  return root;
}

function makeFakeApi(overrides: Partial<YoutubeApi> = {}): YoutubeApi {
  return {
    generateAuthUrl: (state) => `https://accounts.google.example/auth?state=${state}`,
    exchangeCode: async () => ({ refresh_token: 'rt-1', access_token: 'at-1' }),
    getChannelTitle: async () => 'テストチャンネル',
    upload: async () => 'vid-123',
    setThumbnail: async () => {},
    ...overrides,
  };
}

describe('YoutubeManager 認証', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });

  it('api未設定(クライアントシークレット無し)は connected:false / no_client', async () => {
    const m = new YoutubeManager(root, () => null);
    expect(await m.status('ch-a')).toEqual({ connected: false, reason: 'no_client' });
  });

  it('トークン未保存は no_token、authUrlはstate=dirを含む', async () => {
    const m = new YoutubeManager(root, () => makeFakeApi());
    expect(await m.status('ch-a')).toEqual({ connected: false, reason: 'no_token' });
    expect(m.authUrl('ch-a')).toContain('state=ch-a');
  });

  it('handleCallbackがトークンを保存し、statusがチャンネル名を返す', async () => {
    const m = new YoutubeManager(root, () => makeFakeApi());
    await m.handleCallback('code-1', 'ch-a');
    const tokenPath = path.join(root, 'ch-a', 'channel', 'youtube-oauth.json');
    expect(JSON.parse(fs.readFileSync(tokenPath, 'utf8')).refresh_token).toBe('rt-1');
    expect(await m.status('ch-a')).toEqual({ connected: true, channelTitle: 'テストチャンネル' });
  });

  it('トークン保存時にチャンネルの.gitignoreへ追記する(重複追記しない)', async () => {
    const gi = path.join(root, 'ch-a', '.gitignore');
    fs.writeFileSync(gi, 'node_modules/\n');
    const m = new YoutubeManager(root, () => makeFakeApi());
    await m.handleCallback('code-1', 'ch-a');
    await m.handleCallback('code-2', 'ch-a');
    const lines = fs.readFileSync(gi, 'utf8').split('\n').filter((l) => l === 'channel/youtube-oauth.json');
    expect(lines).toHaveLength(1);
  });

  it('getChannelTitleがinvalid_grantで落ちたら needs_reauth', async () => {
    const m = new YoutubeManager(root, () => makeFakeApi({
      getChannelTitle: async () => { throw new Error('invalid_grant: Token has been revoked'); },
    }));
    await m.handleCallback('code-1', 'ch-a');
    expect(await m.status('ch-a')).toEqual({ connected: false, reason: 'needs_reauth' });
  });

  it('getChannelTitleのリフレッシュ通知でトークンが更新保存される', async () => {
    const m = new YoutubeManager(root, () => makeFakeApi({
      getChannelTitle: async (_t: StoredToken, onToken) => {
        onToken({ refresh_token: 'rt-1', access_token: 'at-2' });
        return 'テストチャンネル';
      },
    }));
    await m.handleCallback('code-1', 'ch-a');
    await m.status('ch-a');
    const tokenPath = path.join(root, 'ch-a', 'channel', 'youtube-oauth.json');
    expect(JSON.parse(fs.readFileSync(tokenPath, 'utf8')).access_token).toBe('at-2');
  });

  it('不正dir(スラッシュ入り)は invalid: を throw', () => {
    const m = new YoutubeManager(root, () => makeFakeApi());
    expect(() => m.authUrl('../etc')).toThrow(/^invalid: /);
  });

  it('api未設定でauthUrlは no_auth: を throw', () => {
    const m = new YoutubeManager(root, () => null);
    expect(() => m.authUrl('ch-a')).toThrow(/^no_auth: /);
  });

  it('プロバイダがnull→apiに変わると再起動なしでstatusが変わる(ホットリロード)', async () => {
    let api: YoutubeApi | null = null;
    const m = new YoutubeManager(root, () => api);
    expect(await m.status('ch-a')).toEqual({ connected: false, reason: 'no_client' });
    api = makeFakeApi();
    await m.handleCallback('code-1', 'ch-a');
    expect(await m.status('ch-a')).toEqual({ connected: true, channelTitle: 'テストチャンネル' });
  });
});

/** ep001を持つ疑似エピソードを作る */
function makeEpisode(root: string, opts: { result?: boolean; meta?: object | 'broken' } = {}): void {
  const ep = path.join(root, 'ch-a', 'episodes', 'ep001');
  fs.mkdirSync(path.join(ep, 'out'), { recursive: true });
  fs.mkdirSync(path.join(ep, 'publish'), { recursive: true });
  fs.writeFileSync(path.join(ep, 'out', 'final.mp4'), Buffer.alloc(1024)); // 1KiBのダミー
  fs.writeFileSync(path.join(ep, 'publish', 'thumbnail.png'), Buffer.alloc(16));
  const meta = opts.meta ?? {
    title: 'ep001タイトル',
    description: '説明',
    tags: ['a'],
    categoryId: '24',
    thumbnail: 'publish/thumbnail.png',
  };
  fs.writeFileSync(
    path.join(ep, 'publish', 'metadata.json'),
    meta === 'broken' ? '{oops' : JSON.stringify(meta),
  );
  if (opts.result) {
    fs.writeFileSync(path.join(ep, 'publish', 'upload-result.json'), JSON.stringify({ videoId: 'old' }));
  }
}

/** 'update' イベントで指定statusになるまで待つ */
function waitStatus(m: YoutubeManager, want: string): Promise<YoutubeUploadJob> {
  return new Promise((resolve) => {
    m.on('update', (job: YoutubeUploadJob) => {
      if (job.status === want) resolve(job);
    });
  });
}

describe('YoutubeManager アップロード', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
    makeEpisode(root);
  });

  async function connected(api?: Partial<YoutubeApi>): Promise<YoutubeManager> {
    const m = new YoutubeManager(root, () => makeFakeApi(api));
    await m.handleCallback('code', 'ch-a');
    return m;
  }

  it('listVideoFilesがout/のmp4をサイズ付きで返す', async () => {
    const m = await connected();
    expect(await m.listVideoFiles('ch-a', 'ep001')).toEqual([{ file: 'out/final.mp4', size: 1024 }]);
  });

  it('成功フロー: uploading→setting_thumbnail→done、upload-result.jsonが書かれる', async () => {
    let progressed = 0;
    const m = await connected({
      upload: async (p) => {
        p.onProgress(512);
        progressed = 512;
        expect(p.meta.title).toBe('ep001タイトル');
        expect(p.meta.privacyStatus).toBe('private');
        return 'vid-123';
      },
    });
    const done = waitStatus(m, 'done');
    const job = await m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' });
    expect(job.status).toBe('uploading');
    expect(job.bytesTotal).toBe(1024);
    const fin = await done;
    expect(progressed).toBe(512);
    expect(fin.videoId).toBe('vid-123');
    expect(fin.url).toBe('https://www.youtube.com/watch?v=vid-123');
    const result = JSON.parse(
      fs.readFileSync(path.join(root, 'ch-a', 'episodes', 'ep001', 'publish', 'upload-result.json'), 'utf8'),
    );
    expect(result.videoId).toBe('vid-123');
    expect(result.privacyStatus).toBe('private');
  });

  it('thumbnail未指定ならsetThumbnailを呼ばずdone', async () => {
    const ep = path.join(root, 'ch-a', 'episodes', 'ep001', 'publish', 'metadata.json');
    const meta = JSON.parse(fs.readFileSync(ep, 'utf8'));
    delete meta.thumbnail;
    fs.writeFileSync(ep, JSON.stringify(meta));
    let thumbCalled = false;
    const m = await connected({ setThumbnail: async () => { thumbCalled = true; } });
    const done = waitStatus(m, 'done');
    await m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' });
    await done;
    expect(thumbCalled).toBe(false);
  });

  it('API失敗はfailedになりerrorを持つ', async () => {
    const m = await connected({ upload: async () => { throw new Error('quotaExceeded'); } });
    const failed = waitStatus(m, 'failed');
    await m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' });
    expect((await failed).error).toContain('quotaExceeded');
  });

  it('upload-result.jsonが既にあればduplicate:、force:trueで通る', async () => {
    makeEpisode(root, { result: true });
    const m = await connected();
    await expect(m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' }))
      .rejects.toThrow(/^duplicate: /);
    const done = waitStatus(m, 'done');
    await m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4', force: true });
    await done;
  });

  it('同一エピソードへの同時startUploadは片方だけ通りもう片方はduplicate:(TOCTOU防止)', async () => {
    let release!: (id: string) => void;
    const m = await connected({
      upload: () => new Promise<string>((resolve) => { release = resolve; }),
    });
    const results = await Promise.allSettled([
      m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' }),
      m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/duplicate: /);
    const done = waitStatus(m, 'done');
    release('vid-race');
    expect((await done).videoId).toBe('vid-race');
  });

  it('preflight失敗後は同エピソードへ再度startUploadできる(予約が解放される)', async () => {
    const m = await connected();
    await expect(m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/nope.mp4' }))
      .rejects.toThrow(/^not_found: /);
    const done = waitStatus(m, 'done');
    await m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' });
    await done;
  });

  it('同エピソードの実行中ジョブがあればduplicate:', async () => {
    const m = await connected({ upload: () => new Promise(() => {}) }); // 終わらない
    await m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' });
    await expect(m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' }))
      .rejects.toThrow(/^duplicate: /);
  });

  it('metadata.json不在/壊れ/動画不在/不正videoFile/未連携はそれぞれ規約のprefixでthrow', async () => {
    const m = await connected();
    fs.rmSync(path.join(root, 'ch-a', 'episodes', 'ep001', 'publish', 'metadata.json'));
    await expect(m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' }))
      .rejects.toThrow(/^not_found: /);

    makeEpisode(root, { meta: 'broken' });
    await expect(m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' }))
      .rejects.toThrow(/^invalid: /);

    makeEpisode(root);
    await expect(m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/nope.mp4' }))
      .rejects.toThrow(/^not_found: /);
    await expect(m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: '../secret.mp4' }))
      .rejects.toThrow(/^invalid: /);
    await expect(m.startUpload({ dir: 'ch-a', epId: 'bad/ep', videoFile: 'out/final.mp4' }))
      .rejects.toThrow(/^invalid: /);

    // トークンを削除して未連携状態をシミュレート
    fs.rmSync(path.join(root, 'ch-a', 'channel', 'youtube-oauth.json'));
    const noAuth = new YoutubeManager(root, () => makeFakeApi());
    await expect(noAuth.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' }))
      .rejects.toThrow(/^no_auth: /);
  });
});
