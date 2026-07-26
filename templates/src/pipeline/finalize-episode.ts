/**
 * 工程12の完了処理を一括実行する(判断を含まない事務処理のみ)。
 *   npm run finalize episodes/<epId> -- --hours 3.5 --images 12 [--dry-run]
 * 出力: net-source素材一覧(人間ゲート提示用) + 実行した更新のログ
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const epDir = args.find((a) => !a.startsWith('--'));
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes('--dry-run');
if (!epDir || !fs.existsSync(path.join(epDir, 'episode.json'))) {
  console.error('usage: npm run finalize episodes/<epId> -- --hours <n> --images <n> [--dry-run]');
  process.exit(2);
}
const epId = path.basename(epDir);
const hours = flag('hours') !== undefined ? Number(flag('hours')) : null;
const images = flag('images') !== undefined ? Number(flag('images')) : null;

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
sys.metrics = sys.metrics ?? [];
if (!sys.metrics.some((m: { episodeId: string }) => m.episodeId === epId)) {
  sys.metrics.push({ episodeId: epId, wallClockHours: hours, imageGenCount: images, renderMinutes: null });
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
const epJsonPath = path.join(epDir, 'episode.json');
const ep = JSON.parse(fs.readFileSync(epJsonPath, 'utf8'));
const prevStatus = ep.status;
ep.status = 'render_ready';

console.log('\n## 実行内容');
console.log(`- metrics追記: ${epId} (hours=${hours}, images=${images})`);
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
const ledgerPath = 'channel/episode-ledger.json';
execFileSync(
  'git',
  ['add', sysPath, epJsonPath, ...(backlogChanged ? [backlogPath] : []), ...(fs.existsSync(ledgerPath) ? [ledgerPath] : []), epDir],
  { stdio: 'inherit' },
);
execFileSync('git', ['commit', '-m', `chore(${epId}): 承認完了・render_ready(finalize-episode)`], { stdio: 'inherit' });
console.log('- git commit 完了');
