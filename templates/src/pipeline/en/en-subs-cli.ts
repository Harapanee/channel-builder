/**
 * 英語字幕を焼く: timing の開始秒 × 英語音声の実測の行尺 × en.json の行 → out/en/subs-en.vtt
 *   npx tsx src/pipeline/en/en-subs-cli.ts <epId> [--top]   (既定=位置指定なし=画面下。--top=画面上部 line:5%。日本語の焼き字幕がある旧回用)
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  verifyFit,
  lock,
  snapshot,
  saveArtifact,
  hash,
  json,
} from "./provenance";
import { alignedCues } from "./en-alignment";
import { vttTime, buildVtt } from "./en-subs";
import type { EnScript, TimingLike } from "./en-plan";

const epId = process.argv[2];
if (!epId) {
  console.error("usage: en-subs-cli.ts <epId> [--top]");
  process.exit(2);
}
const epDir = path.join("episodes", epId);
const outDir = path.join(epDir, "out", "en");
const release = lock(outDir);
const verified = verifyFit(epDir);
const timing: TimingLike = JSON.parse(
  readFileSync(path.join(epDir, "timing.json"), "utf8"),
);
const en = JSON.parse(
  readFileSync(path.join(epDir, "en", "en.json"), "utf8"),
) as EnScript;
const durations: Record<string, number> = Object.fromEntries(
  Object.entries(verified.m.lines).map(([id, r]) => [id, r.duration]),
);
const out = path.join(outDir, "subs-en.vtt");
const ai = process.argv.indexOf("--alignment");
const alignmentPath = ai >= 0 ? process.argv[ai + 1] : null;
if (ai >= 0 && !alignmentPath) throw Error("missing --alignment file");
const inputs = snapshot([
  path.join(epDir, "en/en.json"),
  path.join(epDir, "timing.json"),
  path.join(outDir, "speech-manifest.json"),
  "src/pipeline/en/en-subs.ts",
  "src/pipeline/en/en-subs-cli.ts",
  "src/pipeline/en/en-alignment.ts",
  ...(alignmentPath ? [alignmentPath] : []),
]);
let vtt = buildVtt(timing.lines, en.lines, durations, {
  top: process.argv.includes("--top"),
});
if (alignmentPath) {
  const alignment = json(alignmentPath);
  if (
    alignment.schema !== 1 ||
    alignment.method !== "measured-word-alignment" ||
    !alignment.producer
  )
    throw Error(
      "alignment requires schema 1, method measured-word-alignment, producer",
    );
  const cues = timing.lines.flatMap((l) => {
    const a = alignment.lines?.[l.lineId],
      r = verified.m.lines[l.lineId];
    if (
      !a ||
      a.wavHash !== r.wavHash ||
      a.textHash !== hash(en.lines[l.lineId])
    )
      throw Error(`stale alignment ${l.lineId}`);
    return alignedCues(en.lines[l.lineId], a.words, r.duration).map(
      (c) =>
        `${vttTime(l.startSec + c.start)} --> ${vttTime(l.startSec + c.end)}${process.argv.includes("--top") ? " line:5%" : ""}\n${c.text}`,
    );
  });
  vtt = `WEBVTT\n\n${cues.join("\n\n")}\n`;
} else
  console.warn(
    "WARN: word alignment unknown; original line timing preserved. Use en:qa for long subtitles and reading speed.",
  );
writeFileSync(out, vtt);
console.log(`OK: ${out}(${timing.lines.length}行)`);

saveArtifact(epDir, "subs", inputs, [out]);
release();
