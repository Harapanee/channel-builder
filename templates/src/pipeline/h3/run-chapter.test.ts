import assert from "node:assert/strict";
import test from "node:test";
import { buildJob, declaredSeedOverrides, jobSpecFor, missingChainSources, onlyAlreadyGenerated, parseRegenEnd, parseSeed, resolveChain, selectTargets, validateRegenEnd } from "./run-chapter";
import { fl2vLine } from "./compose";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipsDir, framesDir } from "./config";
import { LORA, SAMPLER, SIGMA_SHIFT, STEPS, WORKFLOW } from "./config";
import { freeName } from "./reject-clips";
import type { Cut, ShotDecl, Vocab } from "./types";

const VOCAB: Vocab = {
  STYLE: "S.", CLOSE: "Nothing else appears in the frame at any point.",
  CLOSE_H: "H.", CLOSE_TEXT: "T.", CLOSEUP_GUARD: "G.",
  places: {}, subjects: {}, props: {},
};
const cut = (over: Partial<Cut> = {}): Cut => ({
  lineIds: ["L01"], seconds: 5.167, place: "SEA", subject: "ADULT", role: "導入", ...over,
});
const decl: ShotDecl = { body: "A wide shot of the sea. The camera holds a static shot.", sound: "A hum." };

test("既定は 1152x640 / seed 0", () => {
  const j = buildJob("cL01", decl, cut(), VOCAB);
  assert.equal(j.width, 1152);
  assert.equal(j.height, 640);
  assert.equal(j.seed, 0);
  assert.equal(j.seconds, 5.167);
});

test("hi のカットは 1344x768", () => {
  const j = buildJob("cL01", decl, cut({ hi: true }), VOCAB);
  assert.equal(j.width, 1344);
  assert.equal(j.height, 768);
});

test("first_frame があるときだけ I2VA の指示行が入る", () => {
  const withFF = buildJob("cL02", decl, cut({ chain: true }), VOCAB, "/tmp/cL01-last.png");
  assert.ok(withFF.prompt.startsWith("For the target video, at 0.00 seconds"));
  assert.equal(withFF.firstFrameFile, "/tmp/cL01-last.png");
  const without = buildJob("cL01", decl, cut(), VOCAB);
  assert.equal(without.firstFrameFile, undefined);
  assert.ok(!without.prompt.startsWith("For the target video"));
});

test("chain は章内の直前カットを起点にする", () => {
  const m = resolveChain(["cL01", "cL02", "cL03"], {
    cL01: cut(), cL02: cut({ chain: true }), cL03: cut({ chain: true }),
  });
  assert.equal(m.get("cL01"), null);
  assert.equal(m.get("cL02"), "cL01");
  assert.equal(m.get("cL03"), "cL02");
});

test("chainFrom は章をまたいで指定のカットを起点にする", () => {
  const m = resolveChain(["cL10", "cL11"], { cL10: cut({ chainFrom: "cL05" }), cL11: cut() });
  assert.equal(m.get("cL10"), "cL05");
  assert.equal(m.get("cL11"), null);
});

test("章の先頭で chain: true を指定したら例外(起点が無い)", () => {
  assert.throws(() => resolveChain(["cL01"], { cL01: cut({ chain: true }) }), /起点/);
});

test("クリップ置き場は epId ごとに分かれる", () => {
  assert.notEqual(clipsDir("ep015-salmon"), clipsDir("ep018-x"));
  assert.ok(clipsDir("ep018-x").includes("ep018-x"));
});

test("ep015-salmon だけは既存の 10-remake へ写像する(303本の再生成を避ける)", () => {
  assert.ok(clipsDir("ep015-salmon").endsWith("minimax-style/10-remake/clips"));
  assert.ok(framesDir("ep015-salmon").endsWith("minimax-style/10-remake/ff"));
});

// --- fix round 1: --only の絞り込み ---------------------------------------

test("--only 無しなら未生成のカットがそのまま対象", () => {
  assert.deepEqual(selectTargets(["cL01", "cL02", "cL03"], ["cL02", "cL03"]), ["cL02", "cL03"]);
});

test("--only は章のカット順を保って絞る(指定順ではない)", () => {
  const t = selectTargets(["cL01", "cL02", "cL03"], ["cL01", "cL02", "cL03"], ["cL03", "cL01"]);
  assert.deepEqual(t, ["cL01", "cL03"]);
});

test("--only に章へ無いIDを書いたら例外(誤字)", () => {
  assert.throws(() => selectTargets(["cL01", "cL02"], ["cL01"], ["cL99"]), /cL99/);
});

test("--only で生成済みのIDを指定しても対象は増えない", () => {
  assert.deepEqual(selectTargets(["cL01", "cL02"], ["cL02"], ["cL01", "cL02"]), ["cL02"]);
});

// --- 最終レビュー: --only が生成済みで落ちたことを黙らない -------------------

test("--only のIDが生成済みで対象から落ちたら列挙する", () => {
  const existing = new Set(["cL01"]);
  assert.deepEqual(onlyAlreadyGenerated(["cL01", "cL02"], ["cL02"], existing), ["cL01"]);
});

test("--only の全件が生成済みなら全件を列挙する(targets=0 で黙って終わらせない)", () => {
  const existing = new Set(["cL01", "cL02"]);
  assert.deepEqual(onlyAlreadyGenerated(["cL01", "cL02"], [], existing), ["cL01", "cL02"]);
});

test("対象に残っているIDは列挙しない(--plan は pending を絞らないので0件)", () => {
  const existing = new Set(["cL01", "cL02"]);
  assert.deepEqual(onlyAlreadyGenerated(["cL01"], ["cL01"], existing), []);
});

test("--only 無しなら列挙しない", () => {
  assert.deepEqual(onlyAlreadyGenerated(undefined, [], new Set(["cL01"])), []);
});

// --- fix round 1: 鎖の起点の実在 -------------------------------------------

const chainMap = (o: Record<string, string | null>): Map<string, string | null> => new Map(Object.entries(o));

test("起点クリップが実在すれば欠けにならない", () => {
  const m = missingChainSources(["cL02"], chainMap({ cL02: "cL01" }), (id) => id === "cL01");
  assert.deepEqual(m, []);
});

test("同じ実行で先に生成される起点は欠けにならない", () => {
  const m = missingChainSources(["cL01", "cL02"], chainMap({ cL01: null, cL02: "cL01" }), () => false);
  assert.deepEqual(m, []);
});

test("章をまたぐ起点が未生成なら欠けとして出る", () => {
  const m = missingChainSources(["cL135"], chainMap({ cL135: "cL118" }), () => false);
  assert.deepEqual(m, [{ id: "cL135", from: "cL118" }]);
});

test("起点が実行順のあとに来るなら欠け(逐次に回すので間に合わない)", () => {
  const m = missingChainSources(["cL02", "cL01"], chainMap({ cL02: "cL01", cL01: null }), () => false);
  assert.deepEqual(m, [{ id: "cL02", from: "cL01" }]);
});

// --- fix round 1: 隔離先の連番(較正の材料を上書きしない) -------------------

test("隔離先が空いていればそのままのID", () => {
  const dir = mkdtempSync(join(tmpdir(), "h3-reject-"));
  assert.equal(freeName(dir, "cL01"), join(dir, "cL01.mp4"));
});

test("同じIDを2度隔離しても先の隔離物を上書きしない", () => {
  const dir = mkdtempSync(join(tmpdir(), "h3-reject-"));
  writeFileSync(join(dir, "cL01.mp4"), "take-1");
  assert.equal(freeName(dir, "cL01"), join(dir, "cL01-2.mp4"));
  writeFileSync(join(dir, "cL01-2.mp4"), "take-2");
  assert.equal(freeName(dir, "cL01"), join(dir, "cL01-3.mp4"));
});

// --- seed を振る口(作り直しで別の絵を引く) -------------------------------

test("--seed が無ければ seed は 0(既定の挙動を変えない)", () => {
  assert.equal(parseSeed(["ep015-salmon", "chL01"]), undefined);
  assert.equal(buildJob("cL01", decl, cut(), VOCAB).seed, 0);
});

test("--seed <n> は数値として読む", () => {
  assert.equal(parseSeed(["ep015-salmon", "chL01", "--seed", "7"]), 7);
});

test("--seed に値が無ければ例外(黙って0に落とさない)", () => {
  assert.throws(() => parseSeed(["ep015-salmon", "chL01", "--seed"]), /--seed/);
});

test("--seed に整数でない値を書いたら例外", () => {
  assert.throws(() => parseSeed(["--seed", "abc"]), /--seed/);
  assert.throws(() => parseSeed(["--seed", "1.5"]), /--seed/);
  assert.throws(() => parseSeed(["--seed", "-1"]), /--seed/);
});

test("--seed は章の全ジョブへ適用する", () => {
  assert.equal(buildJob("cL01", decl, cut(), VOCAB, undefined, 7).seed, 7);
  assert.equal(buildJob("cL02", decl, cut(), VOCAB, undefined, 7).seed, 7);
});

test("宣言の seed は --seed より強い(1カットだけ振れる)", () => {
  assert.equal(buildJob("cL01", { ...decl, seed: 3 }, cut(), VOCAB, undefined, 7).seed, 3);
  assert.equal(buildJob("cL01", { ...decl, seed: 3 }, cut(), VOCAB).seed, 3);
});

test("章カードのカットでも宣言の seed は残る(chapterCard に潰されない)", () => {
  assert.equal(buildJob("cL01", { card: ["一", "海"], seed: 5 }, cut({ card: ["一", "海"] }), VOCAB).seed, 5);
});

test("宣言の seed が --seed を上書きしたカットを列挙する(黙って効かないを防ぐ)", () => {
  const shots: Record<string, ShotDecl> = { cL01: { ...decl, seed: 3 }, cL02: decl };
  assert.deepEqual(declaredSeedOverrides(["cL01", "cL02"], shots, 7), [{ id: "cL01", declared: 3 }]);
});

test("--seed と同じ値の宣言は上書きとして列挙しない", () => {
  const shots: Record<string, ShotDecl> = { cL01: { ...decl, seed: 7 } };
  assert.deepEqual(declaredSeedOverrides(["cL01"], shots, 7), []);
});

test("--seed が無ければ上書きの列挙もしない", () => {
  const shots: Record<string, ShotDecl> = { cL01: { ...decl, seed: 3 } };
  assert.deepEqual(declaredSeedOverrides(["cL01"], shots, undefined), []);
});

const JOB = { id: "cL01", prompt: "x", seconds: 5.17, width: 1152, height: 640, seed: 0 };

test("ジョブ仕様の defaults に steps・lora・sampler が載る", () => {
  const spec = jobSpecFor(JOB);
  if (WORKFLOW) {
    // 名前付きワークフロー経路では生成設定はワークフローJSONが持つ(二重指定は batch.mjs が止める)
    assert.equal(spec.defaults.workflow, WORKFLOW);
    for (const k of ["steps", "lora", "sampler", "sigmaShift"]) assert.equal(k in spec.defaults, false);
  } else {
    assert.equal(spec.defaults.steps, STEPS);
    assert.deepEqual(spec.defaults.lora, LORA);
    assert.equal(spec.defaults.sampler, SAMPLER);
  }
  assert.equal(spec.jobs.length, 1);
  assert.equal(spec.jobs[0].id, "cL01");
});

test("SIGMA_SHIFT が null ならキーごと落とす(ノードを生やさない意図を明示する)", () => {
  const spec = jobSpecFor(JOB);
  if (WORKFLOW || SIGMA_SHIFT === null) assert.equal("sigmaShift" in spec.defaults, false);
  else assert.deepEqual(spec.defaults.sigmaShift, SIGMA_SHIFT);
});

test("渡したジョブは書き換えられない(defaults は別のオブジェクト)", () => {
  const spec = jobSpecFor(JOB);
  assert.equal(spec.jobs[0], JOB);
  assert.equal("sampler" in JOB, false);
});

test("keyframe: lastFrameFile を渡すと FL2VA 行が付き、lastFrameFile が job に載る", () => {
  const j = buildJob("cL67", { ...decl, endState: "x".repeat(40) }, cut({ chain: true, keyframe: true, seconds: 7.4 }), VOCAB, "/tmp/cL66-last.png", undefined, "/tmp/cL67-end.png");
  assert.equal(j.firstFrameFile, "/tmp/cL66-last.png");
  assert.equal(j.lastFrameFile, "/tmp/cL67-end.png");
  assert.ok(j.prompt.startsWith(fl2vLine(7.4)));
});
test("--regen-end の読み取り", () => {
  assert.deepEqual(parseRegenEnd(["ep", "ch05", "--regen-end", "cL67,cL70"]), ["cL67", "cL70"]);
  assert.deepEqual(parseRegenEnd(["ep", "ch05"]), []);
  assert.throws(() => parseRegenEnd(["ep", "ch05", "--regen-end"]));
});

test("validateRegenEnd: 対象外(生成済み)と keyframe でない ID を止める", () => {
  const kf: Cut = { lineIds: ["L67"], seconds: 7.4, place: "P", subject: "S", role: "peak", chain: true, keyframe: true };
  const plain: Cut = { lineIds: ["L66"], seconds: 6.0, place: "P", subject: "S", role: "peak" };
  const cuts = { cL66: plain, cL67: kf, cL70: kf };
  assert.deepEqual(validateRegenEnd([], ["cL67"], cuts), []);
  assert.deepEqual(validateRegenEnd(["cL67"], ["cL67"], cuts), []);
  const notTarget = validateRegenEnd(["cL70"], ["cL67"], cuts);
  assert.equal(notTarget.length, 1);
  assert.match(notTarget[0], /cL70/);
  assert.match(notTarget[0], /npm run h3:reject -- <epId> cL70/);
  const notKf = validateRegenEnd(["cL66"], ["cL66", "cL67"], cuts);
  assert.equal(notKf.length, 1);
  assert.match(notKf[0], /cL66.*keyframe/);
  const unknown = validateRegenEnd(["cL99"], ["cL67"], cuts);
  assert.equal(unknown.length, 1);
});

// --- Pod・GPU の安全(2026-09-23 ストリーム B) ------------------------------------
import { createInterruptHandler, exitNotice, needsFrameExtract, quarantineUnusable, staleChainWarnings, touchHeartbeat } from "./run-chapter";
import { HEARTBEAT_FILE } from "./config";
import { existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";

test("B6: ff 画像が無ければ抽出する", () => {
  assert.equal(needsFrameExtract(1000, null), true);
});

test("B6: クリップの方が新しいときだけ抽出し直す(毎回抽出すると終点画像の再生成が暴発する)", () => {
  assert.equal(needsFrameExtract(2000, 1000), true);
  assert.equal(needsFrameExtract(1000, 2000), false);
  assert.equal(needsFrameExtract(1000, 1000), false);
});

test("heartbeat のパスは comfy-runpod の見張りが読むパスと一致する", async () => {
  // 別リポジトリの .mjs(型なし)。指定子を変数にして型解決させない
  const spec = "../../../../tools/comfy-runpod/lib/watchdog.mjs";
  const lib = (await import(spec)) as { HEARTBEAT_PATH: string };
  assert.equal(HEARTBEAT_FILE, lib.HEARTBEAT_PATH);
});

test("touchHeartbeat は mtime を今にする。失敗しても例外を投げない", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  const p = join(dir, ".heartbeat");
  touchHeartbeat(p);
  const old = new Date(Date.now() - 3600_000);
  utimesSync(p, old, old);
  touchHeartbeat(p);
  assert.ok(statSync(p).mtimeMs > old.getTime() + 1000);
  assert.doesNotThrow(() => touchHeartbeat("/dev/null/x/.heartbeat"));
});

test("B5: 抜けるときの案内は必ず down と status を出し、見張りの自動停止に触れる", () => {
  for (const kind of ["done", "error", "signal"] as const) {
    const text = exitNotice(kind, "SIGINT").join("\n");
    assert.match(text, /npm run h3:pod -- down/);
    assert.match(text, /npm run h3:pod -- status/);
    assert.match(text, /見張り/);
  }
  assert.match(exitNotice("signal", "SIGTERM").join("\n"), /SIGTERM/);
});

test("B5: 割り込みで子(batch.mjs)を止め、案内を出して 128+n で抜ける", () => {
  const killed: string[] = [];
  const logs: string[] = [];
  let code: number | undefined;
  const handler = createInterruptHandler({
    getChild: () => ({ kill: (s?: NodeJS.Signals | number) => { killed.push(String(s)); return true; } }),
    log: (m) => logs.push(m),
    exit: (c) => { code = c; },
  });
  handler("SIGINT");
  assert.deepEqual(killed, ["SIGTERM"]);
  assert.equal(code, 130);
  assert.match(logs.join("\n"), /h3:pod -- down/);
  handler("SIGTERM"); // 2度目も落ちない
});

test("B5: 子がいなくても案内を出して抜ける(SIGTERM は 143)", () => {
  let code: number | undefined;
  createInterruptHandler({ getChild: () => null, log: () => {}, exit: (c) => { code = c; } })("SIGTERM");
  assert.equal(code, 143);
});

test("B7: 尺の読めないクリップは隔離して作り直しの対象にする(batch は存在だけで飛ばすため)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qu-"));
  const clips = join(dir, "clips");
  const rej = join(dir, "rej");
  execFileSync("mkdir", ["-p", clips]);
  const broken = join(clips, "cL01.mp4");
  writeFileSync(broken, "half-written");
  const moved = quarantineUnusable(broken, rej, "cL01", () => false);
  assert.ok(moved && moved.startsWith(rej));
  assert.ok(!existsSync(broken));
  assert.deepEqual(readdirSync(rej), ["cL01.mp4"]);
  // 使えるクリップ・無いクリップは触らない
  writeFileSync(broken, "ok");
  assert.equal(quarantineUnusable(broken, rej, "cL01", () => true), null);
  assert.ok(existsSync(broken));
  assert.equal(quarantineUnusable(join(clips, "none.mp4"), rej, "none", () => false), null);
});

test("B8: --plan は章内の古い鎖を警告する(他章のものは出さない)", () => {
  const cutsFile = {
    chapters: [{ id: "ch00", title: "", name: "", cuts: ["cL01", "cL02"] }, { id: "ch01", title: "", name: "", cuts: ["cL03"] }],
    cuts: {
      cL01: cut(), cL02: cut({ chain: true }), cL03: cut({ chainFrom: "cL02" }),
    },
  };
  const mt: Record<string, number> = { cL01: 10, cL02: 5, cL03: 1 };
  const w0 = staleChainWarnings(cutsFile, "ch00", (id) => mt[id] ?? null);
  assert.equal(w0.length, 1);
  assert.match(w0[0], /cL02/);
  assert.match(w0[0], /cL01/);
  const w1 = staleChainWarnings(cutsFile, "ch01", (id) => mt[id] ?? null);
  assert.equal(w1.length, 1);
  assert.match(w1[0], /cL03/);
});
