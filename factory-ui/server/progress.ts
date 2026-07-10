import fs from 'node:fs';
import path from 'node:path';
import type { JobStage, JobRequest } from '../shared/types';
import { OPERATIONS } from './operations';

// video-create の工程レール(調査/台本/音声/絵コンテ/素材/実装/検査/レビュー/公開準備/承認/レンダー)
// に対する episode.json の status → 完了工程数。status は video-create スキルが各工程完了時に更新する
// 「中断・再開の基盤」であり、<stage>マーカーより信頼できる進捗の正とする。
// implemented は素材(index 4)と実装(index 5)の両方が済んだ状態(素材のみ完了のstatusは無い)。
// qa_passed は旧フロー(preview+QA)互換で検査済相当に写す。final は夜間レンダー成功時にサーバーが書く。
const STATUS_DONE_COUNT: Record<string, number> = {
  researched: 1,
  scripted: 2,
  voiced: 3,
  storyboarded: 4,
  implemented: 6,
  prechecked: 7,
  qa_passed: 7,
  reviewed: 8,
  packaged: 9,
  render_ready: 10,
  final: 11,
};

export type EpisodeProgressInput = {
  status?: string;
  hasPreview?: boolean;
  hasFinal?: boolean;
};

/** episode.json の status と成果物の有無から、video-create 工程レールの完了工程数を返す */
export function videoCreateDoneCount(input: EpisodeProgressInput): number {
  const total = OPERATIONS['video-create']!.stages.length;
  let done = input.status !== undefined ? (STATUS_DONE_COUNT[input.status] ?? 0) : 0;
  // 成果物フォールバック: preview.mp4 は旧フロー(preview廃止前)の遺物 = レビューまで完了扱い、
  // final.mp4 があれば全工程完了(statusの書き忘れ・古い値に対する保険)
  if (input.hasPreview) done = Math.max(done, 8);
  if (input.hasFinal) done = Math.max(done, total);
  return Math.min(done, total);
}

/** 完了工程数から工程レール(JobStage[])を組み立てる(エピソード詳細の進捗表示用) */
export function buildVideoCreateStages(input: EpisodeProgressInput): JobStage[] {
  const labels = OPERATIONS['video-create']!.stages;
  const done = videoCreateDoneCount(input);
  return labels.map((label, i) => ({
    key: `s${i}`,
    label,
    state: i < done ? 'done' : i === done ? 'active' : 'pending',
  }));
}

/**
 * 工程レールを「完了工程数 doneCount まで進んだ状態」へ前進補正した複製を返す。
 * 前進のみ(既にそれ以上進んでいれば元のまま)。全stageがdoneの場合はactiveを作らない。
 */
export function advanceStages(stages: JobStage[], doneCount: number): JobStage[] {
  const currentDone = stages.filter((s) => s.state === 'done').length;
  if (doneCount <= currentDone) return stages;
  return stages.map((s, i) => ({
    ...s,
    state: i < doneCount ? 'done' : i === doneCount ? 'active' : 'pending',
  }));
}

/**
 * video-create ジョブに対応するエピソードを同期的に探し、進捗入力を返す。
 * 1) request.episodeId 指定があればそのエピソード
 * 2) なければ episodes/ 配下の episode.json の subject がジョブタイトルと一致する最新(episodeId最大)のもの
 * 見つからなければ null。root/dir はジョブ側で検証済みの値を渡すこと。
 */
export function findEpisodeProgress(
  root: string,
  dir: string,
  request: JobRequest | undefined,
  title: string,
): (EpisodeProgressInput & { episodeId: string }) | null {
  if (!isSingleSegment(dir)) return null;
  const episodesDir = path.join(root, dir, 'episodes');
  const read = (episodeId: string): (EpisodeProgressInput & { episodeId: string }) | null => {
    const epDir = path.join(episodesDir, episodeId);
    let meta: Record<string, unknown>;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(epDir, 'episode.json'), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      meta = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    return {
      episodeId,
      status: typeof meta.status === 'string' ? meta.status : undefined,
      subject: typeof meta.subject === 'string' ? meta.subject : undefined,
      hasPreview: fs.existsSync(path.join(epDir, 'out', 'preview.mp4')),
      hasFinal: fs.existsSync(path.join(epDir, 'out', 'final.mp4')),
    } as EpisodeProgressInput & { episodeId: string; subject?: string };
  };

  if (request?.episodeId && isSingleSegment(request.episodeId)) {
    return read(request.episodeId);
  }

  let entries: string[];
  try {
    entries = fs
      .readdirSync(episodesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return null;
  }
  const matches = entries
    .map(read)
    .filter((m): m is EpisodeProgressInput & { episodeId: string; subject?: string } => m !== null)
    .filter((m) => (m as { subject?: string }).subject === title);
  if (matches.length === 0) return null;
  // epNNN-<slug> 形式は辞書順=作成順。同一題材の再制作があっても最新を採る
  matches.sort((a, b) => (a.episodeId < b.episodeId ? -1 : 1));
  return matches[matches.length - 1]!;
}

function isSingleSegment(s: string): boolean {
  if (s === '' || s === '.' || s === '..') return false;
  return !s.includes('/') && !s.includes('\\') && !s.includes(path.sep);
}
