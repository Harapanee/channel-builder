/** Immutable, content-addressed English publication package. No upload is performed. */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import {
  atomicJson,
  assertFiles,
  fileHash,
  hash,
  json,
  lock,
  verifyArtifact,
} from "./provenance";
export function packageSources(epDir: string) {
  return {
    "audio-en.mp3": path.join(epDir, "out/en/audio-en.mp3"),
    "subs-en.vtt": path.join(epDir, "out/en/subs-en.vtt"),
    "en.json": path.join(epDir, "en/en.json"),
    "mix-manifest.json": path.join(epDir, "out/en/mix-manifest.json"),
    "subs-manifest.json": path.join(epDir, "out/en/subs-manifest.json"),
    "speech-manifest.json": path.join(epDir, "out/en/speech-manifest.json"),
    "timing.json": path.join(epDir, "timing.json"),
    "fit-report.json": path.join(epDir, "out/en/fit-report.json"),
  };
}
export function assertPackageMatchesEpisode(epDir: string, m: any) {
  if (m.episodeId !== path.basename(path.resolve(epDir)))
    throw Error("package episode identity mismatch");
  const sources = packageSources(epDir);
  if (
    Object.keys(m.artifacts).sort().join("|") !==
    Object.keys(sources).sort().join("|")
  )
    throw Error("package required artifacts mismatch");
  for (const [name, file] of Object.entries(sources))
    if (fileHash(file) !== m.artifacts[name])
      throw Error(`package differs from current episode: ${name}`);
}
export function verifyPackageFiles(dir: string) {
  const m = json(path.join(dir, "manifest.json"));
  if (
    m.schema !== 1 ||
    typeof m.episodeId !== "string" ||
    !m.episodeId ||
    Object.keys(m.artifacts ?? {})
      .sort()
      .join("|") !== Object.keys(packageSources("")).sort().join("|") ||
    hash({ episodeId: m.episodeId, artifacts: m.artifacts }) !== m.id
  )
    throw Error("invalid package identity");
  for (const [name, digest] of Object.entries(m.artifacts)) {
    if (path.basename(name) !== name) throw Error("invalid package artifact");
    if (fileHash(path.join(dir, name)) !== digest)
      throw Error(`changed package artifact ${name}`);
  }
  return m;
}
export function verifyPackage(epDir: string, dir: string) {
  const m = verifyPackageFiles(dir);
  assertPackageMatchesEpisode(epDir, m);
  verifyArtifact(epDir, "mix");
  verifyArtifact(epDir, "subs");
  assertFiles(m.currentOutputs);
  return m;
}
export function createPackage(epDir: string) {
  const release = lock(path.join(epDir, "out/en"));
  try {
    const mix = verifyArtifact(epDir, "mix"),
      subs = verifyArtifact(epDir, "subs");
    const sources = packageSources(epDir);
    const artifacts = Object.fromEntries(
        Object.entries(sources).map(([n, p]) => [n, fileHash(p)]),
      ),
      id = hash({ episodeId: path.basename(path.resolve(epDir)), artifacts });
    const base = path.join(epDir, "publish/en/package"),
      dest = path.join(base, id);
    if (existsSync(dest)) {
      verifyPackage(epDir, dest);
      return dest;
    }
    mkdirSync(base, { recursive: true });
    const temp = path.join(base, `.${id}.${process.pid}`);
    mkdirSync(temp);
    try {
      for (const [n, p] of Object.entries(sources))
        copyFileSync(p, path.join(temp, n));
      atomicJson(path.join(temp, "manifest.json"), {
        schema: 1,
        id,
        episodeId: path.basename(path.resolve(epDir)),
        createdAt: new Date().toISOString(),
        artifacts,
        currentOutputs: {
          ...mix.outputs,
          ...subs.outputs,
          [sources["en.json"]]: artifacts["en.json"],
        },
      });
      renameSync(temp, dest);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    return dest;
  } finally {
    release();
  }
}
if (process.argv[1]?.endsWith("en-package.ts")) {
  const ep = process.argv[2];
  if (!ep) throw Error("usage: en-package.ts <epId> [--verify <package-dir>]");
  const i = process.argv.indexOf("--verify");
  console.log(
    i >= 0
      ? verifyPackage(path.join("episodes", ep), process.argv[i + 1])
      : createPackage(path.join("episodes", ep)),
  );
}
