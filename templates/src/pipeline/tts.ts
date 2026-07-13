#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseScriptFile, type ParsedScriptLine } from "./parse-script";
import type { LineTiming, PhraseTiming, TimingFile } from "../schemas/types";

/**
 * §7.3 / §5.5 準拠の TTS パイプライン。
 *
 * script.md (§5.4) と channel/voice.json (§5.2) を読み、VOICEVOXエンジン
 * (http://127.0.0.1:50021) で行ごとに音声合成し、narration/*.wav と
 * narration/narration.wav、timing.json (§5.5) を生成する。
 *
 * 正しさの根拠は自己検証にある:
 *  1. 各行について、合成クエリ(モーラ長)から算出した長さと、実際に生成された
 *     WAVの実長(ffprobe)の差が0.1秒を超えたら即エラー終了する。
 *  2. narration.wav 全体の実長と、行長+行間ポーズの合計の差が0.1秒を超えたら
 *     即エラー終了する。
 *
 * 外部の強制アラインメントツールは使わない。タイミングは常に合成クエリ自身が
 * 返すモーラ長から算出する(§7.3)。
 *
 * 既知の制約: accent_phrase.is_interrogative が true の場合(疑問形の
 * 「?」を含む文)、VOICEVOXエンジンは疑問形の上昇イントネーションのために
 * audio_query が申告するモーラ長を超える実長を合成することがある(実測で
 * 約0.14秒、モーラ長の合計には現れない)。このため疑問形を含む行のみ
 * 自己検証の許容差を広げる(INTERROGATIVE_TOLERANCE_SEC)。タイムラインの
 * 行オフセットと全体長は常に実測値(ffprobe)基準なので、この乖離が
 * timing.json の精度に影響することはない。
 */

const VOICEVOX_BASE_URL = process.env.VOICEVOX_URL ?? "http://127.0.0.1:50021";
const SELF_CHECK_TOLERANCE_SEC = 0.1;
// 疑問形(is_interrogative)を含む行専用の緩和許容差
const INTERROGATIVE_TOLERANCE_SEC = 0.3;
const SAMPLE_RATE = 24000;

export class TtsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TtsError";
  }
}

// ---- VOICEVOX audio_query の型 -----------------------------------------

type Mora = {
  text: string;
  consonant: string | null;
  consonant_length: number | null;
  vowel: string;
  vowel_length: number;
  pitch: number;
};

type AccentPhrase = {
  moras: Mora[];
  accent: number;
  pause_mora: Mora | null;
  is_interrogative: boolean;
};

type AudioQuery = {
  accent_phrases: AccentPhrase[];
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  volumeScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
  pauseLength: number | null;
  pauseLengthScale: number;
  outputSamplingRate: number;
  outputStereo: boolean;
  kana: string;
};

type VoiceConfig = {
  provider: string;
  speakerId: number;
  speakerName?: string;
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  defaultPauseAfterLineSec: number;
  pauseLengthScale?: number;
  creditNotice: string;
};

// 句読点ポーズ長の倍率デフォルト。voice.json の pauseLengthScale で上書き可。
// AudioQuery.pauseLengthScale ではなく pause_mora.vowel_length を直接スケール
// する(timing計算と合成が同じモーラ長を参照し、自己検証が壊れないため)。
const DEFAULT_PAUSE_LENGTH_SCALE = 0.5;

function scalePauseMoras(aq: AudioQuery, scale: number): void {
  if (scale === 1) return;
  for (const ap of aq.accent_phrases) {
    if (ap.pause_mora) {
      ap.pause_mora.vowel_length *= scale;
    }
  }
}

/**
 * ショート(shorts/配下)のときだけ、フォーマット契約の speech セクションで
 * voice.json 由来の speedScale / pauseLengthScale を上書きする。
 * 経路: <dir>/short.json の formatId → channel/short-formats/<formatId>.json の
 * speech.{speedScale,pauseLengthScale}。エピソード経路(episodes/配下)では
 * 一切読まない。short.json / フォーマットファイルの欠損・speech無しは黙って素通し。
 * voice.json は変更禁止のため、ここでメモリ上の voice を上書きする。
 */
function applyShortFormatSpeechOverride(
  voice: VoiceConfig,
  episodeAbsDir: string,
  projectRoot: string
): void {
  const rel = path.relative(projectRoot, episodeAbsDir);
  const isShort = rel === "shorts" || rel.startsWith(`shorts${path.sep}`);
  if (!isShort) return;

  const shortJsonPath = path.join(episodeAbsDir, "short.json");
  if (!existsSync(shortJsonPath)) return;
  let formatId: string | undefined;
  try {
    const short = JSON.parse(readFileSync(shortJsonPath, "utf-8")) as {
      formatId?: string;
    };
    formatId = short.formatId;
  } catch {
    return;
  }
  if (!formatId) return;

  const formatPath = path.join(
    projectRoot,
    "channel",
    "short-formats",
    `${formatId}.json`
  );
  if (!existsSync(formatPath)) return;
  let speech: { speedScale?: number; pauseLengthScale?: number } | undefined;
  try {
    const fmt = JSON.parse(readFileSync(formatPath, "utf-8")) as {
      speech?: { speedScale?: number; pauseLengthScale?: number };
    };
    speech = fmt.speech;
  } catch {
    return;
  }
  if (!speech) return;

  const parts: string[] = [];
  if (typeof speech.speedScale === "number") {
    voice.speedScale = speech.speedScale;
    parts.push(`speedScale=${speech.speedScale}`);
  }
  if (typeof speech.pauseLengthScale === "number") {
    voice.pauseLengthScale = speech.pauseLengthScale;
    parts.push(`pauseLengthScale=${speech.pauseLengthScale}`);
  }
  if (parts.length > 0) {
    console.log(`speech override: ${parts.join(" ")} (${formatId})`);
  }
}

// ---- VOICEVOX HTTP クライアント -----------------------------------------

const VOICEVOX_RETRY_MAX = 3;
const VOICEVOX_RETRY_BASE_MS = 1000;

/**
 * VOICEVOX への fetch を一過性障害(ネットワークエラー・5xx)に限りリトライする。
 * 4xx はリクエスト自体の問題なので即座に返す(呼び出し元が本文つきで throw する)。
 */
async function voicevoxFetch(
  url: string,
  init: RequestInit,
  what: string
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= VOICEVOX_RETRY_MAX; attempt++) {
    if (attempt > 0) {
      const waitMs = VOICEVOX_RETRY_BASE_MS * 2 ** (attempt - 1);
      console.error(
        `VOICEVOX ${what} を再試行します ${attempt}/${VOICEVOX_RETRY_MAX}(${waitMs}ms待機)`
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
    try {
      const res = await fetch(url, init);
      if (res.ok || res.status < 500) return res;
      lastErr = new TtsError(
        `VOICEVOX ${what} が失敗しました: HTTP ${res.status} ${await res.text()}`
      );
    } catch (err) {
      lastErr = err; // エンジン未起動・一時断
    }
  }
  throw lastErr instanceof Error ? lastErr : new TtsError(String(lastErr));
}

async function fetchAudioQuery(
  text: string,
  speakerId: number
): Promise<AudioQuery> {
  const qs = new URLSearchParams({ text, speaker: String(speakerId) });
  const res = await voicevoxFetch(
    `${VOICEVOX_BASE_URL}/audio_query?${qs}`,
    { method: "POST" },
    "/audio_query"
  );
  if (!res.ok) {
    throw new TtsError(
      `VOICEVOX /audio_query が失敗しました: HTTP ${res.status} ${await res.text()}`
    );
  }
  return (await res.json()) as AudioQuery;
}

async function synthesize(query: AudioQuery, speakerId: number): Promise<Buffer> {
  const qs = new URLSearchParams({ speaker: String(speakerId) });
  const res = await voicevoxFetch(
    `${VOICEVOX_BASE_URL}/synthesis?${qs}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    },
    "/synthesis"
  );
  if (!res.ok) {
    throw new TtsError(
      `VOICEVOX /synthesis が失敗しました: HTTP ${res.status} ${await res.text()}`
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---- ffmpeg/ffprobe ------------------------------------------------------

function ffprobeDurationSec(wavPath: string): number {
  let out: string;
  try {
    out = execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        wavPath,
      ],
      { encoding: "utf-8" }
    );
  } catch (err) {
    throw new TtsError(
      `ffprobe の実行に失敗しました (${wavPath}): ${(err as Error).message}`
    );
  }
  const sec = Number.parseFloat(out.trim());
  if (Number.isNaN(sec)) {
    throw new TtsError(`ffprobe の出力を数値として解釈できません: "${out}"`);
  }
  return sec;
}

function runFfmpeg(args: string[]): void {
  try {
    execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString("utf-8") ?? "";
    throw new TtsError(`ffmpeg の実行に失敗しました: ${stderr || (err as Error).message}`);
  }
}

function generateSilenceWav(durationSec: number, outPath: string): void {
  runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=${SAMPLE_RATE}:cl=mono`,
    "-t",
    durationSec.toFixed(6),
    "-ar",
    String(SAMPLE_RATE),
    "-ac",
    "1",
    "-sample_fmt",
    "s16",
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
}

/**
 * 行WAVを pauseSecs[i] 秒の無音を挟んで結合する(N行なら無音は N-1 個、
 * 最後の行の後には無音を追加しない)。ffmpeg concat demuxer で再エンコード
 * することでヘッダ差異を吸収し、常に 24kHz/mono/16bit の一貫した出力にする。
 */
// ナレーション目標ラウドネス。BGM(-22dB)/SEを重ねた最終ミックスが
// QA基準(-14±1 LUFS)に収まるよう、ミックス寄与分を見込んで少し低めに置く。
const NARRATION_TARGET_LUFS = -14.5;

/** ffmpeg loudnormの計測モードで統合ラウドネスと真のピークを得る(JSONはstderrに出る)。 */
function measureLoudness(wavPath: string): { lufs: number; truePeakDb: number } {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", wavPath, "-af", "loudnorm=print_format=json", "-f", "null", "-"],
    { encoding: "utf8" }
  );
  const m = (r.stderr ?? "").match(/\{[\s\S]*\}/);
  if (!m) throw new TtsError("loudnorm計測のJSON出力が取得できませんでした");
  const stats = JSON.parse(m[0]) as { input_i: string; input_tp: string };
  const lufs = Number(stats.input_i);
  const truePeakDb = Number(stats.input_tp);
  if (!Number.isFinite(lufs) || !Number.isFinite(truePeakDb)) {
    throw new TtsError(`loudnorm計測値が不正です: ${m[0].slice(0, 200)}`);
  }
  return { lufs, truePeakDb };
}

/**
 * ラウドネス正規化。定数ゲイン+ピークリミッター(-1.5dBFS天井、latency補償で尺不変)。
 * リミッターがラウドネスを削るため、計測→ゲイン→再計測を収束するまで反復する(最大3回)。
 * loudnormの動的モードは使わない — 定数ゲイン+リミッターなら
 * timing.json との整合(尺)が完全に保たれる(パスごとに尺検証あり)。
 */
function normalizeLoudness(wavPath: string): void {
  const initial = measureLoudness(wavPath);
  let current = initial;
  for (let pass = 1; pass <= 3; pass++) {
    const gainDb = NARRATION_TARGET_LUFS - current.lufs;
    if (Math.abs(gainDb) < 0.4) break;

    const filter =
      gainDb > 0
        ? `volume=${gainDb.toFixed(2)}dB,alimiter=limit=0.841395:latency=1:level=disabled`
        : `volume=${gainDb.toFixed(2)}dB`;

    const durationBefore = ffprobeDurationSec(wavPath);
    const tmpOut = wavPath + ".norm.wav";
    runFfmpeg(["-y", "-i", wavPath, "-af", filter, tmpOut]);
    renameSync(tmpOut, wavPath);
    const durationAfter = ffprobeDurationSec(wavPath);
    if (Math.abs(durationAfter - durationBefore) > 0.01) {
      throw new TtsError(
        `ラウドネス正規化で尺が変化しました: ${durationBefore.toFixed(4)}s -> ` +
          `${durationAfter.toFixed(4)}s(timing.jsonとの整合が壊れるため中断)`
      );
    }
    current = measureLoudness(wavPath);
  }
  console.log(
    `loudness: ${initial.lufs.toFixed(1)} -> ${current.lufs.toFixed(1)} LUFS ` +
      `(目標 ${NARRATION_TARGET_LUFS}、TP ${current.truePeakDb.toFixed(1)} dBTP)`
  );
}

function concatWithPauses(
  wavPaths: string[],
  pauseSecs: number[],
  outPath: string
): void {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "tts-concat-"));
  try {
    const listEntries: string[] = [];
    for (let i = 0; i < wavPaths.length; i++) {
      listEntries.push(wavPaths[i]);
      if (i < pauseSecs.length) {
        const silencePath = path.join(tmpDir, `silence-${i}.wav`);
        generateSilenceWav(pauseSecs[i], silencePath);
        listEntries.push(silencePath);
      }
    }

    const listPath = path.join(tmpDir, "list.txt");
    const listContent = listEntries
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    writeFileSync(listPath, listContent + "\n");

    runFfmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "1",
      "-sample_fmt",
      "s16",
      "-c:a",
      "pcm_s16le",
      outPath,
    ]);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---- タイミング算出(§7.3) ------------------------------------------------

/**
 * pause_mora を境界として accent_phrases をグループ化する。
 * pause_mora を持つ accent_phrase はそのグループの最後の要素になる。
 * 末尾に pause_mora のない accent_phrase が残っていれば、それも1グループ
 * として扱う(文末など、後続の間がないケース)。
 */
function groupAccentPhrases(accentPhrases: AccentPhrase[]): AccentPhrase[][] {
  const groups: AccentPhrase[][] = [];
  let current: AccentPhrase[] = [];
  for (const ap of accentPhrases) {
    current.push(ap);
    if (ap.pause_mora !== null) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function moraSpeechLength(m: Mora): number {
  return (m.consonant_length ?? 0) + m.vowel_length;
}

type GroupRawBoundary = { startRaw: number; endRaw: number };

/**
 * 行の実時間(speedScale適用後)を算出する。
 * raw = prePhonemeLength + Σ(モーラの consonant_length + vowel_length)
 *       + Σ(pause_mora の vowel_length) + postPhonemeLength
 * 実時間 = raw / speedScale (VOICEVOXはモーラ長を1/speedScaleでスケールする)
 *
 * 同時に、各accent_phraseグループの「発話区間」(pause_mora区間を含まない、
 * 行内相対・raw単位)の開始/終了位置も返す。字幕フレーズの時刻算出に使う。
 */
function computeLineRawTiming(aq: AudioQuery): {
  totalRawSec: number;
  groupBoundariesRaw: GroupRawBoundary[];
} {
  const groups = groupAccentPhrases(aq.accent_phrases);
  let cursor = aq.prePhonemeLength;
  const groupBoundariesRaw: GroupRawBoundary[] = [];

  for (const group of groups) {
    let speechRaw = 0;
    for (const ap of group) {
      for (const m of ap.moras) speechRaw += moraSpeechLength(m);
    }
    const last = group[group.length - 1];
    const pauseRaw = last.pause_mora ? moraSpeechLength(last.pause_mora) : 0;

    const startRaw = cursor;
    const endRaw = cursor + speechRaw;
    groupBoundariesRaw.push({ startRaw, endRaw });
    cursor = endRaw + pauseRaw;
  }

  const totalRawSec = cursor + aq.postPhonemeLength;
  return { totalRawSec, groupBoundariesRaw };
}

/**
 * 句読点(、。!?！？…)で行テキストを分割する。連続する句読点は1つの区切りと
 * して扱い、空セグメントは除外する。
 */
const PUNCTUATION_RE = /[、。!?！？…]+/g;

export function splitIntoPhraseSegments(text: string): string[] {
  const segments = text
    .split(PUNCTUATION_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return segments.length > 0 ? segments : [text.trim()];
}

/**
 * 行内のフレーズ(字幕用)タイミングを算出する。行頭からの相対秒で返す
 * (呼び出し側で行の絶対 startSec を加算する)。
 *
 * 主経路: 句読点分割セグメント数と pause_mora 境界のグループ数が一致する
 * 場合、各グループの発話区間(実測クエリ由来)をそのままセグメントに割り当てる。
 * このとき、算出済み行長(calculatedLineDurationSec)と実測WAV長
 * (actualLineDurationSec)の間に生じうる微小差を吸収するため、境界値を
 * actual/calculated 比でスケールし、最後のフレーズの終端が行の終端に厳密に
 * 一致するようにする。
 *
 * フォールバック経路(ヒューリスティック): グループ数とセグメント数が
 * 一致しない場合(句読点の解釈がVOICEVOXの内部アクセント句分割と食い違う
 * ケース。例: 中点「・」はVOICEVOXでは間を生むが句読点分割の対象にしていない
 * ため、ここではセグメント数とグループ数がずれる)、実測行長を各セグメントの
 * 文字数比で按分する。これは実際の発話境界を反映しない近似値である。
 */
export function buildPhraseTimings(
  lineText: string,
  groupBoundariesRaw: GroupRawBoundary[],
  speedScale: number,
  calculatedLineDurationSec: number,
  actualLineDurationSec: number
): { text: string; startSec: number; endSec: number }[] {
  const segments = splitIntoPhraseSegments(lineText);

  if (segments.length === groupBoundariesRaw.length) {
    const scale =
      calculatedLineDurationSec > 0
        ? actualLineDurationSec / calculatedLineDurationSec
        : 1;
    return segments.map((text, i) => {
      const { startRaw, endRaw } = groupBoundariesRaw[i];
      return {
        text,
        startSec: (startRaw / speedScale) * scale,
        endSec: (endRaw / speedScale) * scale,
      };
    });
  }

  // --- フォールバック: 文字数比による按分(ヒューリスティック。実測ではない) ---
  const totalChars = segments.reduce((sum, s) => sum + s.length, 0) || 1;
  let cumChars = 0;
  return segments.map((text) => {
    const startSec = (cumChars / totalChars) * actualLineDurationSec;
    cumChars += text.length;
    const endSec = (cumChars / totalChars) * actualLineDurationSec;
    return { text, startSec, endSec };
  });
}

// ---- メインフロー ---------------------------------------------------------

type LineResult = {
  line: ParsedScriptLine;
  wavPath: string;
  kana: string;
  speedScale: number;
  calculatedDurationSec: number;
  actualDurationSec: number;
  groupBoundariesRaw: GroupRawBoundary[];
  usedFallback: boolean;
};

/**
 * 読み仮名レポート(narration/readings.md)の全文を組み立てる。
 * VOICEVOXのaudio_queryが返すkana(実読み)をアクセント記号を落として可読化し、
 * 行ごとに台本テキストと並べて出力する。フルモードと --readings-only の双方が
 * これを呼ぶことで、両モードのフォーマットを1箇所で同一に保つ。
 */
function renderReadingsReport(
  items: { line: ParsedScriptLine; kana: string }[]
): string {
  const readingsBody = items
    .map((r) => {
      const kana = (r.kana ?? "")
        .replace(/['_\/]/g, "") // アクセント記号を除去して可読化
        .replace(/、/g, " ");
      return `- **${r.line.lineId}** ${r.line.text}\n  - 読み: ${kana}`;
    })
    .join("\n");
  return `# 読み仮名レポート(VOICEVOX実読み)\n\n誤読チェック用。台本テキストと読みを突合すること。\n\n${readingsBody}\n`;
}

export async function runTts(
  episodeArg: string,
  projectRoot: string = process.cwd()
): Promise<TimingFile> {
  const episodeAbsDir = path.resolve(projectRoot, episodeArg);
  const epId = path.basename(episodeAbsDir);
  const scriptPath = path.join(episodeAbsDir, "script.md");
  const voicePath = path.join(projectRoot, "channel", "voice.json");
  const narrationDir = path.join(episodeAbsDir, "narration");

  const voice = JSON.parse(readFileSync(voicePath, "utf-8")) as VoiceConfig;
  applyShortFormatSpeechOverride(voice, episodeAbsDir, projectRoot);
  const parsed = parseScriptFile(scriptPath);
  if (parsed.lines.length === 0) {
    throw new TtsError(`${scriptPath} に行(## [Lxx])がありません`);
  }

  mkdirSync(narrationDir, { recursive: true });

  // ---- 行キャッシュ(局所再TTS) ------------------------------------------
  // テキスト・話速・話者・韻律が前回と同一の行は合成をスキップし、既存WAVと
  // キャッシュ済みタイミングを再利用する。誤読修正などの数行変更では変更行
  // だけが再合成される。結合・正規化・timing.jsonは毎回全体を作り直すので
  // 出力の正しさはキャッシュの有無に依存しない。
  type LineCacheEntry = {
    hash: string;
    kana: string;
    speedScale: number;
    calculatedDurationSec: number;
    actualDurationSec: number;
    groupBoundariesRaw: GroupRawBoundary[];
    usedFallback: boolean;
  };
  const cachePath = path.join(narrationDir, ".tts-cache.json");
  let lineCache: Record<string, LineCacheEntry> = {};
  if (existsSync(cachePath)) {
    try {
      lineCache = JSON.parse(readFileSync(cachePath, "utf-8"));
    } catch {
      lineCache = {};
    }
  }
  const newCache: Record<string, LineCacheEntry> = {};
  let cacheHits = 0;

  // 合成の同時実行数。実測(2026-07-08、180行)で並列4は直列より遅かった
  // (VOICEVOXエンジンが内部で合成を直列化し、同時リクエストは時分割で
  // 遅くなるだけ)ため既定は1。エンジン側が並列に強い環境でのみ
  // TTS_CONCURRENCY で上げる。再TTSの高速化は行キャッシュが担う。
  const TTS_CONCURRENCY = Math.max(
    1,
    Number(process.env.TTS_CONCURRENCY ?? 1)
  );

  const results: LineResult[] = new Array(parsed.lines.length);

  const synthesizeLine = async (
    line: ParsedScriptLine,
    index: number
  ): Promise<void> => {
    const speedScale = line.speedScale ?? voice.speedScale;
    const wavPathForLine = path.join(narrationDir, `${line.lineId}.wav`);
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          line.text,
          speedScale,
          voice.speakerId,
          voice.pitchScale,
          voice.intonationScale,
          voice.pauseLengthScale ?? DEFAULT_PAUSE_LENGTH_SCALE,
        ])
      )
      .digest("hex");

    const cached = lineCache[line.lineId];
    if (cached && cached.hash === hash && existsSync(wavPathForLine)) {
      newCache[line.lineId] = cached;
      cacheHits++;
      results[index] = {
        line,
        wavPath: wavPathForLine,
        kana: cached.kana,
        speedScale: cached.speedScale,
        calculatedDurationSec: cached.calculatedDurationSec,
        actualDurationSec: cached.actualDurationSec,
        groupBoundariesRaw: cached.groupBoundariesRaw,
        usedFallback: cached.usedFallback,
      };
      return;
    }

    const aq = await fetchAudioQuery(line.text, voice.speakerId);
    // voice.json の値で上書きする(行注釈 speed_scale があれば行側優先)
    aq.speedScale = speedScale;
    aq.pitchScale = voice.pitchScale;
    aq.intonationScale = voice.intonationScale;
    scalePauseMoras(aq, voice.pauseLengthScale ?? DEFAULT_PAUSE_LENGTH_SCALE);

    const wavBuffer = await synthesize(aq, voice.speakerId);
    const wavPath = path.join(narrationDir, `${line.lineId}.wav`);
    writeFileSync(wavPath, wavBuffer);

    const { totalRawSec, groupBoundariesRaw } = computeLineRawTiming(aq);
    const calculatedDurationSec = totalRawSec / aq.speedScale;
    const actualDurationSec = ffprobeDurationSec(wavPath);

    const diff = Math.abs(calculatedDurationSec - actualDurationSec);
    // 疑問形の行は語尾の上昇イントネーション分だけ実音声がモーラ長合計より
    // 長くなる(ファイル冒頭コメント参照)ため、許容差を広げる。
    const hasInterrogative = aq.accent_phrases.some((p) => p.is_interrogative);
    const toleranceSec = hasInterrogative
      ? INTERROGATIVE_TOLERANCE_SEC
      : SELF_CHECK_TOLERANCE_SEC;
    if (diff > toleranceSec) {
      throw new TtsError(
        `[${line.lineId}] 行の長さの自己検証に失敗しました: ` +
          `算出値=${calculatedDurationSec.toFixed(4)}s, ` +
          `実測値=${actualDurationSec.toFixed(4)}s, ` +
          `差=${diff.toFixed(4)}s (許容 ${toleranceSec}s)`
      );
    }

    const segments = splitIntoPhraseSegments(line.text);
    const usedFallback = segments.length !== groupBoundariesRaw.length;

    results[index] = {
      line,
      wavPath,
      kana: aq.kana ?? "",
      speedScale: aq.speedScale,
      calculatedDurationSec,
      actualDurationSec,
      groupBoundariesRaw,
      usedFallback,
    };
    newCache[line.lineId] = {
      hash,
      kana: aq.kana ?? "",
      speedScale: aq.speedScale,
      calculatedDurationSec,
      actualDurationSec,
      groupBoundariesRaw,
      usedFallback,
    };

    console.log(
      `[${line.lineId}] OK 算出=${calculatedDurationSec.toFixed(4)}s ` +
        `実測=${actualDurationSec.toFixed(4)}s 差=${diff.toFixed(4)}s ` +
        `phraseMode=${usedFallback ? "fallback" : "exact"}`
    );
  };

  // 素朴なワーカープール: 次のインデックスを取り合う
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++;
      if (i >= parsed.lines.length) return;
      await synthesizeLine(parsed.lines[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: TTS_CONCURRENCY }, () => worker())
  );

  writeFileSync(cachePath, JSON.stringify(newCache, null, 2) + "\n");
  if (cacheHits > 0) {
    console.log(
      `cache: ${cacheHits}/${parsed.lines.length} 行を再利用(変更行のみ再合成)`
    );
  }

  // ---- 読み仮名レポート(誤読チェック用) -----------------------------------
  // VOICEVOXのaudio_queryが返すkana(実際に読み上げられる読み)を全行分出力する。
  // reading-checkerエージェントがこれを検査し、誤読(者→シャ、実の→ミノ等)を
  // 台本表記の修正(ひらがなに開く・言い換え)として差し戻す。
  const readingsPath = path.join(narrationDir, "readings.md");
  writeFileSync(readingsPath, renderReadingsReport(results));
  console.log(`readings: ${readingsPath}(全${results.length}行)`);

  // ---- 行間ポーズを挟んで結合 ---------------------------------------------
  const pauseSecs: number[] = results
    .slice(0, -1)
    .map((r) => r.line.pauseAfterSec ?? voice.defaultPauseAfterLineSec);
  // 最終行に明示的な pause_after_sec がある場合のみ無音尾として付与する
  // (既定は従来どおり付けない。アウトロの規定尺(bible §4 約6〜8秒)を
  //  静かな余韻で満たすための明示オプトイン)
  const lastPauseSec = results[results.length - 1]?.line.pauseAfterSec;
  if (typeof lastPauseSec === "number" && lastPauseSec > 0) {
    pauseSecs.push(lastPauseSec);
  }

  const narrationWavPath = path.join(narrationDir, "narration.wav");
  concatWithPauses(
    results.map((r) => r.wavPath),
    pauseSecs,
    narrationWavPath
  );

  normalizeLoudness(narrationWavPath);

  const narrationActualDurationSec = ffprobeDurationSec(narrationWavPath);

  // ---- 結合後タイムライン上の行オフセットを実測値の累積で算出 ---------------
  let cursor = 0;
  const lineStartOffsets: number[] = [];
  for (let i = 0; i < results.length; i++) {
    lineStartOffsets.push(cursor);
    cursor += results[i].actualDurationSec;
    if (i < pauseSecs.length) cursor += pauseSecs[i];
  }
  const expectedTotalDurationSec = cursor;

  const totalDiff = Math.abs(expectedTotalDurationSec - narrationActualDurationSec);
  if (totalDiff > SELF_CHECK_TOLERANCE_SEC) {
    throw new TtsError(
      `narration.wav 全体長の自己検証に失敗しました: ` +
        `算出値(行長+ポーズの合計)=${expectedTotalDurationSec.toFixed(4)}s, ` +
        `実測値=${narrationActualDurationSec.toFixed(4)}s, ` +
        `差=${totalDiff.toFixed(4)}s (許容 ${SELF_CHECK_TOLERANCE_SEC}s)`
    );
  }

  // ---- timing.json 組み立て -------------------------------------------------
  const lines: LineTiming[] = results.map((r, i) => {
    const startSec = lineStartOffsets[i];
    const endSec = startSec + r.actualDurationSec;
    const relPhrases = buildPhraseTimings(
      r.line.text,
      r.groupBoundariesRaw,
      r.speedScale,
      r.calculatedDurationSec,
      r.actualDurationSec
    );
    // 字幕表記(- display:)。読みをひらがなに開いた行でも字幕は漢字で出せる。
    // 句読点構造が一致する場合のみフレーズ単位に割り付け、不一致なら未設定
    // (SubtitleLayerが読みテキストへフォールバック)。
    const displayRaw = r.line.hints?.display;
    const displaySegs = displayRaw
      ? splitIntoPhraseSegments(displayRaw)
      : undefined;
    const displayPerPhrase =
      displaySegs && displaySegs.length === relPhrases.length
        ? displaySegs
        : undefined;
    const phrases: PhraseTiming[] = relPhrases.map((p, pi) => ({
      text: p.text,
      ...(displayPerPhrase ? { displayText: displayPerPhrase[pi] } : {}),
      startSec: startSec + p.startSec,
      endSec: startSec + p.endSec,
    }));
    // 字幕非表示(- subtitle: off)。画面内テキストと重複する行の字幕を描画から外す。
    const noSubtitle = r.line.hints?.subtitle === "off";
    return {
      lineId: r.line.lineId,
      text: r.line.text,
      ...(displayRaw ? { displayText: displayRaw } : {}),
      ...(noSubtitle ? { noSubtitle: true } : {}),
      startSec,
      endSec,
      phrases,
    };
  });

  const timing: TimingFile = {
    episodeId: epId,
    totalDurationSec: narrationActualDurationSec,
    lines,
  };

  writeFileSync(
    path.join(episodeAbsDir, "timing.json"),
    JSON.stringify(timing, null, 2) + "\n"
  );

  console.log(
    `OK: ${epId} -> narration/narration.wav (${narrationActualDurationSec.toFixed(4)}s), timing.json`
  );
  const fallbackLines = results.filter((r) => r.usedFallback).map((r) => r.line.lineId);
  console.log(
    fallbackLines.length > 0
      ? `フォールバック発動行: ${fallbackLines.join(", ")}`
      : `フォールバック発動行: なし(全行で句読点分割とアクセント句グループが一致)`
  );

  return timing;
}

/**
 * --readings-only モード: 音声合成を一切行わず、各行の audio_query のみを叩いて
 * 読み仮名レポート(narration/readings.md)だけを生成する高速プリチェック。
 * フル合成(10分超の動画で15分以上)の前に誤読を洗い出すために使う。
 *
 * 台本のパース・話者設定の読み込み・行ごとのkana取得条件はフルモードと同一に
 * 保つ(readings.md がフル合成由来のものとバイト単位で一致するようにするため)。
 * narration/*.wav・narration.wav・timing.json・.tts-cache.json は書き換えない。
 * 行キャッシュは読み取り再利用のみ許す(wav関連エントリの整合を壊さないため、
 * 書き戻しは行わない)。
 */
export async function runReadingsOnly(
  episodeArg: string,
  projectRoot: string = process.cwd()
): Promise<void> {
  const episodeAbsDir = path.resolve(projectRoot, episodeArg);
  const scriptPath = path.join(episodeAbsDir, "script.md");
  const voicePath = path.join(projectRoot, "channel", "voice.json");
  const narrationDir = path.join(episodeAbsDir, "narration");

  const voice = JSON.parse(readFileSync(voicePath, "utf-8")) as VoiceConfig;
  applyShortFormatSpeechOverride(voice, episodeAbsDir, projectRoot);
  const parsed = parseScriptFile(scriptPath);
  if (parsed.lines.length === 0) {
    throw new TtsError(`${scriptPath} に行(## [Lxx])がありません`);
  }

  mkdirSync(narrationDir, { recursive: true });

  // 行キャッシュ(読み取り専用)。フルモードと同一のヒット条件(ハッシュ一致かつ
  // 既存WAVあり)を満たす行は保存済みkanaを再利用し、それ以外は audio_query を
  // 叩く。--readings-only ではキャッシュを書き戻さない。
  const cachePath = path.join(narrationDir, ".tts-cache.json");
  let lineCache: Record<string, { hash: string; kana: string }> = {};
  if (existsSync(cachePath)) {
    try {
      lineCache = JSON.parse(readFileSync(cachePath, "utf-8"));
    } catch {
      lineCache = {};
    }
  }

  const items: { line: ParsedScriptLine; kana: string }[] = new Array(
    parsed.lines.length
  );
  let cacheHits = 0;

  // 合成しないので同時実行はエンジンの audio_query 応答性のみに依存する。
  // フルモードと同じ TTS_CONCURRENCY を尊重する(既定は直列)。
  const TTS_CONCURRENCY = Math.max(1, Number(process.env.TTS_CONCURRENCY ?? 1));

  const collectLine = async (
    line: ParsedScriptLine,
    index: number
  ): Promise<void> => {
    const speedScale = line.speedScale ?? voice.speedScale;
    const wavPathForLine = path.join(narrationDir, `${line.lineId}.wav`);
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          line.text,
          speedScale,
          voice.speakerId,
          voice.pitchScale,
          voice.intonationScale,
        ])
      )
      .digest("hex");

    const cached = lineCache[line.lineId];
    if (cached && cached.hash === hash && existsSync(wavPathForLine)) {
      items[index] = { line, kana: cached.kana ?? "" };
      cacheHits++;
      return;
    }

    // synthesis は呼ばない。kana は audio_query の戻り値から得る。
    const aq = await fetchAudioQuery(line.text, voice.speakerId);
    items[index] = { line, kana: aq.kana ?? "" };
  };

  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++;
      if (i >= parsed.lines.length) return;
      await collectLine(parsed.lines[i], i);
    }
  };
  await Promise.all(Array.from({ length: TTS_CONCURRENCY }, () => worker()));

  const readingsPath = path.join(narrationDir, "readings.md");
  writeFileSync(readingsPath, renderReadingsReport(items));
  if (cacheHits > 0) {
    console.log(
      `cache: ${cacheHits}/${parsed.lines.length} 行の読みをキャッシュから再利用(合成なし)`
    );
  }
  console.log(
    `readings-only: ${readingsPath}(全${items.length}行、audio_queryのみ・合成/timing.json更新なし)`
  );
}

// ---- CLI エントリポイント -------------------------------------------------

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
    );
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const readingsOnly = args.includes("--readings-only");
  const episodeArg = args.find((a) => !a.startsWith("--"));
  if (!episodeArg) {
    console.error(
      "Usage: tts.ts <episodeDir> [--readings-only]  (例: episodes/<epId>)"
    );
    process.exit(1);
  }
  try {
    if (readingsOnly) {
      // 合成せず読み仮名レポートだけを更新する高速プリチェック。
      await runReadingsOnly(episodeArg);
    } else {
      await runTts(episodeArg);
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof TtsError || err instanceof Error) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error("Error: unknown tts failure");
    }
    process.exit(1);
  }
}

if (isMainModule()) {
  main();
}
