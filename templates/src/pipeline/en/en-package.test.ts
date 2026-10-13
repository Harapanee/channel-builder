import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileHash, hash, atomicJson } from "./provenance";
import {
  verifyPackageFiles,
  verifyPackage,
  packageSources,
  assertPackageMatchesEpisode,
} from "./en-package";
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "en-package-")),
    ep = path.join(root, "ep-a"),
    dir = path.join(root, "package");
  mkdirSync(dir);
  const artifacts: Record<string, string> = {};
  for (const [name, file] of Object.entries(packageSources(ep))) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, name);
    writeFileSync(path.join(dir, name), name);
    artifacts[name] = fileHash(file);
  }
  const manifest = {
    schema: 1,
    episodeId: "ep-a",
    id: hash({ episodeId: "ep-a", artifacts }),
    artifacts,
  };
  atomicJson(path.join(dir, "manifest.json"), manifest);
  return { root, ep, dir, manifest };
}
it("archived package can be checked without working WAVs and detects tampering", () => {
  const f = fixture();
  verifyPackageFiles(f.dir);
  writeFileSync(path.join(f.dir, "audio-en.mp3"), "changed");
  assert.throws(() => verifyPackageFiles(f.dir));
  rmSync(f.root, { recursive: true, force: true });
});
it("publication preflight rejects another episode even with identical valid package bytes", () => {
  const f = fixture();
  assertPackageMatchesEpisode(f.ep, f.manifest);
  assert.throws(
    () => verifyPackage(path.join(f.root, "ep-b"), f.dir),
    /episode identity/,
  );
  rmSync(f.root, { recursive: true, force: true });
});
it("same audio with changed provenance is rejected, and required files cannot be omitted", () => {
  const f = fixture();
  writeFileSync(packageSources(f.ep)["speech-manifest.json"], "changed");
  assert.throws(
    () => assertPackageMatchesEpisode(f.ep, f.manifest),
    /speech-manifest/,
  );
  delete f.manifest.artifacts["timing.json"];
  f.manifest.id = hash({
    episodeId: f.manifest.episodeId,
    artifacts: f.manifest.artifacts,
  });
  atomicJson(path.join(f.dir, "manifest.json"), f.manifest);
  assert.throws(() => verifyPackageFiles(f.dir));
  rmSync(f.root, { recursive: true, force: true });
});
