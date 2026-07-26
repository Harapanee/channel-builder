/**
 * HyperFrames composition の視覚多様性検査(CLI)。
 *
 * 使い方:
 *   npx tsx src/pipeline/check-composition.ts [episodeDir]
 *   引数なしのときは、ルート index.html とバイト一致する
 *   episodes/<epId>/composition.html を自動解決する。
 *
 * exit: 0 = OK または ADVISEのみ / 1 = BLOCKあり / 2 = 実行エラー
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { collectCompositionDom } from "./composition-dom";
import {
  evaluateAdviseRules,
  evaluateBlockRules,
  sceneClipsOf,
  type Finding,
  type LibraryEntry,
  type VisualRules,
} from "./visual-rules-hf";

const projectRoot = process.cwd();

/** 過去epのシグネチャを集める対象数(ブラウザ起動コストを抑えるため直近3本) */
const PAST_EPISODE_LIMIT = 3;

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

function listEpisodeCompositions(): string[] {
  const dir = path.join(projectRoot, "episodes");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((ep) => path.join(dir, ep, "composition.html"))
    .filter((p) => existsSync(p))
    .sort();
}

function resolveEpisodeDir(): string {
  const arg = process.argv[2];
  if (arg) {
    const abs = path.resolve(projectRoot, arg);
    if (!existsSync(path.join(abs, "composition.html"))) {
      fail(`composition.html が見つかりません: ${path.join(abs, "composition.html")}`);
    }
    return abs;
  }
  const indexPath = path.join(projectRoot, "index.html");
  if (!existsSync(indexPath)) {
    fail("index.html がありません。エピソードディレクトリを引数で指定してください(例: npm run check:visual -- episodes/ep001)");
  }
  const index = readFileSync(indexPath, "utf8");
  const matches = listEpisodeCompositions().filter((p) => readFileSync(p, "utf8") === index);
  if (matches.length === 1) return path.dirname(matches[0]);
  fail(
    matches.length === 0
      ? "index.html と一致する composition.html がありません。エピソードディレクトリを引数で指定してください"
      : `index.html と一致する composition.html が複数あります(${matches.length}件)。エピソードディレクトリを引数で指定してください`
  );
}

function loadRules(): VisualRules | null {
  const p = path.join(projectRoot, "channel", "visual-rules.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as VisualRules;
  } catch (e) {
    fail(`channel/visual-rules.json を読めません: ${(e as Error).message}`);
  }
}

function loadLibrary(): LibraryEntry[] {
  const p = path.join(projectRoot, "assets", "library.json");
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return (parsed.assets ?? []) as LibraryEntry[];
  } catch (e) {
    fail(`assets/library.json を読めません: ${(e as Error).message}`);
  }
}

async function collectPastSignatures(
  currentDir: string,
  rules: VisualRules
): Promise<Map<string, string[]>> {
  const targets = listEpisodeCompositions()
    .filter((p) => path.dirname(p) !== currentDir)
    .slice(-PAST_EPISODE_LIMIT);
  const map = new Map<string, string[]>();
  for (const comp of targets) {
    const epId = path.basename(path.dirname(comp));
    try {
      const dom = await collectCompositionDom(comp, projectRoot);
      for (const c of sceneClipsOf(dom, rules)) {
        const list = map.get(c.signature) ?? [];
        if (!list.includes(epId)) list.push(epId);
        map.set(c.signature, list);
      }
    } catch (e) {
      console.warn(`WARN: 過去ep ${epId} のシグネチャ収集に失敗したため持ち越し検査から除外します: ${(e as Error).message}`);
    }
  }
  return map;
}

function report(findings: Finding[]): void {
  for (const f of findings) console.log(`${f.level}: [${f.rule}] ${f.message}`);
}

async function main(): Promise<void> {
  // 設定の有無を先に見る。visual-rules.json を持たないチャンネル(検査を運用していない
  // チャンネル)では、index.html が作業中でどのエピソードとも一致しない状態でも
  // exit 2 で落ちてはならない — npm run check が無為に赤くなるため。
  const rules = loadRules();
  if (!rules) {
    console.log("SKIP: channel/visual-rules.json が無いため視覚多様性検査をスキップします");
    process.exit(0);
  }

  const episodeDir = resolveEpisodeDir();
  const epId = path.basename(episodeDir);

  const dom = await collectCompositionDom(path.join(episodeDir, "composition.html"), projectRoot);
  const scenes = sceneClipsOf(dom, rules);
  const unique = new Set(scenes.flatMap((c) => c.images.map((i) => i.src)));
  console.log(
    `検査対象: ${epId} — 尺 ${dom.durationSec.toFixed(2)}秒 / 全clip ${dom.clips.length} / シーンclip ${scenes.length} / ユニーク画像 ${unique.size}`
  );

  const past = await collectPastSignatures(episodeDir, rules);
  const blocks = evaluateBlockRules(dom, loadLibrary(), rules);
  const advises = evaluateAdviseRules(dom, rules, past);

  report(blocks);
  report(advises);

  if (blocks.length > 0) {
    console.error(`\nBLOCK ${blocks.length}件 / ADVISE ${advises.length}件 — 修正してから再実行してください`);
    process.exit(1);
  }
  console.log(`\nOK: BLOCK 0件 / ADVISE ${advises.length}件`);
  process.exit(0);
}

main().catch((e) => fail((e as Error).stack ?? String(e)));
