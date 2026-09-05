/**
 * 章単位の生成。
 *   npm run h3:run -- <epId> <章ID> [--plan|--dry] [--only cL01,cL02] [--seed 7] [--url https://…]
 * exit 0=正常 / 2=引数不正・投入前検査で BLOCK / 3=GPU 課金ロック(H3_ALLOW_GPU 無し)
 *
 * --plan / --dry は計画と検査だけを行い、GPU を使わない。
 * 実生成には H3_ALLOW_GPU=1 と --url が要る。
 *
 * seed は既定 0(同じ宣言からは同じ絵 = 再現性)。**不合格クリップを h3:reject で隔離して
 * 作り直すとき、同じ seed のままでは同じ絵しか引けない。**別の絵が欲しいときだけ振る。
 *
 * 鎖(前カットの最終フレームを起点にする)があるため、章の中は逐次に回す。
 * **鎖の起点の実在は投入前に確かめる。** lastFrame() の例外は Pod 起動後 = 課金中に出るので、
 * 砦として遅すぎる(章をまたぐ鎖を順不同に回すと必ず踏む)。
 * ただし**ジョブは先に全部組んで一括で検査する**(basename の一意性は集合でしか見られない)。
 * **常駐監視ループは作らない。** 欠けを自動検出して投げる仕組みは意図しない課金を起こす。
 */
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { COMFY_CLI, LORA, ROOT, SAMPLER, SIGMA_SHIFT, SIZE_DEFAULT, SIZE_HI, STEPS, WORKFLOW, assertGpuAllowed, clipsDir, framesDir, podUrl } from "./config";
import { chapterCard, composePrompt } from "./compose";
import { checkJobSet, checkLedger, checkPromptText } from "./check";
import type { Cut, CutsFile, Finding, ShotDecl, Vocab } from "./types";

export interface Job {
  id: string;
  prompt: string;
  seconds: number;
  width: number;
  height: number;
  seed: number;
  firstFrameFile?: string;
}

/** 章カードは chapterCard() の定型に書き手の宣言を重ねる(check-h3-prompt と同じ順序) */
export function fullDecl(decl: ShotDecl): ShotDecl {
  return decl.card ? { ...chapterCard(decl.card[0], decl.card[1]), ...decl } : decl;
}

/**
 * 実際に投げる seed。**指定が無ければ 0**(設計 §9「seed は 0 固定」)。
 * 強さは「宣言(1カット) > --seed(章全体) > 0」。狭いほうを強くするのは
 * batch.mjs の normalizeJobs(個別 > defaults)と同じ向きで、
 * 宣言に残した seed が章全体の指定で黙って流されないようにするため。
 * ぶつかったカットは declaredSeedOverrides() で必ず列挙する。
 */
export function resolveSeed(decl: ShotDecl, chapterSeed?: number): number {
  return decl.seed ?? chapterSeed ?? 0;
}

/** `--seed <n>` の読み取り。無ければ undefined。壊れた値は黙って 0 に落とさず投げる */
export function parseSeed(args: string[]): number | undefined {
  const at = args.indexOf("--seed");
  if (at < 0) return undefined;
  const raw = args[at + 1];
  const n = Number(raw);
  if (raw === undefined || raw.startsWith("--") || raw.trim() === "" || !Number.isSafeInteger(n) || n < 0) {
    throw new Error("--seed には 0 以上の整数を渡してください(受け取った値: " + String(raw) + ")");
  }
  return n;
}

/**
 * `--seed` を渡したのに宣言側の seed が勝ったカット。
 * 「振ったつもりで同じ絵が出る」を黙って起こさないために列挙して見せる。
 */
export function declaredSeedOverrides(
  targets: string[],
  shots: Record<string, ShotDecl>,
  chapterSeed?: number,
): { id: string; declared: number }[] {
  if (chapterSeed === undefined) return [];
  return targets.flatMap((id) => {
    const d = shots[id]?.seed;
    return d !== undefined && d !== chapterSeed ? [{ id, declared: d }] : [];
  });
}

export function buildJob(
  id: string,
  decl: ShotDecl,
  cut: Cut,
  vocab: Vocab,
  firstFrameFile?: string,
  chapterSeed?: number,
): Job {
  const size = cut.hi ? SIZE_HI : SIZE_DEFAULT;
  const full = fullDecl(decl);
  return {
    id,
    prompt: composePrompt(full, vocab, { firstFrame: Boolean(firstFrameFile) }),
    seconds: cut.seconds,
    width: size.width,
    height: size.height,
    seed: resolveSeed(full, chapterSeed),
    ...(firstFrameFile ? { firstFrameFile } : {}),
  };
}

/**
 * batch.mjs へ渡すジョブ仕様。**defaults に載せるのは「全カットで同じもの」だけ**にする
 * (個別指定が defaults より強いのは normalizeJobs の契約)。
 * sigmaShift は null のときキーごと落とす — ノードを生やさない意図を明示するため。
 *
 * **WORKFLOW(Volume 保存の名前付きワークフロー)を使うときは steps / lora / sampler /
 * sigmaShift を載せない。** 載せるとワークフロー側の値と二重指定になり、batch.mjs が止める
 * (どちらが効くのか読めない状態を作らないため)。
 */
export function jobSpecFor(job: Job): {
  defaults: Record<string, unknown>;
  jobs: Job[];
} {
  return {
    defaults: WORKFLOW
      ? { workflow: WORKFLOW }
      : {
          steps: STEPS,
          lora: LORA,
          sampler: SAMPLER,
          ...(SIGMA_SHIFT ? { sigmaShift: SIGMA_SHIFT } : {}),
        },
    jobs: [job],
  };
}

/** 各カットの鎖の起点。null なら t2v */
export function resolveChain(order: string[], cuts: Record<string, Cut>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  let prev: string | null = null;
  for (const id of order) {
    const c = cuts[id];
    if (c?.chainFrom) out.set(id, c.chainFrom);
    else if (c?.chain) {
      if (!prev) throw new Error(id + ": chain の起点になる前のカットが章内にありません");
      out.set(id, prev);
    } else out.set(id, null);
    prev = id;
  }
  return out;
}

/**
 * --only の絞り込み。**鎖の起点解決は章全体で行い、ここでは対象を絞るだけ**にする。
 * 章に無いIDは誤字の可能性が高いので、黙って0本にせず例外にする。
 */
export function selectTargets(chapterCuts: string[], pending: string[], only?: string[]): string[] {
  if (!only || only.length === 0) return pending;
  const unknown = only.filter((id) => !chapterCuts.includes(id));
  if (unknown.length > 0) throw new Error("--only の " + unknown.join(", ") + " はこの章に無い(誤字の可能性)");
  return pending.filter((id) => only.includes(id));
}

/**
 * `--only` で名指しされたのに「生成済み」で対象から外れたID。
 *
 * 既存クリップがあるエピソード(ep015)では `--only` の全IDがこれに落ちて targets=0 になり、
 * 「生成するものはありません」で正常終了する。**未実証の実生成経路を1本も通していないのに
 * 「通った」と読める**のが危ないので、黙って落とさず作り直しの手順ごと明示する。
 */
export function onlyAlreadyGenerated(
  only: string[] | undefined,
  targets: string[],
  existing: ReadonlySet<string>,
): string[] {
  if (!only || only.length === 0) return [];
  return only.filter((id) => existing.has(id) && !targets.includes(id));
}

/**
 * 鎖の起点が用意できないカットを洗い出す。
 * 起点は「すでにクリップが在る」か「この実行のより前で作られる」のどちらかでなければならない。
 * 章をまたぐ鎖(cL135 ← cL118)を章の順不同で回すと前者も後者も満たさず、
 * 従来は Pod 起動後に lastFrame() が落ちていた(= 課金してから判明する)。
 */
export function missingChainSources(
  order: string[],
  chain: Map<string, string | null>,
  hasClip: (id: string) => boolean,
): { id: string; from: string }[] {
  const out: { id: string; from: string }[] = [];
  const producedBefore = new Set<string>();
  for (const id of order) {
    const from = chain.get(id) ?? null;
    if (from && !hasClip(from) && !producedBefore.has(from)) out.push({ id, from });
    producedBefore.add(id);
  }
  return out;
}

/** 投入前の不整合はすべて exit 2 に寄せる(check:h3 と同じ契約。生スタックを出さない) */
function orExit<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    console.error("❌ " + (e as Error).message);
    process.exit(2);
  }
}

/** クリップの最終フレームを png に落とす */
function lastFrame(epId: string, clipId: string): string {
  const src = join(clipsDir(epId), clipId + ".mp4");
  if (!existsSync(src)) throw new Error(clipId + " がまだ生成されていません(鎖の起点が無い)");
  mkdirSync(framesDir(epId), { recursive: true });
  const dest = join(framesDir(epId), clipId + "-last.png");
  execFileSync("ffmpeg", ["-v", "error", "-sseof", "-0.1", "-i", src, "-frames:v", "1", "-y", dest]);
  return dest;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [epId, chapterId] = args;
  const plan = args.includes("--plan");
  const dry = args.includes("--dry") || plan;
  const url = args.includes("--url") ? args[args.indexOf("--url") + 1] : undefined;
  const onlyAt = args.indexOf("--only");
  const only = onlyAt >= 0 ? (args[onlyAt + 1] ?? "").split(/[,\s]+/).filter(Boolean) : undefined;
  const seed = orExit(() => parseSeed(args));
  if (!epId || !chapterId) { console.error("使い方: npm run h3:run -- <epId> <章ID> [--plan|--dry] [--only cL01,cL02] [--seed 7] [--url <URL>]"); process.exit(2); }
  if (only && only.length === 0) { console.error("--only にカットIDがありません(例: --only cL01,cL02)"); process.exit(2); }

  const CLIPS = clipsDir(epId);
  const epDir = join(ROOT, "h3/episodes", epId);
  const vocab = (await import(join(ROOT, "h3/vocab", epId + ".ts"))).default as Vocab;
  const cutsFile = JSON.parse(readFileSync(join(epDir, "cuts.json"), "utf8")) as CutsFile;
  const chapter = cutsFile.chapters.find((c) => c.id === chapterId);
  if (!chapter) { console.error("章 " + chapterId + " が cuts.json に無い"); process.exit(2); }
  const shots = (await import(join(epDir, "shots", chapterId + ".ts"))).default as Record<string, ShotDecl>;

  // 鎖の解決は**章全体**で行う(--only で絞っても起点の対応は壊さない)
  const chain = orExit(() => resolveChain(chapter.cuts, cutsFile.cuts));
  const hasClip = (id: string): boolean => existsSync(join(CLIPS, id + ".mp4"));
  const existing = new Set(chapter.cuts.filter(hasClip));
  const pending = plan ? chapter.cuts : chapter.cuts.filter((id) => !existing.has(id));
  const targets = orExit(() => selectTargets(chapter.cuts, pending, only));

  // 宣言と台帳の欠けは投げる文面が別物になるので、ジョブを組む前に止める
  const undeclared = targets.filter((id) => !shots[id] || !cutsFile.cuts[id]);
  if (undeclared.length > 0) {
    for (const id of undeclared) {
      console.error("❌ " + id + " の" + (shots[id] ? "" : "宣言(shots/" + chapterId + ".ts)") +
        (!shots[id] && !cutsFile.cuts[id] ? "と" : "") + (cutsFile.cuts[id] ? "" : "台帳(cuts.json)") + "が無い");
    }
    console.error("章 " + chapterId + " の宣言と台帳が揃っていない。生成しない");
    process.exit(2);
  }

  // --- ジョブを先に全部組んで一括検査(basename の一意性は集合でしか見られない) ---
  const jobs = targets.map((id) => {
    const from = chain.get(id);
    return buildJob(id, shots[id], cutsFile.cuts[id], vocab,
      from ? join(framesDir(epId), from + "-last.png") : undefined, seed);
  });
  const findings: Finding[] = [
    // 台帳と宣言の食い違いは「検査した文面」と「実際に投げる文面」を別物にする
    // (鎖の有無 = I2V 指示行の有無が変わる)。鎖は台帳から解決しているのでここで突合する
    ...targets.flatMap((id) => checkLedger(id, fullDecl(shots[id]), cutsFile.cuts[id])),
    ...jobs.flatMap((j) => checkPromptText(j.id, j.prompt, {
      seconds: j.seconds, hasFirstFrame: Boolean(j.firstFrameFile),
    })),
    ...checkJobSet(jobs),
  ];
  const blocks = findings.filter((f) => f.level === "BLOCK");
  if (blocks.length > 0) {
    for (const f of blocks) console.error("❌ " + f.id + " [" + f.rule + "] " + f.message);
    console.error("投入前検査で BLOCK が " + blocks.length + "件。生成しない");
    process.exit(2);
  }

  // 鎖の起点が用意できないカット。計画では警告、実投入では課金ロックより手前で止める
  const missing = missingChainSources(targets, chain, hasClip);

  console.log(chapterId + ": 全 " + chapter.cuts.length + "本 / 生成済み " + existing.size + "本 / 対象 " + targets.length + "本" +
    (only ? "(--only で絞り込み)" : ""));
  console.log(WORKFLOW
    ? "ワークフロー: " + WORKFLOW + "(Pod の Network Volume から読む。LoRA/steps/sampler/後処理はJSON側)"
    : "ワークフロー: コード生成(buildT2V)");

  // --seed を渡したのに宣言の seed が勝ったカットは黙らない(振ったつもりで同じ絵が出る)
  if (seed !== undefined) console.log("seed: " + seed + "(--seed で章全体へ適用)");
  for (const o of declaredSeedOverrides(targets, shots, seed)) {
    console.log("⚠️  " + o.id + " は宣言側の seed " + o.declared + " が優先されます(--seed " + seed + " は効きません)");
  }

  // --only のIDが生成済みで落ちたら黙らない(「1〜2本で試したつもり」で0本になるのを防ぐ)
  const alreadyDone = onlyAlreadyGenerated(only, targets, existing);
  for (const id of alreadyDone) {
    console.log("⚠️  " + id + " は生成済みのため対象外(作り直すには先に " +
      "`npm run h3:reject -- " + epId + " " + id + "` で隔離する)");
  }
  if (alreadyDone.length > 0 && targets.length === 0) {
    console.log("   --only の指定は全件が生成済みでした。この実行では1本も生成しません" +
      "(実生成経路の初回確認をしたいなら、先に h3:reject で1本隔離すること)");
  }
  if (dry) {
    for (const j of jobs) {
      const from = chain.get(j.id);
      console.log("  [" + (plan ? "plan" : "dry") + "] " + j.id + " " + j.seconds.toFixed(3) + "秒 " +
        j.width + "x" + j.height + (j.seed === 0 ? "" : " seed=" + j.seed) +
        (from ? " ← " + from : "") + (existing.has(j.id) ? " (生成済み)" : ""));
    }
    const chained = jobs.filter((j) => Boolean(j.firstFrameFile)).length;
    const hi = jobs.filter((j) => j.width === SIZE_HI.width).length;
    console.log("内訳: 鎖 " + chained + "本 / 高解像度 " + hi + "本 / t2v " + (jobs.length - chained) + "本");
    for (const m of missing) {
      console.log("⚠️  " + m.id + " の鎖の起点 " + m.from + " がまだ生成されていません(この実行でも作られません)");
    }
    if (missing.length > 0) {
      console.log("   先に " + [...new Set(missing.map((m) => m.from))].join(", ") + " を生成してください。この状態では実投入は止まります");
    }
    console.log(missing.length === 0
      ? "検査 OK。GPU は使っていません"
      : "起点の欠け " + missing.length + "件。実投入は止まります。GPU は使っていません");
    return;
  }

  if (missing.length > 0) {
    for (const m of missing) {
      console.error("❌ " + m.id + " の鎖の起点 " + m.from + " のクリップが無い(この実行でも作られない)");
    }
    console.error("鎖の起点が " + missing.length + "件足りない。生成しない(先に起点の章・カットを回すこと)");
    process.exit(2);
  }

  if (targets.length === 0) { console.log("生成するものはありません"); return; }
  assertGpuAllowed("章 " + chapterId + " の生成(" + targets.length + "本)");
  const resolvedUrl = podUrl(url);
  mkdirSync(join(epDir, "jobs"), { recursive: true });

  try {
    for (const job of jobs) {
      const from = chain.get(job.id);
      if (from) {
        const ff = lastFrame(epId, from); // 実体を作る
        const exists = checkJobSet([{ ...job, firstFrameFile: ff }], { requireExists: true })
          .filter((f) => f.level === "BLOCK");
        if (exists.length > 0) throw new Error(job.id + ": " + exists[0].message);
        job.firstFrameFile = ff;
      }
      const specPath = join(epDir, "jobs", "job-" + job.id + ".json");
      writeFileSync(specPath, JSON.stringify(jobSpecFor(job), null, 1) + "\n");
      execFileSync("node", ["batch.mjs", "--jobs", specPath, "--out", CLIPS, "--url", resolvedUrl],
        { cwd: COMFY_CLI, stdio: "inherit" });
      // batch.mjs は全ジョブ失敗でも exit 0 を返すので、出力の実在で判定する
      if (!existsSync(join(CLIPS, job.id + ".mp4"))) {
        throw new Error(job.id + ": batch は終了したがクリップが出ていない");
      }
    }
    console.log(chapterId + ": 完了");
  } finally {
    console.error("");
    console.error("※ Pod は自動では止まりません。作業を終えるときは必ず `npm run h3:pod -- down` を実行してください");
    console.error("   状態の確認: `npm run h3:pod -- status`");
  }
}

if (process.argv[1] && basename(process.argv[1]) === "run-chapter.ts") await main();
