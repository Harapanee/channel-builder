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
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { OUT_FPS, ROOT, clipsDir, epBase } from "./config";
import { ambientRecordPath, buildSegments, durationOf, runFfmpeg } from "./assemble";
import {
  ambientClipIds, ambientPieceArgs, ambientPlan, applyNoiseExclusion, flagNoisyClips, parseNoiseFloorDb, resolveAmbientConfig,
  unknownAmbientKeys,
} from "./ambient";
import { currentAmbientRecord } from "./freshness";
import type { AmbientRecord } from "./freshness";
import type { TimingLine } from "./plan";
import type { CutsFile } from "./types";

const SAMPLE_RATE = 48000;

/** クリップの音の noise floor(dBFS)。ffmpeg astats の Overall を stderr から読む。測れなければ null */
function measureNoiseFloorDb(path: string): number | null {
  const r = spawnSync("ffmpeg", ["-i", path, "-vn", "-af", "astats=measure_perchannel=none", "-f", "null", "-"],
    { encoding: "utf8" });
  if (r.status !== 0) return null;
  return parseNoiseFloorDb(r.stderr ?? "");
}

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
  let config = resolveAmbientConfig(raw);

  // exclude/perClip の打ち間違いを黙って握り潰さない(指摘3)。集合/レコードへの
  // Has/キー参照は存在しないIDを渡しても素通りするだけなので、ここで cuts.json と突き合わせる
  const unknown = unknownAmbientKeys(config, new Set(Object.keys(cutsFile.cuts)));
  if (unknown.length > 0) {
    console.error("❌ ambient.json の exclude/perClip に cuts.json に無いカットIDがあります: " + unknown.join(", "));
    process.exit(2);
  }

  const segments = buildSegments(cutsFile.cuts, timing.lines, timing.totalDurationSec, OUT_FPS);
  // 章カード(card)は exclude に書かなくても無音(2026-09-23 C3)
  const used = ambientClipIds(segments, config);
  const cardCount = segments.filter((s) => s.card).length;
  if (cardCount > 0) console.log("章カード " + cardCount + "本は自動で無音にします(exclude への手書きは不要)");

  // 何を読んで焼いたかの記録(C2)。読み始めの時点で取る(焼いている間に差し替わったら次の assemble が止める)。
  // 古い記録は先に消す — 途中で落ちたら「記録なし = 古い ambient.wav」の扱いに落ちる
  const clipOf = (s: { clipId: string }): string => join(clipsDir(epId), s.clipId + ".mp4");
  const record: AmbientRecord = currentAmbientRecord(ROOT, epId, segments, clipOf);
  rmSync(ambientRecordPath(epId), { force: true });

  const missing = used.filter((id) => !existsSync(join(clipsDir(epId), id + ".mp4")));
  if (missing.length > 0) {
    console.error("❌ クリップが無い: " + missing.slice(0, 10).join(", ") +
      (missing.length > 10 ? " ほか" + (missing.length - 10) + "件" : ""));
    process.exit(2);
  }

  // noise floor の検出(2026-09-18)。H3 は「steady wind + continuous rustle」の文面を広帯域ノイズ床として
  // 描く(ep039 実測)。文面側は check:h3 A13 が生成前に拾うが、実物も測って報告する。
  // autoExclude が真のときだけ無音に置換する(既定は報告のみ=従来の挙動)
  if (config.noiseFloorMaxDb !== null) {
    const floors: Record<string, number> = {};
    const unmeasured: string[] = [];
    for (const id of used) {
      const db = measureNoiseFloorDb(join(clipsDir(epId), id + ".mp4"));
      if (db === null) unmeasured.push(id); else floors[id] = db;
    }
    const flagged = flagNoisyClips(floors, config.noiseFloorMaxDb);
    if (unmeasured.length > 0) console.log("⚠️ noise floor を測れなかった: " + unmeasured.join(", "));
    if (flagged.length > 0) {
      console.log("⚠️ noise floor が " + config.noiseFloorMaxDb + " dB を超えるクリップ " + flagged.length + "本" +
        (config.autoExclude ? "(autoExclude: 無音に置換する)" : "(報告のみ。無音にするなら ambient.json の exclude か autoExclude: true)"));
      for (const f of flagged) console.log("   " + f.clipId + "  " + f.noiseFloorDb.toFixed(1) + " dB");
    } else {
      // 閾値は暫定(ep039 実測から)。境界付近を人が見られるよう、上位3本は常に出す
      const top = flagNoisyClips(floors, -Infinity).slice(0, 3).map((f) => f.clipId + " " + f.noiseFloorDb.toFixed(1) + " dB");
      console.log("noise floor: 全 " + used.length + "本が " + config.noiseFloorMaxDb + " dB 以下(上位: " + top.join(" / ") + ")");
    }
    config = applyNoiseExclusion(config, flagged);
  }

  const pieces = ambientPlan(segments, config);

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
      // skipHeadFrames ぶんは映像と同じく捨てる(C4)。形式の統一・apad は ambientPieceArgs が持つ
      runFfmpeg(ambientPieceArgs(p, p.clipId === null ? "" : join(clipsDir(epId), p.clipId + ".mp4"), dest, OUT_FPS, SAMPLE_RATE));
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
  const skipped = pieces.filter((p) => p.clipId !== null && p.skipHeadFrames > 0).length;
  if (skipped > 0) console.log("skipHeadFrames: " + skipped + "本は映像と同じく冒頭を捨てて使いました");
  writeFileSync(ambientRecordPath(epId), JSON.stringify(record, null, 1) + "\n");
  console.log("記録: " + ambientRecordPath(epId) + "(assemble がクリップの差し替え・入力の変更をここと突き合わせる)");
}

if (process.argv[1] && basename(process.argv[1]) === "build-ambient.ts") main();
