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
} from '../progress';
import { OPERATIONS } from '../operations';

const RAIL = OPERATIONS['video-create']!.stages; // 調査/台本/音声/絵コンテ/素材/実装/検査/レビュー/公開準備/承認/レンダー

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
});
