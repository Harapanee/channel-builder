/**
 * ナレーション + BGM + SE を1本のマスター音源に焼く(HF経路の音声工程)。
 *
 * なぜ工程として要るか:
 *   これまで音声ミックスは ep009 で場当たりに発明され、以後は毎回手作業で再現していた
 *   (ep011 は .audio-build.py という使い捨てスクリプトを残している)。工程として
 *   どのスキルにも書かれていなかったため、ep012 では**誰も実行せず**、全編BGM/SEなしの
 *   まま check緑 → レンダー → 承認 → コミットまで通った。手順を1コマンドに固定する。
 *
 * なぜ1本に畳むか(ep009 の実測に由来):
 *   HyperFrames の check(runtimeパス)は各 <audio> の loadedmetadata をページ遷移予算内で
 *   待つ。clip数の多い重量級 composition では音源が2本以上になるだけで Navigation timeout に
 *   なる。中身・タイミング・音量は audio-cues.json から忠実に再現するので、個別 <audio> を
 *   並べた場合とレンダー結果は等価(HF render も ffmpeg で同じ合成をする)。
 *
 * 使い方:
 *   npx tsx src/pipeline/audio-mix.ts episodes/<epId> [--skip-normalize]
 *   → <epDir>/narration/master.mp3 を出力する。<audio src> はこれを指すこと。
 *
 * 入力: <epDir>/audio-cues.json
 *   { total: 秒, narration: "パス", bgm: [キュー], se: [キュー] }
 *   キュー = { id, src, start, volume, duration?, mediaStart? }
 *
 * exit: 0 = OK / 2 = 実行エラー
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

export interface AudioCue {
  id?: string;
  src: string;
  start: number;
  volume: number;
  duration?: number;
  mediaStart?: number;
}

export interface AudioCues {
  total: number;
  narration: string;
  bgm: AudioCue[];
  se: AudioCue[];
}

/** SE の実効ラウドネスを揃える目標値。ナレーション(実測 -14.7 LUFS)の約7dB下 */
export const TARGET_SE_LUFS = -22;
/**
 * EBU R128 の integrated は 400ms のゲーティングブロックを要するため、それより短い素材
 * (pop-3-nyu = 0.22s)は I=-70 LUFS と報告されて使えない。その場合は volumedetect の
 * mean_volume にこのオフセットを足した推定値を使う(両方測れる素材9点での I - mean の中央値)。
 */
export const SHORT_SE_OFFSET = 3.5;
/** 素材を持ち上げる方向はクリップを避けるため頭打ちにする */
export const MAX_SE_GAIN = 1.0;

/** 実測ラウドネスから目標へ合わせるゲインを求める(純粋関数) */
export function gainForLufs(measuredLufs: number, targetLufs = TARGET_SE_LUFS): number {
  const raw = 10 ** ((targetLufs - measuredLufs) / 20);
  return Math.min(MAX_SE_GAIN, Math.round(raw * 1000) / 1000);
}

/** ミックスの ffmpeg 入力・フィルタを組み立てる(純粋関数 — 実行はしない) */
export function buildMixArgs(spec: AudioCues, outFile: string): string[] {
  const cues: AudioCue[] = [
    { src: spec.narration, start: 0, volume: 1.0 },
    ...spec.bgm,
    ...spec.se,
  ];
  const inputs: string[] = [];
  const chains: string[] = [];
  cues.forEach((cue, i) => {
    if (cue.mediaStart != null) inputs.push("-ss", String(cue.mediaStart));
    if (cue.duration != null) inputs.push("-t", String(cue.duration));
    inputs.push("-i", cue.src);
    const delayMs = Math.max(0, Math.round(cue.start * 1000));
    chains.push(
      `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,` +
        `volume=${cue.volume},adelay=${delayMs}|${delayMs}[a${i}]`
    );
  });
  const labels = cues.map((_, i) => `[a${i}]`).join("");
  /* normalize=0: 各キューは volume で調整済みなので分割せず総和する。apad で尺いっぱいまで無音延長 */
  const mix = `${labels}amix=inputs=${cues.length}:normalize=0:dropout_transition=0,apad[m]`;
  return [
    "-y", "-v", "error",
    ...inputs,
    "-filter_complex", [...chains, mix].join(";"),
    "-map", "[m]", "-t", spec.total.toFixed(3),
    "-ar", "48000", "-ac", "2", "-b:a", "192k", outFile,
  ];
}

/* ----------------------------- 以下 CLI(I/O) ----------------------------- */

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

function ffmpegStderr(src: string, filter: string): string {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", src, "-af", filter, "-f", "null", "-"], {
    encoding: "utf8",
  });
  if (r.error) throw r.error;
  return r.stderr ?? "";
}

function measureLufs(src: string): { lufs: number; method: string } {
  const i = Number(ffmpegStderr(src, "ebur128=framelog=quiet").match(/I:\s+(-?[\d.]+) LUFS/)?.[1] ?? NaN);
  if (Number.isFinite(i) && i > -60) return { lufs: i, method: "ebur128" };
  const mean = Number(ffmpegStderr(src, "volumedetect").match(/mean_volume:\s+(-?[\d.]+) dB/)?.[1] ?? NaN);
  return { lufs: mean + SHORT_SE_OFFSET, method: "mean+off" };
}

/** SE の volume を素材ごとの実測ラウドネスから揃え直し、cues.json を書き戻す */
function normalizeSeGain(spec: AudioCues, cuesPath: string): void {
  const gains = new Map<string, number>();
  for (const src of [...new Set(spec.se.map((c) => c.src))].sort()) {
    const { lufs, method } = measureLufs(src);
    const vol = gainForLufs(lufs);
    gains.set(src, vol);
    console.log(`  ${path.basename(src).padEnd(24)} I=${lufs.toFixed(1).padStart(6)} LUFS (${method})  vol=${vol}`);
  }
  let changed = 0;
  for (const cue of spec.se) {
    const g = gains.get(cue.src)!;
    if (cue.volume !== g) {
      cue.volume = g;
      changed++;
    }
  }
  writeFileSync(cuesPath, JSON.stringify(spec, null, 1) + "\n");
  console.log(`SE音量を ${TARGET_SE_LUFS} LUFS へ揃えた(${changed}/${spec.se.length} 件を更新)`);
}

function main(): void {
  const epArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!epArg) fail("使い方: npx tsx src/pipeline/audio-mix.ts episodes/<epId> [--skip-normalize]");
  const epDir = path.resolve(process.cwd(), epArg);
  const cuesPath = path.join(epDir, "audio-cues.json");
  if (!existsSync(cuesPath)) {
    fail(
      `audio-cues.json がありません: ${cuesPath}\n` +
        `  BGM/SEの設計(storyboard の clip表「SE」列と BGM 節)から先に cues を起こしてください。`
    );
  }
  const spec: AudioCues = JSON.parse(readFileSync(cuesPath, "utf8"));
  if (!existsSync(spec.narration)) fail(`ナレーションがありません: ${spec.narration}(先に npm run tts)`);
  for (const cue of [...spec.bgm, ...spec.se]) {
    if (!existsSync(cue.src)) fail(`音源がありません: ${cue.src}(${cue.id ?? "id無し"})`);
  }

  if (!process.argv.includes("--skip-normalize")) normalizeSeGain(spec, cuesPath);

  const outFile = path.join(path.dirname(spec.narration), "master.mp3");
  execFileSync("ffmpeg", buildMixArgs(spec, outFile), { stdio: ["ignore", "inherit", "inherit"] });
  console.log(
    `OK: ${outFile} — narration + BGM ${spec.bgm.length}区間 + SE ${spec.se.length}件 → ${spec.total.toFixed(2)}s`
  );
  console.log(`   composition.html の <audio src> がこの master を指しているか npm run check:audio で確認すること`);
}

/* テストから import したときは走らせない */
if (process.argv[1] && path.basename(process.argv[1]) === "audio-mix.ts") main();
