/**
 * 英語版の音を焼く: 行 WAV を timing の開始秒に置く → 声の大きさを揃える → 日本語版と同じ BGM/SE と混ぜる
 * (audio-cues.json の値をそのまま。SE の正規化はしない)→ 環境音があれば敷く → 動画の尺ちょうどの WAV。
 *   npx tsx src/pipeline/en/en-mix.ts <epId>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { buildMixArgs, type AudioCues } from "../audio-mix";
import { buildFinalArgs, buildPlacementArgs, mp3KbpsFor } from "./en-mix-args";
import { bedArgs, legacyBgmSegments, legacySeCues } from "./legacy-cues";
import type { TimingLike } from "./en-plan";

import {
  verifyFit,
  lock,
  snapshot,
  saveArtifact,
  assertDuration,
} from "./provenance";

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(2);
}
const epId = process.argv[2];
if (!epId) fail("usage: en-mix.ts <epId>");
const epDir = path.join("episodes", epId);
const outDir = path.join(epDir, "out", "en");
const release = lock(outDir);
verifyFit(epDir);
rmSync(path.join(outDir, "mix-manifest.json"), { force: true });
const timing: TimingLike = JSON.parse(
  readFileSync(path.join(epDir, "timing.json"), "utf8"),
);
const report = JSON.parse(
  readFileSync(path.join(outDir, "fit-report.json"), "utf8"),
) as { rewrite: { lineId: string; kind: string }[] };
/* はみ出し(shrink・話速で直りきらない speed)は次の行と声が重なるので止める。expand(早く終わる)は行間が空くだけなので警告に留める */
const blocking = report.rewrite.filter((r) => r.kind !== "expand");
if (blocking.length)
  fail(
    `次の行に食い込む行が残っています: ${blocking.map((r) => r.lineId).join(",")} — npm run en:tts の訳し直しを先に`,
  );
const expand = report.rewrite.length - blocking.length;
if (expand)
  console.log(
    `WARN: 日本語より早く終わる行が ${expand}行あります(行間が空く。直すなら fit-report.json の expand を訳し直し)`,
  );

const pieces = timing.lines.map((l) => {
  const file = path.join(outDir, "lines", `${l.lineId}.wav`);
  if (!existsSync(file)) fail(`行の音声がありません: ${file}`);
  return { file, startSec: l.startSec };
});
const total = timing.totalDurationSec;
const inputs = snapshot([
  path.join(epDir, "timing.json"),
  path.join(outDir, "speech-manifest.json"),
  path.join(outDir, "fit-report.json"),
  path.join(epDir, "audio-cues.json"),
  path.join(epDir, "shots.json"),
  path.join(epDir, "narration/ambient.wav"),
  "src/pipeline/en/en-mix.ts",
  "src/pipeline/en/en-mix-args.ts",
  "src/pipeline/en/legacy-cues.ts",
  "src/pipeline/audio-mix.ts",
  ...pieces.map((p) => p.file),
]);
const narr = path.join(outDir, "narration-en.wav");
execFileSync("ffmpeg", buildPlacementArgs(pieces, total, narr), {
  stdio: "inherit",
});

/* Remotion 回(ep003〜ep008)は audio-cues.json が無い → shots.json から BGM ベッドと SE を起こして out/en/audio-cues.legacy.json に書く */
const shotsPath = path.join(epDir, "shots.json");
if (!existsSync(path.join(epDir, "audio-cues.json")) && existsSync(shotsPath)) {
  const shots = JSON.parse(readFileSync(shotsPath, "utf8"));
  if (!shots.bgmTracks?.length)
    fail(
      "shots.json に bgmTracks がありません(単一 bgm 形式は未対応 — 見つかったら対応を足す)",
    );
  const segments = legacyBgmSegments(shots.bgmTracks);
  Object.assign(inputs, snapshot(segments.map((seg) => seg.file)));
  const bgm = segments.map((seg, i) => {
    const bed = path.join(outDir, `bed-${i}.wav`);
    execFileSync("ffmpeg", bedArgs(seg, bed), { stdio: "inherit" });
    return {
      id: `bed-${i}`,
      src: bed,
      start: seg.startSec,
      volume: seg.volume,
    };
  });
  writeFileSync(
    path.join(outDir, "audio-cues.legacy.json"),
    JSON.stringify(
      {
        total: timing.totalDurationSec,
        narration: "",
        bgm,
        se: legacySeCues(shots.shots),
      },
      null,
      1,
    ),
  );
}
const cuesPath = [
  path.join(epDir, "audio-cues.json"),
  path.join(outDir, "audio-cues.legacy.json"),
].find((p) => existsSync(p));
if (!cuesPath)
  fail("audio-cues.json がありません(Remotion 回は legacy-cues を先に)");
const spec: AudioCues = {
  ...JSON.parse(readFileSync(cuesPath, "utf8")),
  narration: narr,
  total,
};
for (const cue of [...spec.bgm, ...spec.se])
  if (!existsSync(cue.src)) fail(`音源がありません: ${cue.src}`);
Object.assign(inputs, snapshot([...spec.bgm, ...spec.se].map((c) => c.src)));
// Include original legacy assets as well as the rendered beds.
if (existsSync(shotsPath)) {
  const shots = JSON.parse(readFileSync(shotsPath, "utf8"));
  const collect = (v: any): string[] =>
    typeof v === "string" && existsSync(v)
      ? [v]
      : Array.isArray(v)
        ? v.flatMap(collect)
        : v && typeof v === "object"
          ? Object.values(v).flatMap(collect)
          : [];
  Object.assign(inputs, snapshot(collect(shots)));
}
const master = path.join(outDir, "master-en.wav");
/* buildMixArgs は mp3 向けの -b:a を含むが、出力が .wav なので PCM で書かれ効かない(音質は落ちない) */
execFileSync("ffmpeg", buildMixArgs(spec, master), { stdio: "inherit" });

const amb = path.join(epDir, "narration", "ambient.wav");
const out = path.join(outDir, "audio-en.wav");
execFileSync(
  "ffmpeg",
  buildFinalArgs(master, existsSync(amb) ? amb : null, total, out),
  { stdio: "inherit" },
);

const probe = spawnSync(
  "ffprobe",
  ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out],
  { encoding: "utf8" },
);
const d = Number(probe.stdout.trim());
assertDuration(d, out);
const peak = spawnSync(
  "ffmpeg",
  [
    "-hide_banner",
    "-nostats",
    "-i",
    out,
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ],
  { encoding: "utf8" },
).stderr.match(/max_volume:\s+(-?[\d.]+) dB/)?.[1];
console.log(
  `環境音: ${existsSync(amb) ? "あり" : "なし"} / 尺 ${d.toFixed(3)}秒(timing ${total.toFixed(3)})/ ピーク ${peak} dB`,
);
if (Math.abs(d - total) > 0.05) fail(`尺がずれています: ${d} vs ${total}`);
const mp3 = path.join(outDir, "audio-en.mp3");
const kbps = mp3KbpsFor(d);
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-v",
    "error",
    "-i",
    out,
    "-c:a",
    "libmp3lame",
    "-b:a",
    `${kbps}k`,
    "-ar",
    "48000",
    mp3,
  ],
  { stdio: "inherit" },
);
console.log(
  `OK: ${out}(Studio 用 ${mp3}・${kbps}kbps${kbps < 64 ? "・WARN 64kbps 未満" : ""})`,
);

saveArtifact(epDir, "mix", inputs, [out, mp3]);
release();
