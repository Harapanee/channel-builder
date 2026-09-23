/**
 * 工程12の完了処理を一括実行する(判断を含まない事務処理のみ)。
 *   npm run finalize episodes/<epId> [-- --images 12] [--hours 3.5] [--cost 180] [--dry-run]
 *
 * 所要時間とコストは**セッション記録から機械計測する**(2026-08-02)。
 * それまでは人の申告値を渡していたため実態と乖離していた —
 * ep013 は metrics に 9.7時間 / costUsd 未記録と書かれたが、実測は 3.52時間 / $166。
 * 是正の入力になる数字が推測では、次の改善の根拠が立たない。
 * 制作の窓は episode.json の startedAt(工程0で記録)〜 now。
 * --hours / --cost を明示したときだけ、その値が実測より優先される。
 *
 * H3 経路の回(.channel-system.json の h3Pipeline.episodes)は assemble の out/final.mp4 が最終物なので、
 * 終端 status を `final` にする(夜間レンダーへは回さない。render-episode.sh / キューも H3 回を拒否する)。
 * コミット対象に h3/episodes/<ep>・h3/vocab/<ep>.ts・publish/upload-result.json を含める(2026-09-23)。
 *
 * 画像生成数(imageGenCount)は成果物から実数で数える(サムネ1枚絵 publish/thumb-oneshot-<n>.png +
 * keyframe 終点画像 ff/<cut>-end.png + library の epId 紐付き生成素材)。2026-09-23 まで全話
 * `--images 3` の固定値が書かれており実数ではなかった。数えられなければ記録しない。
 * `--images <n>` を明示したときだけ、その値が実数より優先される。
 *
 * 出力: net-source素材一覧(人間ゲート提示用) + 実行した更新のログ
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectUsage, transcriptDirFor, TURN_BUDGET } from './usage-report';
import { framesDir as h3FramesDir } from './h3/config';

/* ---------- 純関数(テスト対象) ---------- */

type Sys = { h3Pipeline?: unknown; metrics?: Array<Record<string, unknown>>; [k: string]: unknown };

/** .channel-system.json の h3Pipeline.episodes に載る回か。キー無し・形の崩れは false */
export function isH3Episode(sys: unknown, epId: string): boolean {
  if (!sys || typeof sys !== 'object') return false;
  const h3 = (sys as Sys).h3Pipeline;
  if (!h3 || typeof h3 !== 'object') return false;
  const eps = (h3 as { episodes?: unknown }).episodes;
  return Array.isArray(eps) && eps.includes(epId);
}

/** 工程12完了時の終端 status。H3 回は assemble の完了が最終物なので final、それ以外は夜間レンダー待ち */
export function finalStatusFor(isH3: boolean): 'final' | 'render_ready' {
  return isH3 ? 'final' : 'render_ready';
}

/**
 * git add に渡すパス。実在しないパスは渡さない(git add が pathspec エラーで落ちる)。
 * assets/ を必ず含める(2026-08-01: 工程7の素材が毎回コミットされず作業ツリーに溜まっていた)。
 * H3 回は h3/episodes/<ep>(cuts・文面・台帳)と h3/vocab/<ep>.ts を含める(2026-09-23: ep042 の H3 元データが
 * 未追跡のまま残っていた)。publish/upload-result.json は epDir 配下だが明示する(意図の記録)。
 */
export function commitPaths(o: {
  epId: string;
  epDir: string;
  isH3: boolean;
  backlogChanged: boolean;
  exists: (p: string) => boolean;
}): string[] {
  const { epId, epDir, exists } = o;
  const paths = ['.channel-system.json', path.join(epDir, 'episode.json')];
  if (o.backlogChanged) paths.push('channel/backlog.md');
  if (exists('channel/episode-ledger.json')) paths.push('channel/episode-ledger.json');
  if (exists('assets/library.json')) paths.push('assets/library.json', 'assets');
  paths.push(epDir);
  const upload = path.join(epDir, 'publish', 'upload-result.json');
  if (exists(upload)) paths.push(upload);
  if (o.isH3) {
    for (const p of [`h3/episodes/${epId}`, `h3/vocab/${epId}.ts`]) if (exists(p)) paths.push(p);
  }
  return paths;
}

const listDir = (d: string): string[] => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};

/**
 * この回で AI 生成した画像の実数。サムネ1枚絵(publish/thumb-oneshot-<n>.png)+ keyframe 終点画像
 * (<framesDir>/<cut>-end.png。-raw・-last は数えない)+ library の epId 紐付き素材(net-source は生成ではない)。
 * 1枚も見つからなければ null(成果物が消えている等で数えられない。固定値で埋めない)。
 */
export function countGeneratedImages(o: {
  epDir: string;
  epId: string;
  framesDir?: string;
  library: Array<{ file?: string; license?: string; approvedBy?: string }>;
}): number | null {
  const thumbs = listDir(path.join(o.epDir, 'publish')).filter((f) => /^thumb-oneshot-\d+\.png$/.test(f)).length;
  const ends = o.framesDir ? listDir(o.framesDir).filter((f) => /-end\.png$/.test(f)).length : 0;
  const assets = o.library.filter(
    (a) => a.approvedBy !== 'net-source' && typeof a.file === 'string' && a.file.includes(o.epId),
  ).length;
  const total = thumbs + ends + assets;
  return total > 0 ? total : null;
}

/**
 * metrics へ追記する。キーは episodeId が正本(過去に epId で書かれた行を寄せる。2026-08-01 修正)。
 * images が null のときは imageGenCount を書かない(既存値は保持)。
 */
export function applyMetrics(
  sys: { metrics?: Array<Record<string, unknown>> },
  epId: string,
  v: { hours: number | null; images: number | null; costUsd: number | null; agentTurns: number | null },
): void {
  sys.metrics = sys.metrics ?? [];
  const existing = sys.metrics.find((m) => (m.episodeId ?? m.epId) === epId);
  if (existing) {
    if (existing.epId) {
      existing.episodeId = epId;
      delete existing.epId;
    }
    existing.wallClockHours = v.hours ?? existing.wallClockHours ?? null;
    if (v.images !== null) existing.imageGenCount = v.images;
    if (v.costUsd !== null) existing.costUsd = v.costUsd;
    if (v.agentTurns !== null) existing.agentTurns = v.agentTurns;
    if (existing.renderMinutes === undefined) existing.renderMinutes = null;
  } else {
    sys.metrics.push({
      episodeId: epId,
      wallClockHours: v.hours,
      ...(v.images !== null ? { imageGenCount: v.images } : {}),
      costUsd: v.costUsd,
      /* サブエージェントの総ターン数。コストはこれにほぼ線形なので、
         次の是正が「どの工程のターンを削るか」を数字で選べるようにする */
      agentTurns: v.agentTurns,
      renderMinutes: null,
    });
  }
}

/* ---------- CLI ---------- */

function main(): void {

  const args = process.argv.slice(2);
  const epDir = args.find((a) => !a.startsWith('--'));
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dryRun = args.includes('--dry-run');
  if (!epDir || !fs.existsSync(path.join(epDir, 'episode.json'))) {
    console.error('usage: npm run finalize episodes/<epId> [-- --images <n>] [--hours <n>] [--cost <usd>] [--dry-run]');
    process.exit(2);
  }
  const epId = path.basename(epDir);

  /* --- 実測(セッション記録)から所要時間・コスト・ターン数を取る --- */
  type Measured = {
    hours: number | null;
    costUsd: number | null;
    subagentCostUsd: number | null;
    agentTurns: number | null;
    note: string;
  };
  function measure(startedAt: string | undefined): Measured {
    const empty: Measured = { hours: null, costUsd: null, subagentCostUsd: null, agentTurns: null, note: '' };
    const since = flag('since') ?? startedAt;
    if (!since) {
      return { ...empty, note: 'episode.json に startedAt が無く --since も未指定のため実測できず' };
    }
    try {
      const r = collectUsage({
        dir: transcriptDirFor(process.cwd()),
        since: Date.parse(since),
        until: flag('until') ? Date.parse(flag('until')!) : null,
      });
      const over = r.agentSummaries.filter((a) => a.turns > TURN_BUDGET);
      return {
        hours: r.activeHours,
        costUsd: r.costUsd,
        subagentCostUsd: r.subagentCostUsd,
        agentTurns: r.agentSummaries.reduce((s, a) => s + a.turns, 0),
        note:
          `セッション記録 ${r.files}本 + サブエージェント ${r.agentSummaries.length}本 / ${since} 以降` +
          (over.length > 0
            ? `\n  ! ターン予算(${TURN_BUDGET})超過が ${over.length}本: ` +
              over.map((a) => `${a.label}=${a.turns}ターン($${a.costUsd.toFixed(1)})`).join(' / ')
            : ''),
      };
    } catch (e) {
      return { ...empty, note: `実測できず(${(e as Error).message})` };
    }
  }

  const epJsonPath = path.join(epDir, 'episode.json');
  const ep = JSON.parse(fs.readFileSync(epJsonPath, 'utf8'));

  // 0) 実測(明示指定があればそちらを優先する)
  const measured = measure(ep.startedAt);
  const hours = flag('hours') !== undefined ? Number(flag('hours')) : measured.hours;
  const costUsd = flag('cost') !== undefined ? Number(flag('cost')) : measured.costUsd;
  console.log('## 実測(セッション記録)');
  console.log(`- 実所要 ${measured.hours ?? '?'} 時間 / API換算 $${measured.costUsd ?? '?'}` +
    `(うちサブエージェント $${measured.subagentCostUsd ?? '?'} ・ ${measured.agentTurns ?? '?'}ターン)`);
  if (measured.note) console.log(`  ${measured.note}`);
  if (measured.hours === null) {
    console.log('  → 工程0で episode.json に startedAt(ISO)を記録すると自動で測れます');
  }

  // 1) net-source素材一覧(ゲートcontext用)— このエピソードに関わる項目を抽出
  const lib = JSON.parse(fs.readFileSync('assets/library.json', 'utf8'));
  const assets: Array<{ file: string; license?: string; approvedBy?: string }> = lib.assets ?? [];
  const netSource = assets.filter(
    (a) =>
      a.approvedBy === 'net-source' &&
      (a.file?.includes(epId) || a.license?.includes(epId)),
  );
  console.log('## ネット実物素材一覧(人間ゲート判定用)');
  if (netSource.length === 0) {
    console.log('(該当なし — epId紐付けで抽出。取りこぼし懸念があれば library.json の approvedBy:"net-source" 全件を目視)');
  } else {
    for (const a of netSource) console.log(`- ${a.file} : ${a.license ?? '(URL未記録)'}`);
  }

  // 2) metrics追記(画像生成数は実数。--images 明示時のみそちらを優先)
  const sysPath = '.channel-system.json';
  const sys = JSON.parse(fs.readFileSync(sysPath, 'utf8'));
  const isH3 = isH3Episode(sys, epId);
  const counted = countGeneratedImages({
    epDir,
    epId,
    framesDir: isH3 ? h3FramesDir(epId) : undefined,
    library: assets,
  });
  const images = flag('images') !== undefined ? Number(flag('images')) : counted;
  applyMetrics(sys, epId, { hours, images, costUsd, agentTurns: measured.agentTurns });

  // 3) backlog消し込み
  const backlogPath = 'channel/backlog.md';
  let backlogChanged = false;
  let backlog = '';
  if (fs.existsSync(backlogPath)) {
    backlog = fs.readFileSync(backlogPath, 'utf8');
    const re = new RegExp(`制作中\\(${epId}[^)]*\\)`, 'g');
    if (re.test(backlog)) {
      backlog = backlog.replace(re, `済(${epId})`);
      backlogChanged = true;
    }
  }

  // 4) episode.json status更新(H3 回は assemble の final.mp4 が最終物なので final。夜間レンダーには回さない)
  const prevStatus = ep.status;
  const nextStatus = finalStatusFor(isH3);
  ep.status = nextStatus;

  console.log('\n## 実行内容');
  console.log(
    `- metrics追記: ${epId} (hours=${hours}, images=${images ?? '数えられず(記録しない)'}` +
      `${flag('images') !== undefined ? ' ※--images 明示' : ''}, costUsd=${costUsd}, agentTurns=${measured.agentTurns})`
  );
  console.log(`- backlog消し込み: ${backlogChanged ? '更新' : '該当行なし'}`);
  console.log(`- episode.json: status ${prevStatus} → ${nextStatus}${isH3 ? '(H3 経路: assemble の out/final.mp4 が最終物。夜間レンダーへ積まない)' : ''}`);
  if (dryRun) {
    console.log('(--dry-run: 書き込み・commitなし)');
    process.exit(0);
  }

  fs.writeFileSync(sysPath, JSON.stringify(sys, null, 2) + '\n');
  if (backlogChanged) fs.writeFileSync(backlogPath, backlog);
  fs.writeFileSync(epJsonPath, JSON.stringify(ep, null, 2) + '\n');

  // 5) git commit
  const addPaths = commitPaths({ epId, epDir, isH3, backlogChanged, exists: (p) => fs.existsSync(p) });
  execFileSync('git', ['add', ...addPaths], { stdio: 'inherit' });
  const subject = isH3 ? `承認完了・final(H3 経路・finalize-episode)` : `承認完了・render_ready(finalize-episode)`;
  execFileSync('git', ['commit', '-m', `chore(${epId}): ${subject}`], { stdio: 'inherit' });
  console.log('- git commit 完了');
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  main();
}
