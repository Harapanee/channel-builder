/**
 * 章単位の生成。
 *   npm run h3:run -- <epId> <章ID> [--plan|--dry] [--only cL01,cL02] [--seed 7] [--regen-end cL67,…] [--url https://…]
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
 *
 * Pod の見張り役(tools/comfy-runpod/lib/watchdog.mjs)向けに、クリップごとに heartbeat を touch する。
 * 例外・Ctrl-C・SIGTERM で抜けるときは batch.mjs を止め、down の案内を出して heartbeat を止める
 * (以後は見張りの無操作判定で Pod が落ちる)。
 */
import { basename, join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { COMFY_CLI, HEARTBEAT_FILE, LORA, ROOT, SAMPLER, SIGMA_SHIFT, SIZE_DEFAULT, SIZE_HI, STEPS, WORKFLOW, assertGpuAllowed, clipsDir, framesDir, podUrl, rejectedDir } from "./config";
import { isUsable } from "./assemble";
import { findStaleChains } from "./chain-stale";
import { freeName } from "./reject-clips";
import { chapterCard, composePrompt } from "./compose";
import { checkEndStateVocab, checkJobSet, checkLedger, checkPromptText } from "./check";
import { endFramePath, genEndFrame } from "./end-frame";
import type { Cut, CutsFile, Finding, ShotDecl, Vocab } from "./types";

export interface Job {
  id: string;
  prompt: string;
  seconds: number;
  width: number;
  height: number;
  seed: number;
  firstFrameFile?: string;
  /** keyframe カットの終点画像(FL2VA の last_frame)。Task 3 の genEndFrame が作る */
  lastFrameFile?: string;
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
  lastFrameFile?: string,
): Job {
  const size = cut.hi ? SIZE_HI : SIZE_DEFAULT;
  const full = fullDecl(decl);
  return {
    id,
    prompt: composePrompt(full, vocab, lastFrameFile ? { firstFrame: true, lastFrameAt: cut.seconds } : { firstFrame: Boolean(firstFrameFile) }),
    seconds: cut.seconds,
    width: size.width,
    height: size.height,
    seed: resolveSeed(full, chapterSeed),
    ...(firstFrameFile ? { firstFrameFile } : {}),
    ...(lastFrameFile ? { lastFrameFile } : {}),
  };
}

/** `--regen-end cL67,cL70`: 終点画像を消して作り直すカット */
export function parseRegenEnd(args: string[]): string[] {
  const at = args.indexOf("--regen-end");
  if (at < 0) return [];
  const raw = args[at + 1];
  if (raw === undefined || raw.startsWith("--") || raw.trim() === "") throw new Error("--regen-end にカットIDがありません(例: --regen-end cL67)");
  return raw.split(/[,\s]+/).filter(Boolean);
}

/**
 * `--regen-end` の ID を検証する。生成済みクリップは対象(targets)から外れるので、黙って無効になるのを防ぐ。
 * 戻り値は問題メッセージの配列(空なら OK)。
 */
export function validateRegenEnd(regenEnd: string[], targets: string[], cuts: Record<string, Cut>): string[] {
  const out: string[] = [];
  for (const id of regenEnd) {
    if (!targets.includes(id)) {
      out.push("--regen-end " + id + " は今回の生成対象にありません(生成済みか章外)。生成済みなら先に `npm run h3:reject -- <epId> " + id + "` で隔離してから");
    } else if (!cuts[id]?.keyframe) {
      out.push("--regen-end " + id + " は keyframe カットではありません(終点画像を持たない)");
    }
  }
  return out;
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

/** ff 画像を抽出し直すか。**クリップの方が新しいときだけ**(毎回抽出すると終点画像の再生成が暴発する) */
export function needsFrameExtract(clipMtimeMs: number, ffMtimeMs: number | null): boolean {
  return ffMtimeMs === null || clipMtimeMs > ffMtimeMs;
}

/** 見張り役への「生きている」印。**失敗しても例外を投げない**(見張りの都合で生成を止めない) */
export function touchHeartbeat(path = HEARTBEAT_FILE): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, new Date().toISOString() + "\n");
    const t = new Date();
    utimesSync(path, t, t);
  } catch {
    // heartbeat が止まれば見張りが無操作で Pod を落とすだけ
  }
}

/** 抜けるときの案内。正常終了・例外・割り込みのどれでも down を促す */
export function exitNotice(kind: "done" | "error" | "signal", signal?: string): string[] {
  const head = kind === "signal"
    ? "⚠️ " + (signal ?? "シグナル") + " で中断しました。生成中のクリップは保存されていません(次の h3:run で作り直されます)"
    : kind === "error" ? "⚠️ エラーで中断しました" : "";
  return [
    ...(head ? [head] : []),
    "※ Pod は動いたままです。作業を終えるときは必ず `npm run h3:pod -- down` を実行してください",
    "   状態の確認: `npm run h3:pod -- status`",
    "   (止め忘れても見張り役が無操作 30 分 / 起動から 6 時間(既定)で自動停止します)",
  ];
}

type Killable = { kill: (signal?: NodeJS.Signals | number) => boolean };

/**
 * SIGINT / SIGTERM の処理。子(batch.mjs)を止め、案内を出して 128+n で抜ける。
 * 子を止めないと、run-chapter が死んだあとも batch.mjs が heartbeat を打ち続けて見張りが落とせない。
 */
export function createInterruptHandler(deps: {
  getChild: () => Killable | null;
  log?: (m: string) => void;
  exit?: (code: number) => void;
}): (signal: NodeJS.Signals) => void {
  const log = deps.log ?? ((m: string) => console.error(m));
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  let handled = false;
  return (signal) => {
    const child = deps.getChild();
    try { child?.kill("SIGTERM"); } catch { /* 既に死んでいる */ }
    if (!handled) {
      handled = true;
      log("");
      for (const m of exitNotice("signal", signal)) log(m);
    }
    exit(signal === "SIGINT" ? 130 : 143);
  };
}

/**
 * 尺の読めないクリップ(書きかけ)を隔離する。batch.mjs は「ファイルがある」だけで飛ばすので、
 * 置いたままだと作り直されない。移した先を返す(移さなければ null)。
 */
export function quarantineUnusable(clipPath: string, rejectDir: string, id: string, usable: (p: string) => boolean = isUsable): string | null {
  if (!existsSync(clipPath) || usable(clipPath)) return null;
  mkdirSync(rejectDir, { recursive: true });
  const to = freeName(rejectDir, id);
  renameSync(clipPath, to);
  return to;
}

/** `--plan` の警告: 章内の下流クリップが起点クリップより古い(起点を作り直したのに下流が古いまま) */
export function staleChainWarnings(ledger: { chapters: { id: string; cuts: string[] }[]; cuts: Record<string, Cut> }, chapterId: string, mtimeOf: (id: string) => number | null): string[] {
  const inChapter = new Set(ledger.chapters.find((c) => c.id === chapterId)?.cuts ?? []);
  return findStaleChains(ledger, mtimeOf).filter((id) => inChapter.has(id)).map((id) => {
    const cut = ledger.cuts[id];
    let from = cut.chainFrom;
    if (!from) {
      for (const ch of ledger.chapters) {
        const at = ch.cuts.indexOf(id);
        if (at > 0) { from = ch.cuts[at - 1]; break; }
      }
    }
    return id + " は鎖の起点 " + from + " より古いクリップです(起点を作り直したあと下流を作り直していない)。" +
      "`npm run h3:reject -- <epId> " + id + "` で隔離して作り直す";
  });
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
  // クリップの方が新しいときだけ抽出し直す(毎回抽出すると ff の mtime が上がり、終点画像の再生成が暴発する)
  const ffMtime = existsSync(dest) ? statSync(dest).mtimeMs : null;
  if (needsFrameExtract(statSync(src).mtimeMs, ffMtime)) {
    execFileSync("ffmpeg", ["-v", "error", "-sseof", "-0.1", "-i", src, "-frames:v", "1", "-y", dest]);
  }
  return dest;
}

let currentChild: ReturnType<typeof spawn> | null = null;

/** batch.mjs を子として回す(割り込み時に止められるよう非同期で持つ) */
function runBatch(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", ["batch.mjs", ...args], { cwd: COMFY_CLI, stdio: "inherit" });
    currentChild = child;
    child.on("error", (e) => { currentChild = null; reject(e); });
    child.on("exit", (code, signal) => {
      currentChild = null;
      if (code === 0) resolvePromise();
      else reject(new Error("batch.mjs が " + (signal ? "シグナル " + signal : "exit " + code) + " で終了"));
    });
  });
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
  const regenEnd = orExit(() => parseRegenEnd(args));
  if (!epId || !chapterId) { console.error("使い方: npm run h3:run -- <epId> <章ID> [--plan|--dry] [--only cL01,cL02] [--seed 7] [--regen-end cL67,…] [--url <URL>]"); process.exit(2); }
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
  // 「存在する」ではなく「尺が読める」で生成済みを判定する(書きかけを完成品と誤認しない)
  const hasClip = (id: string): boolean => isUsable(join(CLIPS, id + ".mp4"));
  const existing = new Set(chapter.cuts.filter(hasClip));
  const pending = plan ? chapter.cuts : chapter.cuts.filter((id) => !existing.has(id));
  const targets = orExit(() => selectTargets(chapter.cuts, pending, only));

  // --regen-end が黙って無効になるのを防ぐ(生成済みは targets から外れる)
  const regenProblems = validateRegenEnd(regenEnd, targets, cutsFile.cuts);
  if (regenProblems.length > 0) {
    for (const m of regenProblems) console.error("❌ " + m);
    process.exit(2);
  }

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
    // keyframe カットは終点画像の**予定パス**を先に載せる(検査で FL2VA 行を見るため。実体は投入ループで作る)
    return buildJob(id, shots[id], cutsFile.cuts[id], vocab,
      from ? join(framesDir(epId), from + "-last.png") : undefined, seed,
      cutsFile.cuts[id].keyframe ? endFramePath(epId, id) : undefined);
  });
  const findings: Finding[] = [
    // 台帳と宣言の食い違いは「検査した文面」と「実際に投げる文面」を別物にする
    // (鎖の有無 = I2V 指示行の有無が変わる)。鎖は台帳から解決しているのでここで突合する
    ...targets.flatMap((id) => checkLedger(id, fullDecl(shots[id]), cutsFile.cuts[id])),
    ...targets.flatMap((id) => checkEndStateVocab(id, shots[id], cutsFile.cuts[id], vocab)),
    ...jobs.flatMap((j) => checkPromptText(j.id, j.prompt, {
      seconds: j.seconds, hasFirstFrame: Boolean(j.firstFrameFile), hasLastFrame: Boolean(j.lastFrameFile),
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
        (from ? " ← " + from : "") + (j.lastFrameFile ? " ⇒ " + basename(j.lastFrameFile) : "") + (existing.has(j.id) ? " (生成済み)" : ""));
    }
    const chained = jobs.filter((j) => Boolean(j.firstFrameFile)).length;
    const hi = jobs.filter((j) => j.width === SIZE_HI.width).length;
    console.log("内訳: 鎖 " + chained + "本 / 高解像度 " + hi + "本 / t2v " + (jobs.length - chained) + "本" +
      " / keyframe " + jobs.filter((j) => j.lastFrameFile).length + "本");
    for (const m of missing) {
      console.log("⚠️  " + m.id + " の鎖の起点 " + m.from + " がまだ生成されていません(この実行でも作られません)");
    }
    // 起点を作り直したのに下流が古いままの鎖(つなぎ目で絵が飛ぶ)
    const clipMtime = (id: string): number | null => {
      const p = join(CLIPS, id + ".mp4");
      return existsSync(p) ? statSync(p).mtimeMs : null;
    };
    for (const w of staleChainWarnings(cutsFile, chapterId, clipMtime)) console.log("⚠️  " + w.replace("<epId>", epId));
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

  const onSignal = createInterruptHandler({ getChild: () => currentChild });
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let outcome: "done" | "error" = "error";
  try {
    for (const job of jobs) {
      touchHeartbeat();
      // 書きかけ(尺が読めない)の mp4 が残っていると batch.mjs が飛ばすので、先に隔離する
      const moved = quarantineUnusable(join(CLIPS, job.id + ".mp4"), rejectedDir(epId), job.id);
      if (moved) console.log("⚠️  " + job.id + " は尺が読めない(書きかけ)ので隔離して作り直します → " + moved);
      const from = chain.get(job.id);
      if (from) {
        const ff = lastFrame(epId, from); // 実体を作る
        // 終点画像(lastFrameFile)はこの下の genEndFrame が作るので、ここでは始点だけを実在検査する
        // (予定パスのまま検査すると keyframe カットは必ずここで止まる。2026-09-22 ep044 cL92 実機で発覚)
        const exists = checkJobSet([{ ...job, firstFrameFile: ff, lastFrameFile: undefined }], { requireExists: true })
          .filter((f) => f.level === "BLOCK");
        if (exists.length > 0) throw new Error(job.id + ": " + exists[0].message);
        job.firstFrameFile = ff;
      }
      if (cutsFile.cuts[job.id].keyframe) {
        const size = cutsFile.cuts[job.id].hi ? SIZE_HI : SIZE_DEFAULT;
        job.lastFrameFile = genEndFrame({
          epId, cutId: job.id, refPng: job.firstFrameFile!, endState: shots[job.id].endState!,
          size, force: regenEnd.includes(job.id),
          // 鮮度は ff 画像ではなく起点クリップで見る(ff の抽出し直しで終点を作り直さない)
          ...(from ? { sourceClip: join(CLIPS, from + ".mp4") } : {}),
        });
        const ex = checkJobSet([job], { requireExists: true }).filter((f) => f.level === "BLOCK");
        if (ex.length > 0) throw new Error(job.id + ": " + ex[0].message);
      }
      const specPath = join(epDir, "jobs", "job-" + job.id + ".json");
      writeFileSync(specPath, JSON.stringify(jobSpecFor(job), null, 1) + "\n");
      await runBatch(["--jobs", specPath, "--out", CLIPS, "--url", resolvedUrl]);
      touchHeartbeat();
      // batch.mjs は全ジョブ失敗でも exit 0 を返すので、出力で判定する(存在ではなく尺が読めるか)
      if (!isUsable(join(CLIPS, job.id + ".mp4"))) {
        throw new Error(job.id + ": batch は終了したが使えるクリップが出ていない");
      }
    }
    outcome = "done";
    console.log(chapterId + ": 完了");
  } finally {
    // 以後 heartbeat は打たない(見張りの無操作判定で Pod が落ちる)
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    console.error("");
    for (const m of exitNotice(outcome)) console.error(m);
  }
}

if (process.argv[1] && basename(process.argv[1]) === "run-chapter.ts") await main();
