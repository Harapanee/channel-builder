/**
 * 生成音を環境音トラックへまとめる。
 *   npm run h3:ambient -- <epId>
 *   → episodes/<epId>/narration/ambient.wav(総尺 = timing.totalDurationSec)
 *
 * **audio-mix.ts には触らない。** あちらはテンプレート同期区分 HF_IDENTICAL で
 * 1バイトも変えられず、さらに SE を1本ずつ -22 LUFS へ正規化するため、
 * 静かな環境音を SE キューとして渡すと持ち上がって鳴り続ける。
 * ナレーション+BGM(master.mp3)とは別トラックにして、assemble の最終 mux で混ぜる。
 *
 * exit: 0 = OK / 2 = 実行エラー
 */
import Ajv from "ajv";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { OUT_FPS, ROOT, clipsDir, epBase } from "./config";
import { buildSegments, durationOf, runFfmpeg } from "./assemble";
import { ambientPlan, resolveAmbientConfig, unknownAmbientKeys } from "./ambient";
import type { TimingLine } from "./plan";
import type { CutsFile } from "./types";

const SAMPLE_RATE = 48000;

function main(): void {
  const epId = process.argv[2];
  if (!epId) {
    console.error("使い方: npm run h3:ambient -- <epId>");
    process.exit(2);
  }
  const epDir = join(ROOT, "h3/episodes", epId);
  const timing = JSON.parse(
    readFileSync(join(ROOT, "episodes", epId, "timing.json"), "utf8"),
  ) as { totalDurationSec: number; lines: TimingLine[] };
  const cutsFile = JSON.parse(readFileSync(join(epDir, "cuts.json"), "utf8")) as CutsFile;

  // 設定(無ければ既定)。契約検査は Schema で行う
  const cfgPath = join(epDir, "ambient.json");
  const raw = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : undefined;
  if (raw) {
    const schema = JSON.parse(readFileSync(join(ROOT, "src/schemas/h3-ambient.schema.json"), "utf8"));
    const validate = new Ajv({ allErrors: true }).compile(schema);
    if (!validate(raw)) {
      console.error("❌ ambient.json が契約に合いません");
      for (const e of validate.errors ?? []) console.error("  " + e.instancePath + " " + e.message);
      process.exit(2);
    }
  }
  const config = resolveAmbientConfig(raw);

  // exclude/perClip の打ち間違いを黙って握り潰さない(指摘3)。集合/レコードへの
  // Has/キー参照は存在しないIDを渡しても素通りするだけなので、ここで cuts.json と突き合わせる
  const unknown = unknownAmbientKeys(config, new Set(Object.keys(cutsFile.cuts)));
  if (unknown.length > 0) {
    console.error("❌ ambient.json の exclude/perClip に cuts.json に無いカットIDがあります: " + unknown.join(", "));
    process.exit(2);
  }

  const segments = buildSegments(cutsFile.cuts, timing.lines, timing.totalDurationSec, OUT_FPS);
  const pieces = ambientPlan(segments, config);

  const missing = pieces
    .filter((p) => p.clipId && !existsSync(join(clipsDir(epId), p.clipId + ".mp4")))
    .map((p) => p.clipId);
  if (missing.length > 0) {
    console.error("❌ クリップが無い: " + missing.slice(0, 10).join(", ") +
      (missing.length > 10 ? " ほか" + (missing.length - 10) + "件" : ""));
    process.exit(2);
  }

  // 中間 wav は h3/episodes/<epId>/ (git 追跡下) ではなく epBase(epId)
  // (= scratchpad_gen/minimax-style/<epId>/、.gitignore 済み) に置く。
  // 248区間ぶんの中間 wav は合計250MB近くになり、途中で落ちると追跡対象に残ってしまう。
  const work = join(epBase(epId), "_ambient-work");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  let outPath: string;
  try {
    // 断片を1本ずつ wav へ。**すべて同じ形式にそろえる**(concat demuxer が -c copy で繋げる条件)
    const parts: string[] = [];
    pieces.forEach((p, i) => {
      const dest = join(work, String(i).padStart(4, "0") + ".wav");
      const seconds = (p.frames / OUT_FPS).toFixed(6);
      if (p.clipId === null) {
        runFfmpeg(["-y", "-f", "lavfi", "-i", "anullsrc=r=" + SAMPLE_RATE + ":cl=stereo",
          "-t", seconds, "-c:a", "pcm_s16le", dest]);
      } else {
        // apad + -t で「クリップが短い」場合も必ず区間ぶんの長さになる
        runFfmpeg(["-y", "-i", join(clipsDir(epId), p.clipId + ".mp4"), "-vn",
          "-af", "aresample=" + SAMPLE_RATE + ",apad,volume=" + p.gainDb + "dB",
          "-ac", "2", "-t", seconds, "-c:a", "pcm_s16le", dest]);
      }
      parts.push(dest);
    });

    const listPath = join(work, "list.txt");
    writeFileSync(listPath, parts.map((p) => "file '" + p + "'").join("\n") + "\n");
    outPath = join(ROOT, "episodes", epId, "narration", "ambient.wav");
    mkdirSync(join(ROOT, "episodes", epId, "narration"), { recursive: true });
    runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath]);
  } finally {
    // 248回の ffmpeg ループの途中で失敗しても、作業ディレクトリ(最大250MB近く)を
    // ディスクに残さない。残ったままだと次回実行冒頭の rmSync でしか消えず、
    // 実行を諦めた場合はENOSPC事故の火種になる(このリポジトリで過去に実際に起きた型)
    rmSync(work, { recursive: true, force: true });
  }

  // 自己検算。尺がずれると assemble が黙ってずれた音を載せる
  const got = durationOf(outPath);
  const want = timing.totalDurationSec;
  console.log("できました: " + outPath + "(" + got.toFixed(2) + "秒 / 台本の総尺 " + want.toFixed(2) + "秒)");
  console.log("敷き量 " + config.gainDb + "dB / 無音に置換 " +
    pieces.filter((p) => p.clipId === null).length + "本 / 全 " + pieces.length + "本");
  if (Math.abs(got - want) > 0.05) {
    console.error("❌ 尺が合いません(差 " + (got - want).toFixed(3) + "秒)");
    process.exit(2);
  }
}

if (process.argv[1] && basename(process.argv[1]) === "build-ambient.ts") main();
