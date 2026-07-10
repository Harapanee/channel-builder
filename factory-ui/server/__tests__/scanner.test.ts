import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanFactory, readChannel } from '../scanner';

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
});
