import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanFactory, readChannel, isH3EpisodeSync, h3EpisodesOf } from '../scanner';

describe('scanner', () => {
  let root: string;

  async function mkChannel(name: string, system: Record<string, unknown>): Promise<string> {
    const d = path.join(root, name);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, '.channel-system.json'), JSON.stringify(system));
    return d;
  }

  beforeEach(async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'scanner-'));
    root = await fs.realpath(tmp);

    // --- 正常チャンネル chan-a(エピソード2件)---
    await mkChannel('chan-a', {
      projectType: 'channel-video-factory',
      channelId: 'id-a',
      channelName: 'Channel A',
      status: 'approved',
      systemVersion: '1.0.0',
      stage: 1,
      approvedEpisodes: ['ep001'],
    });

    // ep001: episode.json あり + 各種ファイルあり
    const ep1 = path.join(root, 'chan-a', 'episodes', 'ep001');
    await fs.mkdir(path.join(ep1, 'out'), { recursive: true });
    await fs.writeFile(
      path.join(ep1, 'episode.json'),
      JSON.stringify({ episodeId: 'ep001', subject: 'Subject One', status: 'final', targetDurationSec: 900 }),
    );
    await fs.writeFile(path.join(ep1, 'out', 'preview.mp4'), 'x');
    await fs.writeFile(path.join(ep1, 'out', 'final.mp4'), 'x');
    await fs.writeFile(path.join(ep1, 'script.md'), '# script');
    await fs.mkdir(path.join(ep1, 'review'), { recursive: true });
    await fs.writeFile(path.join(ep1, 'review', 'qa.json'), '{}');
    await fs.writeFile(path.join(ep1, 'review', 'compliance.md'), '# compliance');

    // ep002-nometa: episode.json 不在(フラグのみで含める)。script.md はある
    const ep2 = path.join(root, 'chan-a', 'episodes', 'ep002-nometa');
    await fs.mkdir(ep2, { recursive: true });
    await fs.writeFile(path.join(ep2, 'script.md'), '# just script');

    // --- 日本語名チャンネル(building)---
    await mkChannel('動物転生', {
      channelId: 'id-j',
      channelName: '動物に転生',
      status: 'building',
      systemVersion: '0.1.0',
      approvedEpisodes: [],
    });

    // --- chan-a のショート2件 + フォーマット ---
    const sh1 = path.join(root, 'chan-a', 'shorts', 'sh001-test');
    await fs.mkdir(path.join(sh1, 'out'), { recursive: true });
    await fs.writeFile(
      path.join(sh1, 'short.json'),
      JSON.stringify({ shortId: 'sh001-test', formatId: 'rank3', sourceEpisodeId: 'ep001', title: 'テストショート', status: 'implemented' }),
    );
    await fs.writeFile(path.join(sh1, 'script.md'), '# short script');
    await fs.mkdir(path.join(sh1, 'review'), { recursive: true });
    await fs.writeFile(path.join(sh1, 'review', 'qa-report.json'), '{}');

    // sh002-nometa: short.json 不在(フラグのみで含める)
    await fs.mkdir(path.join(root, 'chan-a', 'shorts', 'sh002-nometa'), { recursive: true });

    const fmts = path.join(root, 'chan-a', 'channel', 'short-formats');
    await fs.mkdir(fmts, { recursive: true });
    await fs.writeFile(path.join(fmts, 'rank3.json'), JSON.stringify({ formatId: 'rank3', name: 'TOP3', targetDurationSec: 55 }));
    await fs.writeFile(path.join(fmts, 'broken.json'), '{ not valid json ');
    await fs.writeFile(path.join(fmts, 'readme.md'), '# 教義(jsonではないので無視される)');

    // --- 壊れたJSONのチャンネル ---
    await fs.mkdir(path.join(root, 'chan-broken'), { recursive: true });
    await fs.writeFile(path.join(root, 'chan-broken', '.channel-system.json'), '{ not valid json ');

    // --- チャンネルでない直下ディレクトリ(除外されるべき)---
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs', 'readme.md'), '# docs');
    await fs.mkdir(path.join(root, 'factory-ui'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('.channel-system.jsonを持つ直下ディレクトリだけ列挙', async () => {
    const channels = await scanFactory(root);
    const dirs = channels.map((c) => c.dir);
    expect(dirs).toContain('chan-a');
    expect(dirs).toContain('動物転生');
    expect(dirs).not.toContain('docs');
    expect(dirs).not.toContain('factory-ui');

    const a = channels.find((c) => c.dir === 'chan-a')!;
    expect(a.channelId).toBe('id-a');
    expect(a.channelName).toBe('Channel A');
    expect(a.status).toBe('approved');
    expect(a.systemVersion).toBe('1.0.0');
    expect(a.stage).toBe(1);
    expect(a.approvedEpisodes).toEqual(['ep001']);
    expect(a.episodeCount).toBe(2);
  });

  it('壊れたJSONのチャンネルはスキップ', async () => {
    const channels = await scanFactory(root);
    expect(channels.map((c) => c.dir)).not.toContain('chan-broken');
  });

  it('日本語フォルダ名を扱える', async () => {
    const channels = await scanFactory(root);
    const j = channels.find((c) => c.dir === '動物転生');
    expect(j).toBeDefined();
    expect(j!.channelName).toBe('動物に転生');
    expect(j!.status).toBe('building');
    expect(j!.episodeCount).toBe(0);
  });

  it('readChannel: episode.jsonとファイル存在フラグを統合', async () => {
    const res = await readChannel(root, 'chan-a');
    expect(res).not.toBeNull();
    expect(res!.system.channelId).toBe('id-a');

    const eps = res!.episodes;
    expect(eps.map((e) => e.episodeId)).toEqual(['ep001', 'ep002-nometa']);

    const ep1 = eps.find((e) => e.episodeId === 'ep001')!;
    expect(ep1.subject).toBe('Subject One');
    expect(ep1.status).toBe('final');
    expect(ep1.targetDurationSec).toBe(900);
    expect(ep1.hasPreview).toBe(true);
    expect(ep1.hasFinal).toBe(true);
    expect(ep1.hasScript).toBe(true);
    expect(ep1.reviewFiles).toEqual(['compliance.md', 'qa.json']);

    const ep2 = eps.find((e) => e.episodeId === 'ep002-nometa')!;
    expect(ep2.subject).toBeUndefined();
    expect(ep2.status).toBeUndefined();
    expect(ep2.targetDurationSec).toBeUndefined();
    expect(ep2.hasScript).toBe(true);
    expect(ep2.hasPreview).toBe(false);
    expect(ep2.hasFinal).toBe(false);
    expect(ep2.reviewFiles).toEqual([]);
  });

  it('readChannel: 不在dirはnull', async () => {
    expect(await readChannel(root, 'no-such-channel')).toBeNull();
    // ディレクトリは在るが .channel-system.json が無い
    expect(await readChannel(root, 'docs')).toBeNull();
  });

  it('readChannel: セパレータ・..・空文字を含むdirはnull(HTTP層からの生値対策)', async () => {
    // ../ 側に実在する「チャンネル風」ディレクトリを用意しても読めないこと(情報開示経路を塞ぐ)
    const evil = await fs.mkdtemp(path.join(path.dirname(root), 'evil-chan-'));
    await fs.writeFile(path.join(evil, '.channel-system.json'), JSON.stringify({ channelId: 'evil' }));
    // ネストパス側にも実在する .channel-system.json を用意
    await fs.mkdir(path.join(root, 'nest', 'inner'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'nest', 'inner', '.channel-system.json'),
      JSON.stringify({ channelId: 'inner' }),
    );
    // root直下にも置く(dir='' で root 自身が読めないことの確認)
    await fs.writeFile(path.join(root, '.channel-system.json'), JSON.stringify({ channelId: 'root' }));
    try {
      expect(await readChannel(root, `../${path.basename(evil)}`)).toBeNull();
      expect(await readChannel(root, 'nest/inner')).toBeNull();
      expect(await readChannel(root, '')).toBeNull();
      expect(await readChannel(root, '.')).toBeNull();
      expect(await readChannel(root, '..')).toBeNull();
    } finally {
      await fs.rm(evil, { recursive: true, force: true });
    }
  });

  it('shorts を short.json から構築する(不在フォルダはフラグのみで含める)', async () => {
    const ch = await readChannel(root, 'chan-a');
    expect(ch!.shorts.map((s) => s.shortId)).toEqual(['sh001-test', 'sh002-nometa']);
    const sh = ch!.shorts[0]!;
    expect(sh.title).toBe('テストショート');
    expect(sh.formatId).toBe('rank3');
    expect(sh.sourceEpisodeId).toBe('ep001');
    expect(sh.status).toBe('implemented');
    expect(sh.hasScript).toBe(true);
    expect(sh.hasFinal).toBe(false);
    expect(sh.reviewFiles).toEqual(['qa-report.json']);
    expect(sh.stages.filter((s) => s.state === 'done')).toHaveLength(4);
    const nometa = ch!.shorts[1]!;
    expect(nometa.status).toBeUndefined();
    expect(nometa.hasScript).toBe(false);
  });

  it('shorts: hasMetadata は publish/metadata.json の有無を反映し、公開準備工程の完了に使われる', async () => {
    // sh003-published: Studio確認済み + publish/metadata.json あり → 公開準備まで完了(6工程)
    const sh3 = path.join(root, 'chan-a', 'shorts', 'sh003-published');
    await fs.mkdir(path.join(sh3, 'publish'), { recursive: true });
    await fs.writeFile(
      path.join(sh3, 'short.json'),
      JSON.stringify({ shortId: 'sh003-published', status: 'studio_checked' }),
    );
    await fs.writeFile(path.join(sh3, 'publish', 'metadata.json'), '{}');

    const ch = await readChannel(root, 'chan-a');

    // sh001-test は publish/metadata.json を持たない(既存フィクスチャ)
    const sh1 = ch!.shorts.find((s) => s.shortId === 'sh001-test')!;
    expect(sh1.hasMetadata).toBe(false);

    const sh3res = ch!.shorts.find((s) => s.shortId === 'sh003-published')!;
    expect(sh3res.hasMetadata).toBe(true);
    expect(sh3res.stages.filter((s) => s.state === 'done')).toHaveLength(6);
    expect(sh3res.stages.find((s) => s.label === '公開準備')?.state).toBe('done');
  });

  it('short-formats はパース可能な .json のみを返す', async () => {
    const ch = await readChannel(root, 'chan-a');
    expect(ch!.shortFormats).toEqual([{ formatId: 'rank3', name: 'TOP3', targetDurationSec: 55 }]);
  });

  it('shorts/ が無いチャンネルは空配列', async () => {
    const ch = await readChannel(root, '動物転生');
    expect(ch!.shorts).toEqual([]);
    expect(ch!.shortFormats).toEqual([]);
  });

  it('.channel-system.jsonが読めない非ENOENTエラー(EISDIR)はスキップせずrethrowする(誤404防止)', async () => {
    // ファイルであるべき .channel-system.json を実体ディレクトリにして、
    // fs.readFile が ENOENT ではない実エラー(EISDIR)を投げる状況を作る(EACCES等の一過性エラーの代役)。
    await fs.mkdir(path.join(root, 'chan-poison', '.channel-system.json'), { recursive: true });
    await expect(scanFactory(root)).rejects.toMatchObject({ code: 'EISDIR' });
  });
  // ---- H3 経路の回(.channel-system.json の h3Pipeline.episodes)----
  // H3 回は assemble の out/final.mp4 が最終物で、夜間レンダーに入ると composition.html 由来の
  // 古い実装で上書きされる。UI とキューが判定できるよう scanner が isH3 を持つ。
  describe('H3 経路の判定', () => {
    async function mkH3Channel(name: string, system: Record<string, unknown>): Promise<string> {
      const d = await mkChannel(name, system);
      for (const ep of ['ep017-cuckoo', 'ep008-old']) {
        await fs.mkdir(path.join(d, 'episodes', ep), { recursive: true });
        await fs.writeFile(path.join(d, 'episodes', ep, 'episode.json'), JSON.stringify({ episodeId: ep, status: 'render_ready' }));
      }
      return d;
    }

    it('readChannel: h3Pipeline.episodes に載る回だけ isH3=true', async () => {
      await mkH3Channel('chan-h3', { channelId: 'h3', h3Pipeline: { enabled: true, episodes: ['ep017-cuckoo'] } });
      const ch = await readChannel(root, 'chan-h3');
      const byId = Object.fromEntries(ch!.episodes.map((e) => [e.episodeId, e]));
      expect(byId['ep017-cuckoo'].isH3).toBe(true);
      expect(byId['ep008-old'].isH3).toBeFalsy();
    });

    it('readChannel: h3Pipeline が無い/壊れている既存チャンネルは全話 非H3(isH3 を付けない)', async () => {
      await mkH3Channel('chan-plain', { channelId: 'plain' });
      await mkH3Channel('chan-broken', { channelId: 'broken', h3Pipeline: { episodes: 'ep017-cuckoo' } });
      for (const dir of ['chan-plain', 'chan-broken']) {
        const ch = await readChannel(root, dir);
        expect(ch!.episodes.every((e) => e.isH3 === undefined)).toBe(true);
      }
    });

    it('isH3EpisodeSync: 載っていれば true、キー無し・JSON 破損・ファイル不在は false(throw しない)', async () => {
      const d = await mkH3Channel('chan-h3s', { h3Pipeline: { episodes: ['ep017-cuckoo'] } });
      expect(isH3EpisodeSync(d, 'ep017-cuckoo')).toBe(true);
      expect(isH3EpisodeSync(d, 'ep008-old')).toBe(false);
      const plain = await mkChannel('chan-nokey', { channelId: 'x' });
      expect(isH3EpisodeSync(plain, 'ep017-cuckoo')).toBe(false);
      const broken = path.join(root, 'chan-badjson');
      await fs.mkdir(broken, { recursive: true });
      await fs.writeFile(path.join(broken, '.channel-system.json'), '{not json');
      expect(isH3EpisodeSync(broken, 'ep017-cuckoo')).toBe(false);
      expect(isH3EpisodeSync(path.join(root, 'no-such'), 'ep017-cuckoo')).toBe(false);
    });

    it('h3EpisodesOf: 文字列以外の要素は無視する', () => {
      expect([...h3EpisodesOf({ h3Pipeline: { episodes: ['a', 1, null, 'b'] } })]).toEqual(['a', 'b']);
      expect(h3EpisodesOf({}).size).toBe(0);
      expect(h3EpisodesOf({ h3Pipeline: null }).size).toBe(0);
    });
  });
});
