import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JobStage } from '../../shared/types';
import {
  videoCreateDoneCount,
  buildVideoCreateStages,
  advanceStages,
  findEpisodeProgress,
  buildShortStages,
  shortCreateDoneCount,
  findShortIdForJob,
  _clearProgressCache,
} from '../progress';
import { OPERATIONS } from '../operations';

const RAIL = OPERATIONS['video-create']!.stages; // 調査/台本/音声/絵コンテ/素材/実装/検査/レビュー/公開準備/承認/レンダー

// findEpisodeProgress/findShortIdForJob はモジュール内キャッシュ(TTL 2000ms、キーは dir+episodeId/title,
// rootを含まない)を持つ。異なるmkdtempルートでも同じ dir='ch1' やepisodeId/argを使い回すテストが多いため、
// テストをまたいで古い値を見ないよう毎回空にする
beforeEach(() => {
  _clearProgressCache();
});

function mkStages(doneCount: number): JobStage[] {
  return RAIL.map((label, i) => ({
    key: `s${i}`,
    label,
    state: i < doneCount ? 'done' : i === doneCount ? 'active' : 'pending',
  }));
}

describe('videoCreateDoneCount', () => {
  it('episode.json の status を工程完了数に写す', () => {
    expect(videoCreateDoneCount({})).toBe(0);
    expect(videoCreateDoneCount({ status: 'researched' })).toBe(1);
    expect(videoCreateDoneCount({ status: 'scripted' })).toBe(2);
    expect(videoCreateDoneCount({ status: 'voiced' })).toBe(3);
    expect(videoCreateDoneCount({ status: 'storyboarded' })).toBe(4);
    expect(videoCreateDoneCount({ status: 'implemented' })).toBe(6); // 素材+実装まで完了
    expect(videoCreateDoneCount({ status: 'prechecked' })).toBe(7);
    expect(videoCreateDoneCount({ status: 'qa_passed' })).toBe(7); // 旧フロー互換(検査済相当)
    expect(videoCreateDoneCount({ status: 'reviewed' })).toBe(8);
    expect(videoCreateDoneCount({ status: 'packaged' })).toBe(9);
    expect(videoCreateDoneCount({ status: 'render_ready' })).toBe(10);
    expect(videoCreateDoneCount({ status: 'final' })).toBe(11);
    expect(videoCreateDoneCount({ status: 'unknown-status' })).toBe(0);
  });

  it('成果物フォールバック: preview(旧フロー)=レビューまで完了 / final=全完了', () => {
    expect(videoCreateDoneCount({ status: 'scripted', hasPreview: true })).toBe(8);
    expect(videoCreateDoneCount({ status: 'scripted', hasFinal: true })).toBe(11);
    expect(videoCreateDoneCount({ status: 'render_ready', hasPreview: true })).toBe(10); // 前進のみ
  });
});

describe('buildVideoCreateStages', () => {
  it('implemented なら 検査 が active になる', () => {
    const stages = buildVideoCreateStages({ status: 'implemented' });
    expect(stages.find((s) => s.state === 'active')?.label).toBe('検査');
    expect(stages.filter((s) => s.state === 'done')).toHaveLength(6);
  });
  it('render_ready なら レンダー が active(夜間キュー待ち)', () => {
    const stages = buildVideoCreateStages({ status: 'render_ready' });
    expect(stages.find((s) => s.state === 'active')?.label).toBe('レンダー');
    expect(stages.filter((s) => s.state === 'done')).toHaveLength(10);
  });
  it('final なら active は無く全て done', () => {
    const stages = buildVideoCreateStages({ status: 'final' });
    expect(stages.every((s) => s.state === 'done')).toBe(true);
  });
});

describe('advanceStages', () => {
  it('前進のみ: doneCount が現状以下なら元の配列をそのまま返す', () => {
    const cur = mkStages(5);
    expect(advanceStages(cur, 3)).toBe(cur);
    expect(advanceStages(cur, 5)).toBe(cur);
  });
  it('現状より先なら該当工程まで前進した複製を返す(非破壊)', () => {
    const cur = mkStages(0); // 調査active(クレオパトラで実際に起きた形)
    const out = advanceStages(cur, 6);
    expect(out).not.toBe(cur);
    expect(out.find((s) => s.state === 'active')?.label).toBe('検査');
    expect(cur.find((s) => s.state === 'active')?.label).toBe('調査'); // 元は不変
  });
  it('全工程完了なら active を作らない', () => {
    const out = advanceStages(mkStages(0), RAIL.length);
    expect(out.every((s) => s.state === 'done')).toBe(true);
  });
});

describe('findEpisodeProgress', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-progress-'));
    const ep = path.join(root, 'ch1', 'episodes', 'ep010-cleopatra');
    fs.mkdirSync(ep, { recursive: true });
    fs.writeFileSync(
      path.join(ep, 'episode.json'),
      JSON.stringify({ episodeId: 'ep010-cleopatra', subject: 'クレオパトラ', status: 'implemented' }),
    );
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('request.episodeId 指定でそのエピソードを読む', () => {
    const got = findEpisodeProgress(root, 'ch1', { arg: '', episodeId: 'ep010-cleopatra' }, '別題');
    expect(got?.status).toBe('implemented');
  });

  it('episodeId 無しなら subject === ジョブタイトルの最新エピソードを探す', () => {
    const got = findEpisodeProgress(root, 'ch1', { arg: 'クレオパトラ' }, 'クレオパトラ');
    expect(got?.episodeId).toBe('ep010-cleopatra');
    expect(got?.status).toBe('implemented');
  });

  it('同一題材が複数あれば episodeId 最大(最新)を採る', () => {
    const ep2 = path.join(root, 'ch1', 'episodes', 'ep011-cleopatra-retake');
    fs.mkdirSync(ep2, { recursive: true });
    fs.writeFileSync(
      path.join(ep2, 'episode.json'),
      JSON.stringify({ subject: 'クレオパトラ', status: 'scripted' }),
    );
    const got = findEpisodeProgress(root, 'ch1', { arg: '' }, 'クレオパトラ');
    expect(got?.episodeId).toBe('ep011-cleopatra-retake');
  });

  it('一致なし・ルート外パス風のdirは null', () => {
    expect(findEpisodeProgress(root, 'ch1', { arg: '' }, '存在しない題材')).toBeNull();
    expect(findEpisodeProgress(root, '../etc', { arg: '' }, 'クレオパトラ')).toBeNull();
    expect(findEpisodeProgress(root, '', { arg: '' }, 'クレオパトラ')).toBeNull();
  });

  it('subject不一致でも、ジョブ開始以降に更新されたエピソードへフォールバックする(自由文の依頼)', () => {
    // 既存 ep010 はジョブ開始より前の更新にする
    const old = path.join(root, 'ch1', 'episodes', 'ep010-cleopatra', 'episode.json');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(old, past, past);
    const createdAt = Date.now() - 30_000;
    // ジョブ開始後に作られたエピソード(subjectは依頼文と一致しない)
    const ep2 = path.join(root, 'ch1', 'episodes', 'ep011-bed');
    fs.mkdirSync(ep2, { recursive: true });
    fs.writeFileSync(path.join(ep2, 'episode.json'), JSON.stringify({ subject: '中世のベッド', status: 'packaged' }));
    const got = findEpisodeProgress(root, 'ch1', { arg: 'ep010と同じテーマで短い版を作って' }, 'ep010と同じテーマで短い版を作って', createdAt);
    expect(got?.episodeId).toBe('ep011-bed');
  });

  it('フォールバックはジョブ開始より前のエピソードを拾わない', () => {
    const old = path.join(root, 'ch1', 'episodes', 'ep010-cleopatra', 'episode.json');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(old, past, past);
    expect(findEpisodeProgress(root, 'ch1', { arg: '' }, '存在しない題材', Date.now())).toBeNull();
  });
});

describe('ショート進捗(short-create レール)', () => {
  it('status → 完了工程数(未知statusと未指定は0、hasFinalで全完了)', () => {
    expect(shortCreateDoneCount({})).toBe(0);
    expect(shortCreateDoneCount({ status: 'scripted' })).toBe(1);
    expect(shortCreateDoneCount({ status: 'script_approved' })).toBe(2);
    expect(shortCreateDoneCount({ status: 'voiced' })).toBe(3);
    expect(shortCreateDoneCount({ status: 'implemented' })).toBe(4);
    expect(shortCreateDoneCount({ status: 'studio_checked' })).toBe(5);
    expect(shortCreateDoneCount({ status: 'queued' })).toBe(7);
    expect(shortCreateDoneCount({ status: 'rendered' })).toBe(8);
    expect(shortCreateDoneCount({ status: '謎の値' })).toBe(0);
    expect(shortCreateDoneCount({ status: 'scripted', hasFinal: true })).toBe(8);
  });

  it('公開準備工程は metadata.json の存在で完了とみなす(Studio確認済み以降のみ)', () => {
    // Studio確認済み(5) + metadata.json → 公開準備(6)まで完了
    expect(shortCreateDoneCount({ status: 'studio_checked', hasMetadata: true })).toBe(6);
    // 台本段階で先にmetadataを作っても、手前の工程を完了と偽らない
    expect(shortCreateDoneCount({ status: 'scripted', hasMetadata: true })).toBe(1);
    // 既存ショート(metadata無しでrendered)は従来どおり全完了
    expect(shortCreateDoneCount({ status: 'rendered' })).toBe(8);
  });

  it('short-publish 操作が登録されている', () => {
    expect(OPERATIONS['short-publish']!.buildCommand('sh001-x')).toBe('/short-publish sh001-x');
    expect(OPERATIONS['short-create']!.stages).toContain('公開準備');
  });

  it('buildShortStages は8工程レールを返す(done/active/pending)', () => {
    const stages = buildShortStages({ status: 'implemented' });
    expect(stages.map((s) => s.label)).toEqual([
      '台本',
      '承認',
      '音声',
      '実装',
      'Studio確認',
      '公開準備',
      'キュー投入',
      'レンダー',
    ]);
    expect(stages[3]!.state).toBe('done');
    expect(stages[4]!.state).toBe('active');
    expect(stages[5]!.state).toBe('pending');
  });
});

describe('findShortIdForJob', () => {
  let root: string;
  const write = (shortId: string, meta: Record<string, unknown>) => {
    const dir = path.join(root, 'ch1', 'shorts', shortId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'short.json'), JSON.stringify(meta));
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-progress-short-'));
    write('sh002-nobunaga-top3', { sourceEpisodeId: 'ep001-nobunaga', formatId: 'top3' });
    write('sh004-nobunaga-rank3', { sourceEpisodeId: 'ep001-nobunaga', formatId: 'rank3-reasons' });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('arg の epId+formatId に一致する short を返す(shortIdの命名は独立)', () => {
    expect(findShortIdForJob(root, 'ch1', 'ep001-nobunaga rank3-reasons')).toBe('sh004-nobunaga-rank3');
    expect(findShortIdForJob(root, 'ch1', 'ep001-nobunaga top3')).toBe('sh002-nobunaga-top3');
  });

  it('formatId 省略時は epId 一致の最新(shortId最大)を採る', () => {
    expect(findShortIdForJob(root, 'ch1', 'ep001-nobunaga')).toBe('sh004-nobunaga-rank3');
  });

  it('一致なし・arg欠落・不正dirは undefined', () => {
    expect(findShortIdForJob(root, 'ch1', 'ep999-none top3')).toBeUndefined();
    expect(findShortIdForJob(root, 'ch1', undefined)).toBeUndefined();
    expect(findShortIdForJob(root, '../etc', 'ep001-nobunaga top3')).toBeUndefined();
  });
});

// ---- Task 4: 同期I/Oの解消(進捗走査のTTLキャッシュ) ----

describe('findEpisodeProgress のTTLキャッシュ', () => {
  let root: string;
  const epDir = () => path.join(root, 'ch1', 'episodes', 'ep777-cache');
  const write = (status: string) => {
    fs.mkdirSync(epDir(), { recursive: true });
    fs.writeFileSync(
      path.join(epDir(), 'episode.json'),
      JSON.stringify({ episodeId: 'ep777-cache', subject: 'キャッシュ題材', status }),
    );
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-progress-cache-'));
    write('scripted');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('TTL(2000ms)内は再読込しない: ファイルを書き換えても直後の呼び出しは古い値を返す', () => {
    const first = findEpisodeProgress(root, 'ch1', { arg: '', episodeId: 'ep777-cache' }, 'x');
    expect(first?.status).toBe('scripted');
    write('implemented'); // ファイル側は更新される
    const second = findEpisodeProgress(root, 'ch1', { arg: '', episodeId: 'ep777-cache' }, 'x');
    expect(second?.status).toBe('scripted'); // TTL内はキャッシュ値のまま
  });

  it('_clearProgressCache 後は読み直す', () => {
    const first = findEpisodeProgress(root, 'ch1', { arg: '', episodeId: 'ep777-cache' }, 'x');
    expect(first?.status).toBe('scripted');
    write('implemented');
    _clearProgressCache();
    const second = findEpisodeProgress(root, 'ch1', { arg: '', episodeId: 'ep777-cache' }, 'x');
    expect(second?.status).toBe('implemented');
  });
});

describe('findShortIdForJob のTTLキャッシュ', () => {
  let root: string;
  const write = (shortId: string, meta: Record<string, unknown>) => {
    const dir = path.join(root, 'ch1', 'shorts', shortId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'short.json'), JSON.stringify(meta));
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-progress-cache-short-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('TTL内は再読込しない: 一致する新しいshortを追加しても直後の呼び出しは古い結果を返す', () => {
    write('sh777-a', { sourceEpisodeId: 'ep777', formatId: 'f1' });
    const first = findShortIdForJob(root, 'ch1', 'ep777 f1');
    expect(first).toBe('sh777-a');
    write('sh778-b', { sourceEpisodeId: 'ep777', formatId: 'f1' }); // 本来なら最新(shortId最大)に切り替わるはず
    const second = findShortIdForJob(root, 'ch1', 'ep777 f1');
    expect(second).toBe('sh777-a'); // TTL内はキャッシュ値のまま
    _clearProgressCache();
    const third = findShortIdForJob(root, 'ch1', 'ep777 f1');
    expect(third).toBe('sh778-b');
  });

  it('未解決(undefined)の結果もキャッシュされ、クリア後に読み直す', () => {
    const first = findShortIdForJob(root, 'ch1', 'ep999 none');
    expect(first).toBeUndefined();
    write('sh900-none', { sourceEpisodeId: 'ep999', formatId: 'none' });
    const second = findShortIdForJob(root, 'ch1', 'ep999 none');
    expect(second).toBeUndefined(); // TTL内はキャッシュ(未解決)のまま
    _clearProgressCache();
    const third = findShortIdForJob(root, 'ch1', 'ep999 none');
    expect(third).toBe('sh900-none');
  });
});
