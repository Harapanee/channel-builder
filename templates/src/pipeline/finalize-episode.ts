/**
 * 工程12の完了処理を一括実行する(判断を含まない事務処理のみ)。
 *   npm run finalize episodes/<epId> -- --images 12 [--hours 3.5] [--cost 180] [--dry-run]
 *
 * 所要時間とコストは**セッション記録から機械計測する**(2026-08-02)。
 * それまでは人の申告値を渡していたため実態と乖離していた —
 * ep013 は metrics に 9.7時間 / costUsd 未記録と書かれたが、実測は 3.52時間 / $166。
 * 是正の入力になる数字が推測では、次の改善の根拠が立たない。
 * 制作の窓は episode.json の startedAt(工程0で記録)〜 now。
 * --hours / --cost を明示したときだけ、その値が実測より優先される。
 *
 * 出力: net-source素材一覧(人間ゲート提示用) + 実行した更新のログ
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectUsage, transcriptDirFor, TURN_BUDGET } from './usage-report';

const args = process.argv.slice(2);
const epDir = args.find((a) => !a.startsWith('--'));
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes('--dry-run');
if (!epDir || !fs.existsSync(path.join(epDir, 'episode.json'))) {
  console.error('usage: npm run finalize episodes/<epId> -- --images <n> [--hours <n>] [--cost <usd>] [--dry-run]');
  process.exit(2);
}
const epId = path.basename(epDir);
const images = flag('images') !== undefined ? Number(flag('images')) : null;

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

// 2) metrics追記
const sysPath = '.channel-system.json';
const sys = JSON.parse(fs.readFileSync(sysPath, 'utf8'));
// metrics のキーは episodeId が正本。過去に epId で書かれた行が混在しており、
// episodeId だけを見る重複判定では同じepが2行に増えていた(2026-08-01 修正)。
sys.metrics = sys.metrics ?? [];
type Metric = { episodeId?: string; epId?: string; [k: string]: unknown };
const existing = sys.metrics.find((m: Metric) => (m.episodeId ?? m.epId) === epId);
if (existing) {
  if (existing.epId) {
    existing.episodeId = epId;
    delete existing.epId;
  }
  existing.wallClockHours = hours ?? existing.wallClockHours ?? null;
  existing.imageGenCount = images ?? existing.imageGenCount ?? null;
  if (costUsd !== null) existing.costUsd = costUsd;
  if (measured.agentTurns !== null) existing.agentTurns = measured.agentTurns;
  if (existing.renderMinutes === undefined) existing.renderMinutes = null;
} else {
  sys.metrics.push({
    episodeId: epId,
    wallClockHours: hours,
    imageGenCount: images,
    costUsd,
    /* サブエージェントの総ターン数。コストはこれにほぼ線形なので、
       次の是正が「どの工程のターンを削るか」を数字で選べるようにする */
    agentTurns: measured.agentTurns,
    renderMinutes: null,
  });
}

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

// 4) episode.json status更新
const prevStatus = ep.status;
ep.status = 'render_ready';

console.log('\n## 実行内容');
console.log(
  `- metrics追記: ${epId} (hours=${hours}, images=${images}, costUsd=${costUsd}, agentTurns=${measured.agentTurns})`
);
console.log(`- backlog消し込み: ${backlogChanged ? '更新' : '該当行なし'}`);
console.log(`- episode.json: status ${prevStatus} → render_ready`);
if (dryRun) {
  console.log('(--dry-run: 書き込み・commitなし)');
  process.exit(0);
}

fs.writeFileSync(sysPath, JSON.stringify(sys, null, 2) + '\n');
if (backlogChanged) fs.writeFileSync(backlogPath, backlog);
fs.writeFileSync(epJsonPath, JSON.stringify(ep, null, 2) + '\n');

// 5) git commit
// assets/ を必ず含める。2026-08-01 修正: それまで add 対象が「台帳+epDir」だけで、
// 工程7で生成・承認した素材(assets/characters/... と assets/library.json への追記)が
// 毎回コミットされずに作業ツリーへ溜まっていた(実測: library.json 未コミット +1282行、
// 未追跡の素材ディレクトリ20件以上)。素材はエピソードの成果物であり、失うと再生成になる。
const ledgerPath = 'channel/episode-ledger.json';
const libraryPath = 'assets/library.json';
execFileSync(
  'git',
  [
    'add',
    sysPath,
    epJsonPath,
    ...(backlogChanged ? [backlogPath] : []),
    ...(fs.existsSync(ledgerPath) ? [ledgerPath] : []),
    ...(fs.existsSync(libraryPath) ? [libraryPath, 'assets'] : []),
    epDir,
  ],
  { stdio: 'inherit' },
);
execFileSync('git', ['commit', '-m', `chore(${epId}): 承認完了・render_ready(finalize-episode)`], { stdio: 'inherit' });
console.log('- git commit 完了');
