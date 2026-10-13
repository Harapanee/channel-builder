/** Fail-closed provenance shared by synthesis, mix, subtitles and publication preflight. */
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { TimingLike, EnScript } from "./en-plan";
const canonical = (v: any): any =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
export const hash = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
export const fileHash = (p: string) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");
export const sourceKey = hash;
export const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
export function atomicJson(p: string, v: unknown) {
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n");
  renameSync(tmp, p);
}
export function assertDuration(v: unknown, id: string): asserts v is number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
    throw Error(`${id}: invalid/missing duration`);
}
export function wavDuration(p: string) {
  const d = Number(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
      { encoding: "utf8" },
    ).trim(),
  );
  assertDuration(d, p);
  return d;
}
export function assertFiles(files: Record<string, string | null>) {
  for (const [p, h] of Object.entries(files))
    if ((existsSync(p) ? fileHash(p) : null) !== h)
      throw Error(`stale/missing input: ${p}`);
}
export function snapshot(paths: string[]) {
  return Object.fromEntries(
    [...new Set(paths)].map((p) => [p, existsSync(p) ? fileHash(p) : null]),
  );
}
export function lock(out: string) {
  mkdirSync(out, { recursive: true });
  const p = path.join(out, ".write-lock");
  try {
    mkdirSync(p);
  } catch {
    throw Error(
      `English writer already active (or interrupted lock; inspect before removal): ${p}`,
    );
  }
  writeFileSync(
    path.join(p, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  let released = false;
  const onInterrupt = () => process.exit(130);
  const onTerminate = () => process.exit(143);
  const release = () => {
    if (!released) {
      rmSync(p, { recursive: true, force: true });
      released = true;
      process.off("exit", release);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
  };
  process.once("exit", release);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  return release;
}
export function context(epDir: string) {
  const timing: TimingLike = json(path.join(epDir, "timing.json")),
    en: EnScript = json(path.join(epDir, "en/en.json")),
    voice = json("channel/english/voice-en.json");
  const name = voice.engine ?? "onnx";
  if (!["mlx", "onnx"].includes(name)) throw Error(`unknown engine ${name}`);
  const py = path.join(
    os.homedir(),
    name === "mlx"
      ? ".cache/en-dub/mlx-venv/bin/python"
      : ".cache/en-dub/.venv/bin/python",
  );
  const script = `scripts/en-dub/${name === "mlx" ? "kokoro_mlx_lines" : "kokoro_lines"}.py`;
  // Installed distribution versions are cheap to read; never load the model for verification.
  const version = execFileSync(
    py,
    [
      "-c",
      "import importlib.metadata as m,json; print(json.dumps({d.metadata['Name']:d.version for d in m.distributions()},sort_keys=True))",
    ],
    { encoding: "utf8" },
  ).trim();
  const modelRoot =
    name === "mlx"
      ? path.join(
          os.homedir(),
          ".cache/huggingface/hub/models--prince-canuma--Kokoro-82M",
        )
      : path.join(os.homedir(), ".cache/en-dub/model");
  const revision =
    name === "mlx"
      ? readFileSync(path.join(modelRoot, "refs/main"), "utf8").trim()
      : "onnx-v1.0";
  const modelDir =
    name === "mlx" ? path.join(modelRoot, "snapshots", revision) : modelRoot;
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)],
    );
  const modelFiles =
    name === "mlx"
      ? walk(modelDir)
      : ["kokoro-v1.0.onnx", "voices-v1.0.bin"].map((f) =>
          path.join(modelDir, f),
        );
  const model = Object.fromEntries(
    modelFiles.map((p) => [path.relative(modelDir, p), fileHash(p)]),
  );
  const synth = {
    script,
    sha256: fileHash(script),
    runtime: hash(version),
    python: fileHash(py),
    model: { revision, files: model },
  };
  const sources = Object.fromEntries(
    timing.lines.map((l) => [
      l.lineId,
      { ja: l.text, en: en.lines[l.lineId], voice, synth },
    ]),
  );
  return { timing, en, voice, py, script, sources, modelDir };
}
export interface SpeechManifest {
  schema: 1;
  lines: Record<
    string,
    {
      source: unknown;
      key: string;
      speed: number;
      duration: number;
      wavHash: string;
    }
  >;
}
export function verifySpeech(epDir: string, ctx = context(epDir)) {
  const out = path.join(epDir, "out/en"),
    m: SpeechManifest = json(path.join(out, "speech-manifest.json"));
  if (m.schema !== 1) throw Error("unsupported speech provenance");
  for (const l of ctx.timing.lines) {
    const r = m.lines[l.lineId];
    if (!r || r.key !== hash(ctx.sources[l.lineId]))
      throw Error(`stale/untracked speech: ${l.lineId}; run en:tts`);
    assertDuration(r.duration, l.lineId);
    assertDuration(r.speed, l.lineId);
    if (fileHash(path.join(out, "lines", l.lineId + ".wav")) !== r.wavHash)
      throw Error(`changed WAV: ${l.lineId}`);
  }
  return m;
}
export function fitBinding(epDir: string, ctx = context(epDir)) {
  const m = verifySpeech(epDir, ctx);
  return hash({
    timing: ctx.timing,
    lines: m.lines,
    voice: ctx.voice,
    planner: fileHash("src/pipeline/en/en-plan.ts"),
  });
}
export function verifyFit(epDir: string) {
  const ctx = context(epDir),
    m = verifySpeech(epDir, ctx),
    r = json(path.join(epDir, "out/en/fit-report.json"));
  if (r.binding !== fitBinding(epDir, ctx))
    throw Error("stale fit report; run en:tts --report-only");
  if (r.rewrite.some((x: any) => x.kind !== "expand"))
    throw Error("English speech still overflows; resolve fit report");
  return { ctx, m, report: r };
}
export function saveArtifact(
  epDir: string,
  kind: "mix" | "subs",
  inputs: Record<string, string | null>,
  outputs: string[],
) {
  assertFiles(inputs);
  atomicJson(path.join(epDir, `out/en/${kind}-manifest.json`), {
    schema: 1,
    fitBinding: verifyFit(epDir).report.binding,
    inputs,
    outputs: snapshot(outputs),
  });
}
export function verifyArtifact(epDir: string, kind: "mix" | "subs") {
  const fit = verifyFit(epDir),
    m = json(path.join(epDir, `out/en/${kind}-manifest.json`));
  if (m.schema !== 1 || m.fitBinding !== fit.report.binding)
    throw Error(`stale ${kind}`);
  assertFiles(m.inputs);
  assertFiles(m.outputs);
  return m;
}
