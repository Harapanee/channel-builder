/**
 * 日本語字幕の VTT を書く(焼かない回。h3Pipeline.burnSubtitles: false)。
 *   npm run h3:captions -- <epId>   → episodes/<epId>/publish/captions-ja.vtt
 * youtube:publish がこのファイルを見つけると YouTube 字幕(ja)として上げる。
 * 台本/TTS をやり直したら焼き直す(timing.json を読む)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildJaVtt, captionCues, type CaptionLine } from "./captions";
import { ROOT } from "./config";
import type { CutsFile } from "./types";

const epId = process.argv[2];
if (!epId) {
  console.error("使い方: npm run h3:captions -- <epId>");
  process.exit(2);
}
const timingPath = join(ROOT, "episodes", epId, "timing.json");
const cutsPath = join(ROOT, "h3/episodes", epId, "cuts.json");
if (!existsSync(timingPath)) {
  console.error("❌ timing.json がありません: " + timingPath);
  process.exit(1);
}
const lines = (JSON.parse(readFileSync(timingPath, "utf8")) as { lines: CaptionLine[] }).lines;
// noSub のカット(画面の中に同じ意味の文字がある)の行は字幕を出さない(焼き字幕と同じ)
const skip = new Set<string>();
if (existsSync(cutsPath)) {
  const cuts = (JSON.parse(readFileSync(cutsPath, "utf8")) as CutsFile).cuts;
  for (const c of Object.values(cuts)) if (c.noSub) c.lineIds.forEach((id) => skip.add(id));
}
const outDir = join(ROOT, "episodes", epId, "publish");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "captions-ja.vtt");
writeFileSync(out, buildJaVtt(lines, skip));
console.log("OK: " + out + "(" + captionCues(lines, skip).length + " cue / " + lines.length + " 行)");
