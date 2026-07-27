import fs from 'node:fs';
import path from 'node:path';
import type { JobStage, JobRequest } from '../shared/types';
import { OPERATIONS } from './operations';

// findEpisodeProgress/findShortIdForJob は同期的にディレクトリ走査+ファイル読込を行うため、
// ジョブ一覧取得(list→summary)・全ジョブの emitUpdate(reconciled)のたびに毎回叩くとホットパスになる。
// 短TTL(2000ms)のメモリキャッシュで走査回数を減らす。キーは dir+episodeId/title(またはarg)のみで
// root は含まない(1プロセス=1rootの前提。複数rootを扱うのはテストのみなので、テスト側は
// _clearProgressCache() でテスト間の汚染を防ぐこと)
const CACHE_TTL_MS = 2000;
const cache = new Map<string, { at: number; value: unknown }>();

/**
 * テスト用+キュー登録直前のstale回避用(jobs.ts maybeQueueOnSuccess): TTLキャッシュを空にする
 * (ファイル書き換え直後の再読込を検証したいテストのbeforeEach等、およびjobs.tsが承認直後に
 * 最新のepisode.json/short.json状態を読みたい箇所で呼ぶ)
 */
export function _clearProgressCache(): void {
  cache.clear();
}

/** key に対してTTL内のキャッシュがあればそれを返し、無ければ compute() を実行してキャッシュする */
function withCache<T>(key: string, compute: () => T): T {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at <= CACHE_TTL_MS) {
    return hit.value as T;
  }
  const value = compute();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// video-create の工程レール(調査/台本/音声/絵コンテ/素材/実装/検査/最終レビュー/公開準備/承認/レンダー)
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
  // 成果物フォールバック: preview.mp4 は旧フロー(preview廃止前)の遺物 = 最終レビューまで完了扱い、
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
 * 3) それも無ければ、createdAtMs(ジョブ開始時刻)以降に episode.json が更新されたもののうち最新
 *    (依頼が自由文でタイトルとsubjectが一致しないジョブの救済。Studioの対象指定・進捗レールが依存する)
 * 見つからなければ null。root/dir はジョブ側で検証済みの値を渡すこと。
 */
export function findEpisodeProgress(
  root: string,
  dir: string,
  request: JobRequest | undefined,
  title: string,
  createdAtMs?: number,
): (EpisodeProgressInput & { episodeId: string }) | null {
  const key = `ep|${dir}|${request?.episodeId ?? title}|${createdAtMs ?? ''}`;
  return withCache(key, () => {
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
    if (matches.length === 0) {
      if (createdAtMs === undefined) return null;
      // ジョブ開始以降に更新されたエピソードのうち最新を採る(自由文依頼のフォールバック)
      const candidates = entries
        .map((episodeId) => {
          try {
            const mtime = fs.statSync(path.join(episodesDir, episodeId, 'episode.json')).mtimeMs;
            return mtime >= createdAtMs ? { episodeId, mtime } : null;
          } catch {
            return null;
          }
        })
        .filter((c): c is { episodeId: string; mtime: number } => c !== null)
        .sort((a, b) => a.mtime - b.mtime);
      const latest = candidates[candidates.length - 1];
      return latest ? read(latest.episodeId) : null;
    }
    // epNNN-<slug> 形式は辞書順=作成順。同一題材の再制作があっても最新を採る
    matches.sort((a, b) => (a.episodeId < b.episodeId ? -1 : 1));
    return matches[matches.length - 1]!;
  });
}

// short-create の工程レール(台本/承認/音声/実装/Studio確認/公開準備/キュー投入/レンダー)に対する
// shorts/<shortId>/short.json の status → 完了工程数。status は short-create スキルが各工程完了時に
// 更新し、rendered は夜間レンダー成功時にサーバー(render-queue)が書く。
const SHORT_STATUS_DONE_COUNT: Record<string, number> = {
  scripted: 1,
  script_approved: 2,
  voiced: 3,
  implemented: 4,
  studio_checked: 5,
  // 6 = 公開準備。short.json に対応statusを持たないため metadata.json の存在で判定する
  queued: 7,
  rendered: 8,
};

export type ShortProgressInput = {
  status?: string;
  hasFinal?: boolean;
  hasMetadata?: boolean;   // shorts/<id>/publish/metadata.json の有無
};

/** short.json の status と成果物の有無から、short-create 工程レールの完了工程数を返す */
export function shortCreateDoneCount(input: ShortProgressInput): number {
  const total = OPERATIONS['short-create']!.stages.length;
  let done = input.status !== undefined ? (SHORT_STATUS_DONE_COUNT[input.status] ?? 0) : 0;
  // 公開準備(6): Studio確認済み(5)以降でのみ完了印を立てる。
  // 台本段階で先にmetadataを作っても手前の工程を完了と偽らないため
  if (input.hasMetadata && done >= 5) done = Math.max(done, 6);
  // final.mp4 があれば全工程完了(statusの書き忘れに対する保険。episodeと同方針)
  if (input.hasFinal) done = Math.max(done, total);
  return Math.min(done, total);
}

/** 完了工程数からショートの工程レール(JobStage[])を組み立てる(ショート詳細の進捗表示用) */
export function buildShortStages(input: ShortProgressInput): JobStage[] {
  const labels = OPERATIONS['short-create']!.stages;
  const done = shortCreateDoneCount(input);
  return labels.map((label, i) => ({
    key: `s${i}`,
    label,
    state: i < done ? 'done' : i === done ? 'active' : 'pending',
  }));
}

/**
 * short-create ジョブに対応するショートを同期的に探す。
 * arg は「<sourceEpisodeId> <formatId>」形式(例: "ep001-nobunaga rank3-reasons")。
 * shorts/ 配下の short.json の sourceEpisodeId+formatId が一致する最新(shortId最大)を返す。
 * shortId はエピソードと命名が独立(sh002-nobunaga-top3 等)なので、この突き合わせでしか辿れない。
 */
export function findShortIdForJob(root: string, dir: string, arg: string | undefined): string | undefined {
  const key = `short|${dir}|${arg ?? ''}`;
  return withCache(key, () => {
    if (!isSingleSegment(dir) || !arg) return undefined;
    const [sourceEpisodeId, formatId] = arg.trim().split(/\s+/);
    if (!sourceEpisodeId) return undefined;
    const shortsDir = path.join(root, dir, 'shorts');
    let entries: string[];
    try {
      entries = fs
        .readdirSync(shortsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return undefined;
    }
    const matches = entries.filter((shortId) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(shortsDir, shortId, 'short.json'), 'utf8'));
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
        if (meta.sourceEpisodeId !== sourceEpisodeId) return false;
        // formatId未指定のジョブはsourceEpisodeId一致のみで採る
        return formatId === undefined || meta.formatId === formatId;
      } catch {
        return false;
      }
    });
    if (matches.length === 0) return undefined;
    // shNNN-<slug> 形式は辞書順=作成順。同一組の再制作があっても最新を採る
    matches.sort();
    return matches[matches.length - 1];
  });
}

function isSingleSegment(s: string): boolean {
  if (s === '' || s === '.' || s === '..') return false;
  return !s.includes('/') && !s.includes('\\') && !s.includes(path.sep);
}

/** ジョブ成功時に表示する生成物(存在するもののみ・チャンネル相対パス)。 */
export function collectArtifacts(
  root: string,
  dir: string,
  opts: { episodeId?: string; shortId?: string },
): string[] {
  if (!isSingleSegment(dir)) return [];
  const base = opts.shortId ? path.join('shorts', opts.shortId) : opts.episodeId ? path.join('episodes', opts.episodeId) : null;
  if (!base || !isSingleSegment(opts.shortId ?? opts.episodeId ?? '')) return [];
  const abs = path.join(root, dir, base);
  const out: string[] = [];
  const push = (rel: string) => {
    if (fs.existsSync(path.join(abs, rel))) out.push(path.join(base, rel));
  };
  try {
    for (const f of fs.readdirSync(path.join(abs, 'out'))) {
      if (f.endsWith('.mp4')) out.push(path.join(base, 'out', f));
    }
  } catch { /* outなし */ }
  if (!opts.shortId) {
    push(path.join('publish', 'metadata.json'));
    try {
      for (const f of fs.readdirSync(path.join(abs, 'publish'))) {
        if (/^thumb-.*\.png$/.test(f)) out.push(path.join(base, 'publish', f));
      }
    } catch { /* publishなし */ }
  }
  return out.sort();
}
