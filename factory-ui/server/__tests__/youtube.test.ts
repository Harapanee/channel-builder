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
    fetchAnalytics: async () => ({ metrics: {}, retentionCurve: [] }),
    playlistHasVideo: async () => false,
    addToPlaylist: async () => {},
    listPlaylists: async () => [],
    listPublishTimes: async () => [],
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

  it('videoFileのstatが非ENOENTエラー(ENOTDIR)で失敗した場合はnot_found:に変換せずrethrowする(誤404防止)', async () => {
    const m = await connected();
    // out/ をディレクトリではなくファイルに置き換え、fsp.stat(out/final.mp4) が
    // ENOENTではなくENOTDIR(パス構成要素がディレクトリでない)で失敗する状況を作る(EACCES等の代役)。
    const outDir = path.join(root, 'ch-a', 'episodes', 'ep001', 'out');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.writeFileSync(outDir, 'out/ のはずがファイル');
    await expect(m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' }))
      .rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('同エピソードの実行中ジョブがあればduplicate:', async () => {
    const m = await connected({ upload: () => new Promise(() => {}) }); // 終わらない
    await m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' });
    await expect(m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' }))
      .rejects.toThrow(/^duplicate: /);
  });

  it('完了ジョブは永続化され、同じrootで新しいManagerを作ってもlist()に残る', async () => {
    const m = await connected();
    const done = waitStatus(m, 'done');
    await m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' });
    await done;

    const m2 = new YoutubeManager(root, () => makeFakeApi());
    const jobs = m2.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('done');
    expect(jobs[0].epId).toBe('ep001');
    expect(jobs[0].videoId).toBe('vid-123');
  });

  it('実行中(uploading)に再生成するとfailed(中断)扱いになる', async () => {
    const m = await connected({ upload: () => new Promise(() => {}) }); // 終わらない
    await m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' });

    const m2 = new YoutubeManager(root, () => makeFakeApi());
    const jobs = m2.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('failed');
    expect(jobs[0].error).toBe('サーバー再起動により中断されました');
    expect(jobs[0].finishedAt).toBeDefined();
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

describe('再生リスト追加', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
    makeEpisode(root);
    fs.writeFileSync(
      path.join(root, 'ch-a', 'channel', 'youtube-publish.json'),
      JSON.stringify({ playlists: { episode: ['PLmain'], short: ['PLshort'] } }),
    );
  });

  async function connected(api?: Partial<YoutubeApi>): Promise<YoutubeManager> {
    const m = new YoutubeManager(root, () => makeFakeApi(api));
    await m.handleCallback('code', 'ch-a');
    return m;
  }
  const resultOf = (sub = 'episodes/ep001') =>
    JSON.parse(fs.readFileSync(path.join(root, 'ch-a', sub, 'publish', 'upload-result.json'), 'utf8'));

  it('アップロード後に本編リストへ追加し、結果を upload-result に書く', async () => {
    const added: string[] = [];
    const m = await connected({ addToPlaylist: async (_t, pl) => { added.push(pl); } });
    const done = waitStatus(m, 'done');
    await m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' });
    const fin = await done;
    expect(fin.warnings).toBeUndefined();
    expect(added).toEqual(['PLmain']);
    expect(resultOf().playlists).toEqual([{ id: 'PLmain', status: 'added' }]);
  });

  it('追加に失敗しても動画は done のまま、failed と warnings を残す', async () => {
    const m = await connected({ addToPlaylist: async () => { throw new Error('boom'); } });
    const done = waitStatus(m, 'done');
    await m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' });
    const fin = await done;
    expect(fin.warnings?.[0]).toMatch(/PLmain/);
    expect(resultOf().videoId).toBe('vid-123');
    expect(resultOf().playlists).toEqual([{ id: 'PLmain', status: 'failed', error: 'boom' }]);
  });

  it('addToPlaylists の再実行は、すでに入っていれば追加しない', async () => {
    let calls = 0;
    const m = await connected({ playlistHasVideo: async () => true, addToPlaylist: async () => { calls++; } });
    const done = waitStatus(m, 'done');
    await m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' });
    await done;
    expect(await m.addToPlaylists('ch-a', 'ep001')).toEqual([{ id: 'PLmain', status: 'already' }]);
    expect(calls).toBe(0);
    expect(resultOf().videoId).toBe('vid-123');
  });

  it('upload-result が無ければ addToPlaylists は not_found:', async () => {
    const m = await connected();
    await expect(m.addToPlaylists('ch-a', 'ep001')).rejects.toThrow(/^not_found: /);
  });

  it('ショートは short のリストへ入り、本編リストへは入らない', async () => {
    const sh = path.join(root, 'ch-a', 'shorts', 'sh001');
    fs.mkdirSync(path.join(sh, 'out'), { recursive: true });
    fs.mkdirSync(path.join(sh, 'publish'), { recursive: true });
    fs.writeFileSync(path.join(sh, 'out', 'final.mp4'), Buffer.alloc(16));
    fs.writeFileSync(
      path.join(sh, 'publish', 'metadata.json'),
      JSON.stringify({ title: 's', description: 'd', tags: [], categoryId: '24' }),
    );
    const added: string[] = [];
    const m = await connected({ addToPlaylist: async (_t, pl) => { added.push(pl); } });
    const done = waitStatus(m, 'done');
    await m.startUpload({ dir: 'ch-a', epId: 'sh001', videoFile: 'out/final.mp4', kind: 'short' });
    await done;
    expect(added).toEqual(['PLshort']);
    expect(resultOf('shorts/sh001').playlists).toEqual([{ id: 'PLshort', status: 'added' }]);
  });

  it('設定ファイルが無ければ再生リストに触れず done', async () => {
    fs.rmSync(path.join(root, 'ch-a', 'channel', 'youtube-publish.json'));
    let calls = 0;
    const m = await connected({ addToPlaylist: async () => { calls++; } });
    const done = waitStatus(m, 'done');
    await m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' });
    await done;
    expect(calls).toBe(0);
    expect(resultOf().playlists).toEqual([]);
  });
});

describe('公開枠の読み取り', () => {
  it('listPublishTimes は API の時刻をそのまま返す(未連携は no_auth:)', async () => {
    const root = makeRoot();
    const m = new YoutubeManager(root, () => makeFakeApi({ listPublishTimes: async () => ['2026-10-07T09:00:00Z'] }));
    await expect(m.listPublishTimes('ch-a')).rejects.toThrow(/^no_auth: /);
    await m.handleCallback('code', 'ch-a');
    expect(await m.listPublishTimes('ch-a')).toEqual(['2026-10-07T09:00:00Z']);
  });
});

describe('サムネ設定の失敗(最終レビュー C1)', () => {
  it('アップロード後にサムネ設定が落ちても upload-result を残し done+warnings、再実行は duplicate:', async () => {
    const root = makeRoot();
    makeEpisode(root);
    const m = new YoutubeManager(root, () => makeFakeApi({ setThumbnail: async () => { throw new Error('thumb 403'); } }));
    await m.handleCallback('code', 'ch-a');
    const done = waitStatus(m, 'done');
    await m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' });
    const fin = await done;
    expect(fin.warnings?.join()).toMatch(/thumb 403/);
    const result = JSON.parse(
      fs.readFileSync(path.join(root, 'ch-a', 'episodes', 'ep001', 'publish', 'upload-result.json'), 'utf8'),
    );
    expect(result.videoId).toBe('vid-123');
    expect(result.thumbnail).toBe('failed');
    await expect(m.startUpload({ dir: 'ch-a', epId: 'ep001', videoFile: 'out/final.mp4' })).rejects.toThrow(/^duplicate: /);
  });
});
