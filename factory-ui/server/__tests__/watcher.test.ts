import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { classify, makeIgnored } from '../watcher';

describe('classify(相対パス→fs-update分類)', () => {
  it('.channel-system.json は kind:system', () => {
    expect(classify('youtubebuilder/.channel-system.json')).toEqual({
      dir: 'youtubebuilder',
      kind: 'system',
    });
  });

  it('episodes/*/episode.json は kind:episode', () => {
    expect(classify('動物転生/episodes/ep001-x/episode.json')).toEqual({
      dir: '動物転生',
      kind: 'episode',
    });
  });

  it('episodes/*/out/*.mp4 は kind:media', () => {
    expect(classify('youtubebuilder/episodes/ep008-caesar/out/preview.mp4')).toEqual({
      dir: 'youtubebuilder',
      kind: 'media',
    });
  });

  it('episodes/*/review/ 配下は拡張子問わず kind:media', () => {
    expect(classify('youtubebuilder/episodes/ep008-caesar/review/compliance.md')).toEqual({
      dir: 'youtubebuilder',
      kind: 'media',
    });
    expect(classify('youtubebuilder/episodes/ep008-caesar/review/qa-report.json')).toEqual({
      dir: 'youtubebuilder',
      kind: 'media',
    });
  });

  it('画像はfd削減のため監視対象外(2026-07-16 fd枯渇対策)', () => {
    expect(classify('youtubebuilder/assets/characters/x/base.png')).toBeNull();
    expect(classify('動物転生/scratchpad_gen/variants/v1.webp')).toBeNull();
    expect(classify('youtubebuilder/episodes/ep001-x/thumb.JPG')).toBeNull();
  });

  it('episodes/*/out/ の一時ファイルやログは対象外', () => {
    expect(classify('youtubebuilder/episodes/ep008-caesar/out/render-preview.log')).toBeNull();
  });

  it('factory-ui・docs・隠しディレクトリ・ルート直下ファイルは対象外', () => {
    expect(classify('factory-ui/server/index.ts')).toBeNull();
    expect(classify('docs/superpowers/specs/x.md')).toBeNull();
    expect(classify('.factory.json')).toBeNull();
    expect(classify('CLAUDE.md')).toBeNull();
  });

  it('node_modules・.git を含むパスは対象外', () => {
    expect(classify('youtubebuilder/node_modules/pkg/img.png')).toBeNull();
    expect(classify('youtubebuilder/.git/objects/aa/bb')).toBeNull();
  });

  it('チャンネル直下のmp4や無関係ファイルは対象外', () => {
    expect(classify('youtubebuilder/render-queue/x.mp4')).toBeNull();
    expect(classify('youtubebuilder/package.json')).toBeNull();
  });

  it('shorts/ 配下を short / media に分類する', () => {
    expect(classify(path.join('ch1', 'shorts', 'sh001', 'short.json'))).toEqual({ dir: 'ch1', kind: 'short' });
    expect(classify(path.join('ch1', 'shorts', 'sh001', 'out', 'final.mp4'))).toEqual({ dir: 'ch1', kind: 'media' });
    expect(classify(path.join('ch1', 'shorts', 'sh001', 'review', 'qa.json'))).toEqual({ dir: 'ch1', kind: 'media' });
    expect(classify(path.join('ch1', 'shorts', 'sh001', 'script.md'))).toBeNull();
  });
});

describe('makeIgnored(chokidar ignored述語: classifyが拾わないファイルはfdを使わない)', () => {
  const root = '/factory';
  const ignored = makeIgnored(root);
  const file = { isDirectory: () => false } as import('node:fs').Stats;
  const dir = { isDirectory: () => true } as import('node:fs').Stats;

  it('従来のパス除外(node_modules/.git/factory-ui)はstats不要で即除外', () => {
    expect(ignored(`${root}/ch1/node_modules/pkg/a.js`, undefined)).toBe(true);
    expect(ignored(`${root}/ch1/.git/objects/aa`, undefined)).toBe(true);
    expect(ignored(`${root}/factory-ui/render-queue.json`, undefined)).toBe(true);
    expect(ignored(`${root}/factory-ui`, undefined)).toBe(true);
  });

  it('statsが無い段階では除外しない(ディレクトリ走査を止めない)', () => {
    expect(ignored(`${root}/ch1/episodes/ep001/audio/L05.wav`, undefined)).toBe(false);
  });

  it('ディレクトリは監視する(新規ファイル検出に必要)', () => {
    expect(ignored(`${root}/ch1/episodes/ep001/audio`, dir)).toBe(false);
    expect(ignored(root, dir)).toBe(false);
  });

  it('classifyが拾うファイルは監視する', () => {
    expect(ignored(`${root}/ch1/.channel-system.json`, file)).toBe(false);
    expect(ignored(`${root}/ch1/episodes/ep001/episode.json`, file)).toBe(false);
    expect(ignored(`${root}/ch1/shorts/sh001/short.json`, file)).toBe(false);
    expect(ignored(`${root}/ch1/episodes/ep001/out/preview.mp4`, file)).toBe(false);
    expect(ignored(`${root}/ch1/shorts/sh001/review/qa.json`, file)).toBe(false);
  });

  it('classifyが拾わないファイル(素材wav/md/画像等)は除外してfdを使わない', () => {
    expect(ignored(`${root}/ch1/episodes/ep001/audio/L05.wav`, file)).toBe(true);
    expect(ignored(`${root}/ch1/episodes/ep001/script.md`, file)).toBe(true);
    expect(ignored(`${root}/ch1/assets/characters/x/base.png`, file)).toBe(true);
    expect(ignored(`${root}/ch1/episodes/ep001/images/canonical.png`, file)).toBe(true);
    expect(ignored(`${root}/CLAUDE.md`, file)).toBe(true);
  });
});
