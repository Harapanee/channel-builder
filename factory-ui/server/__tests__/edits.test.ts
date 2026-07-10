import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { approveEpisode, curateLibraryEntry, readBible, writeBible } from '../edits';

// 対象チャンネル配下のみを、claude を介さずサーバーが直接編集する操作の TDD。
// フィクスチャは tmp に本物同型のチャンネルを1つ作る(chan-a)。
describe('edits', () => {
  let root: string;
  const CHAN = 'chan-a';

  function sysPath() {
    return path.join(root, CHAN, '.channel-system.json');
  }
  function libPath() {
    return path.join(root, CHAN, 'assets', 'library.json');
  }
  function biblePath() {
    return path.join(root, CHAN, 'channel', 'bible.md');
  }
  async function readJson(p: string): Promise<any> {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  }

  beforeEach(async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'edits-'));
    root = await fs.realpath(tmp);

    const chan = path.join(root, CHAN);
    await fs.mkdir(chan, { recursive: true });

    // .channel-system.json(approvedEpisodes と、保全すべき他キーを持つ)
    await fs.writeFile(
      sysPath(),
      JSON.stringify(
        {
          projectType: 'channel-video-factory',
          channelId: 'id-a',
          channelName: 'Channel A',
          status: 'building',
          systemVersion: '0.1.0',
          approvedEpisodes: ['ep001'],
          metrics: [],
        },
        null,
        2,
      ) + '\n',
    );

    // episodes/
    await fs.mkdir(path.join(chan, 'episodes', 'ep001'), { recursive: true });
    await fs.mkdir(path.join(chan, 'episodes', 'ep002'), { recursive: true });

    // assets/library.json(本物同型。approve/reject 対象を1件ずつ)
    await fs.mkdir(path.join(chan, 'assets'), { recursive: true });
    await fs.writeFile(
      libPath(),
      JSON.stringify(
        {
          assets: [
            {
              assetId: 'char_x_neutral',
              kind: 'character',
              subject: 'x',
              variant: 'neutral',
              file: 'characters/x/neutral.png',
              source: 'ai_image',
              license: 'generated',
              approvedBy: 'pending',
            },
            {
              assetId: 'char_y_neutral',
              kind: 'character',
              subject: 'y',
              variant: 'neutral',
              file: 'characters/y/neutral.png',
              source: 'ai_image',
              license: 'generated',
              approvedBy: 'pending',
            },
          ],
        },
        null,
        2,
      ) + '\n',
    );

    // channel/bible.md
    await fs.mkdir(path.join(chan, 'channel'), { recursive: true });
    await fs.writeFile(biblePath(), '# Bible OLD\n\n本文。\n');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // --- approveEpisode -------------------------------------------------------

  it('approveEpisode: approvedEpisodes に追加し、他キーを保全する', async () => {
    await approveEpisode(root, CHAN, 'ep002');
    const sys = await readJson(sysPath());
    expect(sys.approvedEpisodes).toContain('ep001');
    expect(sys.approvedEpisodes).toContain('ep002');
    // 他キー保全
    expect(sys.channelId).toBe('id-a');
    expect(sys.channelName).toBe('Channel A');
    expect(sys.status).toBe('building');
    expect(sys.systemVersion).toBe('0.1.0');
    expect(sys.projectType).toBe('channel-video-factory');
    expect(sys.metrics).toEqual([]);
  });

  it('approveEpisode: 重複は無視(2回承認しても1つ)', async () => {
    await approveEpisode(root, CHAN, 'ep002');
    await approveEpisode(root, CHAN, 'ep002');
    const sys = await readJson(sysPath());
    const occurrences = sys.approvedEpisodes.filter((e: string) => e === 'ep002');
    expect(occurrences).toHaveLength(1);
    // 既存の ep001 も1つのまま
    expect(sys.approvedEpisodes.filter((e: string) => e === 'ep001')).toHaveLength(1);
  });

  it('approveEpisode: 空 episodeId は throw', async () => {
    await expect(approveEpisode(root, CHAN, '')).rejects.toThrow();
  });

  it('approveEpisode: 不正 dir(../x / セパレータ / 空)は throw', async () => {
    await expect(approveEpisode(root, '../evil', 'ep001')).rejects.toThrow();
    await expect(approveEpisode(root, 'a/b', 'ep001')).rejects.toThrow();
    await expect(approveEpisode(root, '', 'ep001')).rejects.toThrow();
  });

  it('approveEpisode: 実在しないチャンネルは throw', async () => {
    await expect(approveEpisode(root, 'no-such', 'ep001')).rejects.toThrow();
  });

  // --- curateLibraryEntry ---------------------------------------------------

  it('curateLibraryEntry approve: 該当エントリに approvedBy:"human" を付与し他フィールド保全', async () => {
    await curateLibraryEntry(root, CHAN, 'char_x_neutral', 'approve');
    const lib = await readJson(libPath());
    const x = lib.assets.find((a: any) => a.assetId === 'char_x_neutral');
    expect(x.approvedBy).toBe('human');
    // 他フィールド保全
    expect(x.kind).toBe('character');
    expect(x.file).toBe('characters/x/neutral.png');
    expect(x.source).toBe('ai_image');
    // 他エントリは不変
    const y = lib.assets.find((a: any) => a.assetId === 'char_y_neutral');
    expect(y.approvedBy).toBe('pending');
  });

  it('curateLibraryEntry reject: 該当エントリを削除(残りはスキーマ妥当)', async () => {
    await curateLibraryEntry(root, CHAN, 'char_x_neutral', 'reject');
    const lib = await readJson(libPath());
    expect(lib.assets.find((a: any) => a.assetId === 'char_x_neutral')).toBeUndefined();
    // 他エントリは残る
    expect(lib.assets.find((a: any) => a.assetId === 'char_y_neutral')).toBeDefined();
    expect(lib.assets).toHaveLength(1);
  });

  it('curateLibraryEntry: 存在しない entryId は throw', async () => {
    await expect(curateLibraryEntry(root, CHAN, 'no_such_asset', 'approve')).rejects.toThrow();
  });

  it('curateLibraryEntry: library.json が不正スキーマ(assets が配列でない)は throw', async () => {
    await fs.writeFile(libPath(), JSON.stringify({ assets: { not: 'an array' } }) + '\n');
    await expect(curateLibraryEntry(root, CHAN, 'char_x_neutral', 'approve')).rejects.toThrow();
  });

  it('curateLibraryEntry: 不正 dir は throw', async () => {
    await expect(curateLibraryEntry(root, '../evil', 'char_x_neutral', 'approve')).rejects.toThrow();
  });

  // --- readBible / writeBible -----------------------------------------------

  it('readBible: bible.md の中身を返す', async () => {
    const content = await readBible(root, CHAN);
    expect(content).toBe('# Bible OLD\n\n本文。\n');
  });

  it('writeBible: 上書きし、書き込み前の内容を .bak に残す', async () => {
    await writeBible(root, CHAN, '# Bible NEW\n更新後。\n');
    expect(await fs.readFile(biblePath(), 'utf8')).toBe('# Bible NEW\n更新後。\n');
    expect(await fs.readFile(biblePath() + '.bak', 'utf8')).toBe('# Bible OLD\n\n本文。\n');
  });

  it('writeBible: 空文字は throw(bible.md は変更されない)', async () => {
    await expect(writeBible(root, CHAN, '')).rejects.toThrow();
    // 元の内容が保たれる
    expect(await fs.readFile(biblePath(), 'utf8')).toBe('# Bible OLD\n\n本文。\n');
  });

  it('writeBible: 空白のみも throw', async () => {
    await expect(writeBible(root, CHAN, '   \n\t')).rejects.toThrow();
  });

  it('writeBible: .bak 宛先が事前設置 symlink でも root 外へ書かない(symlink を実ファイルで置換)', async () => {
    const outsideTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'edits-outside-'));
    const outside = await fs.realpath(outsideTmp);
    const victim = path.join(outside, 'victim.txt');
    await fs.writeFile(victim, 'DO NOT TOUCH');
    // bible.md.bak を root 外の victim.txt を指す symlink として事前設置
    await fs.symlink(victim, biblePath() + '.bak');
    try {
      await writeBible(root, CHAN, '# Bible NEW\n更新後。\n');
      // root 外の victim は書き換わっていない(copyFile が宛先 symlink を辿らない)
      expect(await fs.readFile(victim, 'utf8')).toBe('DO NOT TOUCH');
      // .bak は通常ファイルに置換され、旧 bible 内容を持つ
      const bakStat = await fs.lstat(biblePath() + '.bak');
      expect(bakStat.isSymbolicLink()).toBe(false);
      expect(await fs.readFile(biblePath() + '.bak', 'utf8')).toBe('# Bible OLD\n\n本文。\n');
      // 本体も更新されている
      expect(await fs.readFile(biblePath(), 'utf8')).toBe('# Bible NEW\n更新後。\n');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('writeBible: サイズ上限超過は throw', async () => {
    const huge = 'a'.repeat(1024 * 1024 + 1); // 1MB + 1 byte
    await expect(writeBible(root, CHAN, huge)).rejects.toThrow();
    // 元の内容が保たれる
    expect(await fs.readFile(biblePath(), 'utf8')).toBe('# Bible OLD\n\n本文。\n');
  });

  it('writeBible: 不正 dir は throw', async () => {
    await expect(writeBible(root, '../evil', 'x')).rejects.toThrow();
    await expect(writeBible(root, 'a/b', 'x')).rejects.toThrow();
  });

  // --- pathguard 連携(.git 等・脱出は届かない) ------------------------------

  it('readBible: 実在しないチャンネルは throw', async () => {
    await expect(readBible(root, 'no-such')).rejects.toThrow();
  });
});
