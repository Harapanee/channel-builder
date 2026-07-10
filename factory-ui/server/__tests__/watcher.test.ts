import { describe, it, expect } from 'vitest';
import { classify } from '../watcher';

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

  it('assets/・episodes/・scratchpad_gen/ 配下の画像は kind:images', () => {
    expect(classify('youtubebuilder/assets/characters/x/base.png')).toEqual({
      dir: 'youtubebuilder',
      kind: 'images',
    });
    expect(classify('動物転生/scratchpad_gen/variants/v1.webp')).toEqual({
      dir: '動物転生',
      kind: 'images',
    });
    expect(classify('youtubebuilder/episodes/ep001-x/thumb.JPG')).toEqual({
      dir: 'youtubebuilder',
      kind: 'images',
    });
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
});
