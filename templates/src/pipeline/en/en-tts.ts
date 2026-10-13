/**
 * 英訳 → Kokoro で行ごとに合成 → 収まり判定。はみ出す行は話速を上げ、日本語より早く終わりすぎる行は
 * 話速を下げて1回だけ作り直す。それでも合わない行を fit-report.json の rewrite(kind: shrink=縮める /
 * expand=空白確認)に出す。shrink/speed は exit 1、expand のみは警告して exit 0(訳し直しは翻訳エージェントの仕事)。
 *   npx tsx src/pipeline/en/en-tts.ts <epId> [--only L03,L04] [--report-only] [--jobs 4]
 *   --jobs: 合成を N プロセスに分ける(既定 4)
 *   --report-only: 合成せず、既存の durations.json と話速で判定だけやり直す
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import {
  checkEnScript,
  fitDecision,
  fitExitCode,
  lineSlots,
  type EnScript,
  type TimingLike,
} from "./en-plan";

import {
  context,
  hash,
  fileHash,
  json,
  atomicJson,
  wavDuration,
  verifySpeech,
  fitBinding,
  lock,
  type SpeechManifest,
} from "./provenance";

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(2);
}

function main() {
  const epId = process.argv[2];
  if (!epId) fail("usage: en-tts.ts <epId> [--only L03,L04] [--report-only]");
  const reportOnly = process.argv.includes("--report-only");
  const jobsIdx = process.argv.indexOf("--jobs");
  const jobs = jobsIdx > 0 ? Number(process.argv[jobsIdx + 1]) : 4;
  const onlyIdx = process.argv.indexOf("--only");
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 32)
    fail("--jobs must be an integer 1..32");
  if (
    onlyIdx > 0 &&
    (!process.argv[onlyIdx + 1] || process.argv[onlyIdx + 1].startsWith("--"))
  )
    fail("missing --only line IDs");
  const only =
    onlyIdx > 0 ? new Set(process.argv[onlyIdx + 1].split(",")) : null;

  const epDir = path.join("episodes", epId);
  const timing: TimingLike = JSON.parse(
    readFileSync(path.join(epDir, "timing.json"), "utf8"),
  );
  const en: EnScript = JSON.parse(
    readFileSync(path.join(epDir, "en", "en.json"), "utf8"),
  );
  /* 合成は行しか使わない(タイトル・説明は公開パッケージの後で訳す=video-create E4) */
  const problems = checkEnScript(en, timing, { linesOnly: true });
  if (problems.length)
    fail(
      `英訳の検査に落ちています(npm run en:check -- ${epId} --lines-only):\n  ${problems.join("\n  ")}`,
    );
  const ctx = context(epDir);
  const voice = ctx.voice;
  const engine = { py: ctx.py, script: ctx.script };

  const outDir = path.join(epDir, "out", "en");
  const linesDir = path.join(outDir, "lines");
  mkdirSync(linesDir, { recursive: true });
  const reportPath = path.join(outDir, "fit-report.json");
  const release = lock(outDir);
  const manifestPath = path.join(outDir, "speech-manifest.json");
  const manifest: SpeechManifest = existsSync(manifestPath)
    ? json(manifestPath)
    : { schema: 1, lines: {} };
  if (manifest.schema !== 1) fail("unsupported speech manifest");
  const speeds: Record<string, number> = Object.fromEntries(
    Object.entries(manifest.lines).map(([id, r]) => [id, r.speed]),
  );
  const dur: Record<string, number> = Object.fromEntries(
    Object.entries(manifest.lines).map(([id, r]) => [id, r.duration]),
  );
  // Invalidate the fit before any mutation; failed synthesis must never leave valid-looking consumers.
  rmSync(reportPath, { force: true });

  function synth(
    items: { id: string; text: string; speed: number }[],
  ): Record<string, number> {
    const inPath = path.join(outDir, "_in.json");
    writeFileSync(inPath, JSON.stringify(items));
    execFileSync(
      engine.py,
      [
        engine.script,
        "--in",
        inPath,
        "--out-dir",
        linesDir,
        "--voice",
        voice.voice,
        "--lang",
        voice.lang,
        "--jobs",
        String(jobs),
        ...(voice.engine === "mlx" ? ["--model-dir", ctx.modelDir] : []),
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    for (const item of items) {
      const wav = path.join(linesDir, item.id + ".wav");
      const duration = wavDuration(wav);
      dur[item.id] = duration;
      manifest.lines[item.id] = {
        source: ctx.sources[item.id],
        key: hash(ctx.sources[item.id]),
        speed: item.speed,
        duration,
        wavHash: fileHash(wav),
      };
    }
    atomicJson(manifestPath, manifest);
    atomicJson(path.join(linesDir, "durations.json"), dur);
    return dur;
  }

  const slots = lineSlots(timing);
  if (only)
    for (const id of only)
      if (!slots.some((s) => s.lineId === id)) fail(`unknown line ${id}`);
  const changed = slots.filter((s) => {
    const r = manifest.lines[s.lineId],
      wav = path.join(linesDir, s.lineId + ".wav");
    return (
      process.argv.includes("--force") ||
      !r ||
      r.key !== hash(ctx.sources[s.lineId]) ||
      !existsSync(wav) ||
      fileHash(wav) !== r.wavHash
    );
  });
  if (reportOnly) verifySpeech(epDir, ctx);
  else {
    const selected = changed.filter((s) => !only || only.has(s.lineId));
    // Remove provenance before handing WAV files to the synthesizer (including retries).
    const run = (items: { id: string; text: string; speed: number }[]) => {
      if (!items.length) return;
      for (const item of items) delete manifest.lines[item.id];
      atomicJson(manifestPath, manifest);
      synth(items);
    };
    for (const s of selected) speeds[s.lineId] = 1;
    run(
      selected.map((s) => ({
        id: s.lineId,
        text: en.lines[s.lineId],
        speed: 1,
      })),
    );
    verifySpeech(epDir, ctx); // --only cannot bless stale lines outside its selection.
    for (let round = 1; round <= 3; round++) {
      const retry = slots
        .filter((s) => !only || only.has(s.lineId))
        .map((s) => ({
          s,
          f: fitDecision(s, dur[s.lineId], speeds[s.lineId] ?? 1, voice),
        }))
        .filter((x) => x.f.kind === "speed");
      if (!retry.length) break;
      for (const { s, f } of retry)
        if (f.kind === "speed") speeds[s.lineId] = f.speed;
      run(
        retry.map(({ s }) => ({
          id: s.lineId,
          text: en.lines[s.lineId],
          speed: speeds[s.lineId],
        })),
      );
    }
  }
  verifySpeech(epDir, ctx);
  // Keep duration compatibility file synchronized, but provenance remains the authority.
  atomicJson(path.join(linesDir, "durations.json"), dur);

  /* 全行で判定する(--only で一部だけ作り直した時も、前回の durations.json と合わせて全体を見る) */
  const rewrite = lineSlots(timing)
    .map((s) => ({
      s,
      f: fitDecision(s, dur[s.lineId], speeds[s.lineId] ?? 1.0, voice),
    }))
    .filter((x) => x.f.kind !== "ok")
    .map(({ s, f }) => ({
      lineId: s.lineId,
      /* speed が残るのは --report-only のときだけ(合成し直せば話速で直る見込みの行) */
      kind: f.kind,
      sec:
        Math.round(
          (f.kind === "expand"
            ? f.shortSec
            : f.kind === "shrink"
              ? f.overSec
              : 0) * 100,
        ) / 100,
      minWords: s.minWords,
      maxWords: s.maxWords,
      words: en.lines[s.lineId].split(/\s+/).length,
    }));
  atomicJson(reportPath, { binding: fitBinding(epDir, ctx), speeds, rewrite });
  release();
  const n = (k: string) => rewrite.filter((r) => r.kind === k).length;
  console.log(
    `話速を変えた行 ${Object.keys(speeds).length} / 縮める行 ${n("shrink")} / 空白を確認する行 ${n("expand")} / 話速で直る見込み ${n("speed")}`,
  );
  rewrite.forEach((r) =>
    console.log(
      `  ${r.kind.toUpperCase()} ${r.lineId} ${r.kind === "expand" ? `不足${r.sec}秒 ` : r.kind === "shrink" ? `超過${r.sec}秒 ` : ""}目安${r.minWords}〜${r.maxWords}語 現在${r.words}語`,
    ),
  );
  if (n("expand"))
    console.warn(
      "WARN: 英語が早く終わる行は試聴で空白を確認してください。加筆は必須ではありません。",
    );
  process.exit(fitExitCode(rewrite));
}
try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
