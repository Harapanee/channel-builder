#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateEpisode } from "./validate-shots";
import type { ShotsFile } from "../schemas/types";

/**
 * §10.1 Mechanical QA(コード、`src/pipeline/qa.ts`)。
 *
 * `out/preview.mp4`(なければ `out/final.mp4`)に対して機械検査を7項目行い、
 * `review/qa-report.json` を出力する。全passならexit 0、いずれか失敗でexit 1。
 *
 * 7チェック(仕様書 §10.1 の表に対応):
 *  1. black_frames    ffmpeg blackdetect(d=0.1)で黒フレーム区間を検出。0件でpass
 *  2. silence         ffmpeg silencedetect で2.0秒超の無音区間を検出。0件でpass
 *  3. duration_match  動画実長とnarration.durationSecの差が0.5秒以内
 *  4. loudness        ffmpeg loudnorm(計測モード)の統合ラウドネスが-14 LUFS ±1
 *  5. resolution_fps  ffprobeで1920x1080 / 30fps
 *  6. assets_resolved validate-shots.ts の検証(スキーマ+ビジネスルール全項目)を
 *                     再実行し、レンダリング前検査が今も通ることを再確認する
 *  7. frozen_video    ffmpeg freezedetect で3.0秒超の完全静止区間を検出。0件でpass
 *
 * silenceのノイズ床(-30dB)は仕様書に明記がないため、実運用上の無音判定
 * しきい値として本実装で選択した値(§10.1は秒数閾値のみ規定)。
 */

export class QaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaError";
  }
}

export type QaCheckId =
  | "black_frames"
  | "silence"
  | "duration_match"
  | "loudness"
  | "resolution_fps"
  | "assets_resolved"
  | "frozen_video";

export type QaCheckResult = {
  id: QaCheckId;
  pass: boolean;
  detail?: string;
};

export type QaReport = {
  episodeId: string;
  pass: boolean;
  checks: QaCheckResult[];
};

// ---- 閾値(仕様書 §10.1 / §9) --------------------------------------------

const BLACKDETECT_MIN_DURATION_SEC = 0.1;
const SILENCE_MIN_DURATION_SEC = 2.0;
const SILENCE_NOISE_FLOOR_DB = -30;
const FROZEN_MIN_DURATION_SEC = 3.0;
const LOUDNESS_TARGET_LUFS = -14;
const LOUDNESS_TOLERANCE_LUFS = 1;
const DURATION_TOLERANCE_SEC = 0.5;
const EXPECTED_WIDTH = 1920;
const EXPECTED_HEIGHT = 1080;
const EXPECTED_FPS = 30;
const FPS_TOLERANCE = 0.05;

// ---- ffmpeg/ffprobe 実行ヘルパー ------------------------------------------

function spawnAsync(
  cmd: string,
  args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => resolve({ status: null, stdout, stderr, error }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function runFfmpeg(args: string[], checkLabel: string): Promise<string> {
  const result = await spawnAsync("ffmpeg", ["-hide_banner", ...args]);
  if (result.error) {
    throw new QaError(
      `[${checkLabel}] ffmpeg の実行に失敗しました: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new QaError(
      `[${checkLabel}] ffmpeg が異常終了しました (exit ${result.status}): ` +
        `${(result.stderr ?? "").slice(-2000)}`
    );
  }
  return result.stderr ?? "";
}

async function runFfprobeJson<T>(args: string[], checkLabel: string): Promise<T> {
  const result = await spawnAsync("ffprobe", ["-v", "error", "-of", "json", ...args]);
  if (result.error) {
    throw new QaError(
      `[${checkLabel}] ffprobe の実行に失敗しました: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new QaError(
      `[${checkLabel}] ffprobe が異常終了しました (exit ${result.status}): ${result.stderr}`
    );
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch (err) {
    throw new QaError(
      `[${checkLabel}] ffprobe の出力をJSONとして解釈できません: ${(err as Error).message}`
    );
  }
}

async function ffprobeDurationSec(
  videoPath: string,
  checkLabel: string
): Promise<number> {
  const result = await spawnAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ]);
  if (result.error || result.status !== 0) {
    throw new QaError(
      `[${checkLabel}] ffprobe(実長取得)が失敗しました: ${
        result.error?.message ?? result.stderr
      }`
    );
  }
  const sec = Number.parseFloat((result.stdout ?? "").trim());
  if (Number.isNaN(sec)) {
    throw new QaError(
      `[${checkLabel}] ffprobe の実長出力を数値として解釈できません: "${result.stdout}"`
    );
  }
  return sec;
}

async function hasAudioStream(videoPath: string): Promise<boolean> {
  const data = await runFfprobeJson<{ streams: unknown[] }>(
    ["-select_streams", "a", "-show_entries", "stream=index", videoPath],
    "audio_stream_check"
  );
  return data.streams.length > 0;
}

function fmtSec(n: number): string {
  return n.toFixed(1);
}

// ---- 検出区間(start / end+duration)の汎用パース ---------------------------
// blackdetect/silencedetect/freezedetectはいずれも「開始」と「終了+長さ」を
// ログへ出力する。動画終端まで継続する区間ではendが出力されないケースに備え、
// startの数がendの数を上回った場合は末尾まで継続する区間として扱う。

type DetectedRange = {
  startSec: number;
  endSec: number | null;
  durationSec: number | null;
};

function pairRanges(
  starts: number[],
  ends: { endSec: number; durationSec: number }[]
): DetectedRange[] {
  return starts.map((startSec, i) => {
    const e = ends[i];
    return e
      ? { startSec, endSec: e.endSec, durationSec: e.durationSec }
      : { startSec, endSec: null, durationSec: null };
  });
}

function formatRanges(ranges: DetectedRange[]): string {
  return ranges
    .map((r) =>
      r.endSec !== null
        ? `${fmtSec(r.startSec)}s-${fmtSec(r.endSec)}s(${fmtSec(
            r.durationSec ?? r.endSec - r.startSec
          )}秒)`
        : `${fmtSec(r.startSec)}s-末尾`
    )
    .join(", ");
}

// ---- 1. black_frames -------------------------------------------------------

async function checkBlackFrames(videoPath: string): Promise<QaCheckResult> {
  const stderr = await runFfmpeg(
    [
      "-i",
      videoPath,
      "-vf",
      `blackdetect=d=${BLACKDETECT_MIN_DURATION_SEC}`,
      "-an",
      "-f",
      "null",
      "-",
    ],
    "black_frames"
  );
  const matches = [
    ...stderr.matchAll(
      /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)\s+black_duration:\s*([\d.]+)/g
    ),
  ];
  if (matches.length === 0) {
    return { id: "black_frames", pass: true };
  }
  const ranges: DetectedRange[] = matches.map((m) => ({
    startSec: Number(m[1]),
    endSec: Number(m[2]),
    durationSec: Number(m[3]),
  }));
  return {
    id: "black_frames",
    pass: false,
    detail: `黒フレーム区間を検出: ${formatRanges(ranges)}`,
  };
}

// ---- 2. silence -------------------------------------------------------------

async function checkSilence(videoPath: string): Promise<QaCheckResult> {
  if (!await hasAudioStream(videoPath)) {
    return {
      id: "silence",
      pass: false,
      detail: "音声ストリームが存在しません",
    };
  }
  const stderr = await runFfmpeg(
    [
      "-i",
      videoPath,
      "-af",
      `silencedetect=n=${SILENCE_NOISE_FLOOR_DB}dB:d=${SILENCE_MIN_DURATION_SEC}`,
      "-vn",
      "-f",
      "null",
      "-",
    ],
    "silence"
  );
  const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) =>
    Number(m[1])
  );
  const ends = [
    ...stderr.matchAll(
      /silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g
    ),
  ].map((m) => ({ endSec: Number(m[1]), durationSec: Number(m[2]) }));
  if (starts.length === 0) {
    return { id: "silence", pass: true };
  }
  const ranges = pairRanges(starts, ends);
  return {
    id: "silence",
    pass: false,
    detail: `${SILENCE_MIN_DURATION_SEC}秒超の無音区間を検出: ${formatRanges(
      ranges
    )}`,
  };
}

// ---- 3. duration_match --------------------------------------------------

async function checkDurationMatch(
  videoPath: string,
  shots: ShotsFile
): Promise<QaCheckResult> {
  const actualSec = await ffprobeDurationSec(videoPath, "duration_match");
  const expectedSec = shots.narration.durationSec;
  const diff = Math.abs(actualSec - expectedSec);
  if (diff <= DURATION_TOLERANCE_SEC) {
    return { id: "duration_match", pass: true };
  }
  return {
    id: "duration_match",
    pass: false,
    detail:
      `動画実長 ${actualSec.toFixed(3)}秒 と narration.durationSec ` +
      `${expectedSec.toFixed(3)}秒 の差が ${diff.toFixed(3)}秒` +
      `(許容 ${DURATION_TOLERANCE_SEC}秒)を超えています`,
  };
}

// ---- 4. loudness --------------------------------------------------------

type LoudnormMeasurement = { input_i: string };

async function checkLoudness(videoPath: string): Promise<QaCheckResult> {
  if (!await hasAudioStream(videoPath)) {
    return {
      id: "loudness",
      pass: false,
      detail: "音声ストリームが存在しません",
    };
  }
  const stderr = await runFfmpeg(
    [
      "-i",
      videoPath,
      "-af",
      `loudnorm=I=${LOUDNESS_TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json`,
      "-f",
      "null",
      "-",
    ],
    "loudness"
  );
  const startIdx = stderr.lastIndexOf("{");
  const endIdx = stderr.lastIndexOf("}");
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new QaError(
      "[loudness] loudnorm の計測結果(JSON)を ffmpeg の出力から抽出できませんでした"
    );
  }
  let measured: LoudnormMeasurement;
  try {
    measured = JSON.parse(stderr.slice(startIdx, endIdx + 1));
  } catch (err) {
    throw new QaError(
      `[loudness] loudnorm JSON の解析に失敗しました: ${(err as Error).message}`
    );
  }
  const raw = measured.input_i;
  const integratedLufs = raw.toLowerCase().includes("inf")
    ? Number.NEGATIVE_INFINITY
    : Number.parseFloat(raw);
  if (Number.isNaN(integratedLufs)) {
    throw new QaError(`[loudness] input_i を数値として解釈できません: "${raw}"`);
  }
  const diff = Math.abs(integratedLufs - LOUDNESS_TARGET_LUFS);
  if (Number.isFinite(integratedLufs) && diff <= LOUDNESS_TOLERANCE_LUFS) {
    return { id: "loudness", pass: true };
  }
  return {
    id: "loudness",
    pass: false,
    detail:
      `統合ラウドネス ${
        Number.isFinite(integratedLufs) ? integratedLufs.toFixed(2) : "-inf"
      } LUFS(目標 ${LOUDNESS_TARGET_LUFS} LUFS ±${LOUDNESS_TOLERANCE_LUFS})`,
  };
}

// ---- 5. resolution_fps ----------------------------------------------------

type FfprobeStreamJson = {
  streams: { width?: number; height?: number; r_frame_rate?: string }[];
};

async function checkResolutionFps(videoPath: string): Promise<QaCheckResult> {
  const data = await runFfprobeJson<FfprobeStreamJson>(
    [
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate",
      videoPath,
    ],
    "resolution_fps"
  );
  const stream = data.streams[0];
  if (!stream) {
    return {
      id: "resolution_fps",
      pass: false,
      detail: "映像ストリームが見つかりません",
    };
  }
  const { width, height, r_frame_rate } = stream;
  let fps = Number.NaN;
  if (r_frame_rate) {
    const [num, den] = r_frame_rate.split("/").map(Number);
    fps = den ? num / den : num;
  }
  const problems: string[] = [];
  if (width !== EXPECTED_WIDTH || height !== EXPECTED_HEIGHT) {
    problems.push(
      `解像度 ${width}x${height}(期待値 ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT})`
    );
  }
  if (Number.isNaN(fps) || Math.abs(fps - EXPECTED_FPS) > FPS_TOLERANCE) {
    problems.push(
      `fps ${Number.isNaN(fps) ? "不明" : fps.toFixed(3)}(期待値 ${EXPECTED_FPS})`
    );
  }
  if (problems.length === 0) {
    return { id: "resolution_fps", pass: true };
  }
  return { id: "resolution_fps", pass: false, detail: problems.join(" / ") };
}

// ---- 6. assets_resolved -----------------------------------------------------

function checkAssetsResolved(
  episodeRelDir: string,
  projectRoot: string
): QaCheckResult {
  const report = validateEpisode(episodeRelDir, projectRoot);
  if (report.ok) {
    return { id: "assets_resolved", pass: true };
  }
  return {
    id: "assets_resolved",
    pass: false,
    detail: report.errors.join(" / "),
  };
}

// ---- 7. frozen_video --------------------------------------------------------

async function checkFrozenVideo(videoPath: string): Promise<QaCheckResult> {
  const stderr = await runFfmpeg(
    [
      "-i",
      videoPath,
      "-vf",
      `freezedetect=d=${FROZEN_MIN_DURATION_SEC}`,
      "-an",
      "-f",
      "null",
      "-",
    ],
    "frozen_video"
  );
  const starts = [
    ...stderr.matchAll(/freezedetect\.freeze_start:\s*([\d.]+)/g),
  ].map((m) => Number(m[1]));
  const durations = [
    ...stderr.matchAll(/freezedetect\.freeze_duration:\s*([\d.]+)/g),
  ].map((m) => Number(m[1]));
  const endsRaw = [
    ...stderr.matchAll(/freezedetect\.freeze_end:\s*([\d.]+)/g),
  ].map((m) => Number(m[1]));
  if (starts.length === 0) {
    return { id: "frozen_video", pass: true };
  }
  const ranges: DetectedRange[] = starts.map((startSec, i) => ({
    startSec,
    endSec: endsRaw[i] ?? null,
    durationSec: durations[i] ?? null,
  }));
  return {
    id: "frozen_video",
    pass: false,
    detail: `${FROZEN_MIN_DURATION_SEC}秒超の静止区間を検出: ${formatRanges(
      ranges
    )}`,
  };
}

// ---- メインフロー ---------------------------------------------------------

function resolveVideoPath(episodeAbsDir: string): string {
  const previewPath = path.join(episodeAbsDir, "out", "preview.mp4");
  const finalPath = path.join(episodeAbsDir, "out", "final.mp4");
  if (existsSync(previewPath)) return previewPath;
  if (existsSync(finalPath)) return finalPath;
  throw new QaError(
    `検査対象の動画が見つかりません: ${previewPath} も ${finalPath} も存在しません`
  );
}

export async function runQa(
  episodeArg: string,
  projectRoot: string = process.cwd()
): Promise<QaReport> {
  const episodeAbsDir = path.resolve(projectRoot, episodeArg);
  const epId = path.basename(episodeAbsDir);
  const episodeRelDir = path.relative(projectRoot, episodeAbsDir);

  const shotsPath = path.join(episodeAbsDir, "shots.json");
  if (!existsSync(shotsPath)) {
    throw new QaError(`shots.json が見つかりません: ${shotsPath}`);
  }
  const shots = JSON.parse(readFileSync(shotsPath, "utf-8")) as ShotsFile;

  const videoPath = resolveVideoPath(episodeAbsDir);

  // 独立した検査を並列実行する(各検査は動画全体のffmpegスキャンを伴い、
  // 直列では検査数×スキャン時間かかる。結果・判定基準は不変)
  const checks: QaCheckResult[] = await Promise.all([
    checkBlackFrames(videoPath),
    checkSilence(videoPath),
    checkDurationMatch(videoPath, shots),
    checkLoudness(videoPath),
    checkResolutionFps(videoPath),
    checkAssetsResolved(episodeRelDir, projectRoot),
    checkFrozenVideo(videoPath),
  ]);

  const report: QaReport = {
    episodeId: shots.episodeId ?? epId,
    pass: checks.every((c) => c.pass),
    checks,
  };

  const reviewDir = path.join(episodeAbsDir, "review");
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(
    path.join(reviewDir, "qa-report.json"),
    JSON.stringify(report, null, 2) + "\n"
  );

  return report;
}

// ---- CLI エントリポイント -------------------------------------------------

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      path.resolve(fileURLToPath(import.meta.url)) ===
      path.resolve(process.argv[1])
    );
  } catch {
    return false;
  }
}

async function main() {
  const episodeArg = process.argv[2];
  if (!episodeArg) {
    console.error("Usage: qa.ts <episodeDir>  (例: episodes/<epId>)");
    process.exit(1);
  }

  try {
    const report = await runQa(episodeArg);
    for (const c of report.checks) {
      const mark = c.pass ? "OK" : "NG";
      console.log(`[${mark}] ${c.id}${c.detail ? ` - ${c.detail}` : ""}`);
    }
    if (report.pass) {
      console.log(`OK: ${report.episodeId} は Mechanical QA に合格しました`);
      process.exit(0);
    } else {
      const failedCount = report.checks.filter((c) => !c.pass).length;
      console.error(
        `NG: ${report.episodeId} の Mechanical QA で ${failedCount} 件の検査が失敗しました`
      );
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof QaError || err instanceof Error) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error("Error: unknown qa failure");
    }
    process.exit(1);
  }
}

if (isMainModule()) {
  void main();
}
