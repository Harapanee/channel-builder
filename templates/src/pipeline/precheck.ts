/**
 * レンダー前検査(工程9)の一括実行+入力ハッシュによるスキップ。
 *
 * 背景: video-createのフェーズ分割運用では、フェーズ再開・レビュー後の
 * 再確認のたびに同じ4ゲート(tsc / validate / Infinity / qa-smoke)が
 * 焼き直され、1ジョブ内で qa-smoke が7回走ることを実測した(ep001-shoyu)。
 * 検査の入力(ソース・素材・ショット・タイミング)が変わっていなければ
 * 結果は変わらないため、入力ハッシュと前回結果を
 * episodes/<epId>/review/precheck-state.json に記録し、未変更なら即SKIPする。
 *
 * ハッシュ対象(検査結果に影響する入力の全体):
 * - src/ 以下の全ファイル(tsc・シーン実装・パイプライン)
 * - assets/ 以下の全ファイル(raw/ 中間物は除外 — レンダーが参照しない)
 * - episodes/<epId>/shots.json・timing.json
 * - tsconfig.json
 * episode.json は含めない(status更新のたびに無効化されるのを防ぐ。
 * targetDurationSec等の変更は shots/timing に必ず現れる)。
 * public/ も含めない(assets/・episodes/ へのシンボリックリンク集であり、
 * 含めると precheck 自身が書く review/ のレポートまでハッシュに入って
 * 毎回自己無効化することを実測した)。
 *
 * 実行ゲート(render-episode.sh 内の機械ゲートの前倒しと同一):
 * 1. npx tsc --noEmit
 * 2. npm run validate <episodeDir>
 * 3. src/scenes/episodes/<epId>/ に 'Infinity' がヒットしないこと
 * 4. npx tsx src/pipeline/qa-smoke.ts <episodeDir>
 *
 * CLI: tsx src/pipeline/precheck.ts episodes/<epId> [--force]
 *   --force  ハッシュ一致でも全ゲートを再実行する
 * 全緑で exit 0(状態を記録)、NGありで exit 1。
 */
import { createHash } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

type GateResult = { name: string; ok: boolean; detail?: string };

type PrecheckState = {
  episodeDir: string;
  inputHash: string;
  ok: boolean;
  passedAt: string;
  elapsedSec: number;
  gates: GateResult[];
};

function listFiles(dir: string, out: string[], exclude: RegExp[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (exclude.some((re) => re.test(p))) continue;
    const st = statSync(p);
    if (st.isDirectory()) listFiles(p, out, exclude);
    else out.push(p);
  }
}

function computeInputHash(episodeDir: string): string {
  const files: string[] = [];
  const exclude = [/node_modules/, /\.DS_Store$/, /assets\/.*\/raw\//];
  for (const dir of ["src", "assets"]) listFiles(dir, files, exclude);
  for (const f of [
    path.join(episodeDir, "shots.json"),
    path.join(episodeDir, "timing.json"),
    "tsconfig.json",
  ]) {
    if (existsSync(f)) files.push(f);
  }
  files.sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\0");
    h.update(createHash("sha256").update(readFileSync(f)).digest());
  }
  return h.digest("hex");
}

function runGate(name: string, cmd: string, args: string[]): GateResult {
  console.log(`\n== precheck gate: ${name} — ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  const ok = r.status === 0;
  console.log(ok ? `== ${name}: OK` : `== ${name}: NG (exit ${r.status})`);
  return { name, ok };
}

function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const episodeDir = argv.filter((a) => !a.startsWith("--"))[0];
  if (!episodeDir || !existsSync(path.join(episodeDir, "shots.json"))) {
    console.error("usage: precheck.ts episodes/<epId> [--force]");
    console.error("(episodes/<epId>/shots.json が存在すること)");
    process.exit(1);
  }
  const epId = path.basename(episodeDir);
  const statePath = path.join(episodeDir, "review", "precheck-state.json");

  const startedAt = Date.now();
  const inputHash = computeInputHash(episodeDir);

  if (!force && existsSync(statePath)) {
    try {
      const prev = JSON.parse(readFileSync(statePath, "utf-8")) as PrecheckState;
      if (prev.ok && prev.inputHash === inputHash) {
        console.log(
          `precheck: SKIP — 入力未変更(前回全緑 ${prev.passedAt}、` +
            `${prev.elapsedSec}s分の検査を省略)。再実行は --force`
        );
        process.exit(0);
      }
    } catch {
      // 壊れた状態ファイルは無視して再検査
    }
  }

  const gates: GateResult[] = [];

  gates.push(runGate("tsc", "npx", ["tsc", "--noEmit"]));

  if (gates.every((g) => g.ok)) {
    gates.push(runGate("validate", "npm", ["run", "validate", episodeDir]));
  }

  if (gates.every((g) => g.ok)) {
    // Infinityゲート(render-episode.sh と同一判定)。grepはヒット0で exit 1 を
    // 返すため、ここでは「ヒットがあればNG」に読み替える
    console.log(`\n== precheck gate: infinity — grep -rnw Infinity src/scenes/episodes/${epId}`);
    let hits = "";
    try {
      hits = execSync(`grep -rnw 'Infinity' 'src/scenes/episodes/${epId}'`, {
        encoding: "utf-8",
      });
    } catch {
      // exit 1 = ヒットなし(正常)
    }
    const ok = hits.trim() === "";
    if (!ok) console.log(hits.trim());
    console.log(ok ? "== infinity: OK(ヒット0)" : "== infinity: NG(Infinity参照あり)");
    gates.push({ name: "infinity", ok, detail: ok ? undefined : hits.trim() });
  }

  if (gates.every((g) => g.ok)) {
    gates.push(
      runGate("qa-smoke", "npx", ["tsx", "src/pipeline/qa-smoke.ts", episodeDir])
    );
  }

  const ok = gates.every((g) => g.ok);
  const elapsedSec = Math.round((Date.now() - startedAt) / 100) / 10;
  const state: PrecheckState = {
    episodeDir,
    inputHash,
    ok,
    passedAt: new Date().toISOString(),
    elapsedSec,
    gates,
  };
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  console.log(
    `\nprecheck: ${ok ? "ALL GREEN" : "NG"} (${elapsedSec}s) — state: ${statePath}`
  );
  process.exit(ok ? 0 : 1);
}

main();
