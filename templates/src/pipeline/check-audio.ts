/**
 * 音声の配線検査(HF経路・レンダー前ゲート)。
 *
 * なぜ必要か:
 *   ep012-octopus は audio-cues.json が未生成で <audio src> が narration.wav(ナレーション素)を
 *   指したまま、全編BGM/SEなしでレンダー・承認・コミットまで通った。既存のどのゲートも
 *   「<audio> が1本あって尺が合う」ことしか見ておらず、中身がミックス済みかを判定していない。
 *   scaffold-composition.ts が master.mp3 → narration.wav の順に**無警告でフォールバック**する
 *   ため、音声工程を飛ばしても正常系に見えてしまうのが事故の入口だった。
 *
 * 何を見るか(全部レンダー前に判定できる):
 *   1. audio-cues.json がある
 *   2. narration/master.mp3 がある
 *   3. composition.html の <audio src> が master.mp3 を指している(narration.wav のままでない)
 *   4. master が cues より新しい(cues を直して焼き直し忘れていない)
 *   5. master の尺が composition の data-duration と一致する
 *   6. master がナレーション素と実際に違う(= BGM/SE が乗っている)
 *      ナレーションの合間に音の床があるか(0.1秒窓RMSの下位10%点)で判定する。
 *      ここが「鳴っていない」を捕まえる本体。
 *
 * 使い方:
 *   npx tsx src/pipeline/check-audio.ts episodes/<epId>
 *
 * exit: 0 = OK / 1 = 契約違反 / 2 = 実行エラー
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/** master と narration の尺のずれの許容(秒) */
export const DURATION_TOLERANCE_SEC = 0.5;
/**
 * 「BGM/SE が乗っているか」の判定閾値(dB)。0.1秒窓 RMS の**下位10%点**に対して見る。
 *
 * 指標の選び方(ep012/ep011 の実測で較正):
 *   中央値では判定できない — 発話が支配的なので、ナレーション素でも -15〜-19dB になる。
 *   最小値でも判定できない — BGM を意図的に完全停止する区間(ep012 cL160〜cL184)が
 *   あると -200dB まで落ちる。「合間にどれだけ音の床があるか」を見る p10 が正しい。
 *     ミックス済み: ep012 = -44.8dB / ep011 = -31.3dB
 *     ナレーション素: -77.2dB
 *   両者の中間の -60dB を境にする(どちら側にも 15dB 以上の余裕)。
 */
export const SILENCE_FLOOR_DB = -60;
/** 無音窓(-inf)を数値として扱うときの下限 */
export const SILENT_WINDOW_DB = -200;
/**
 * master のトゥルーピークの天井(dBFS)。
 *
 * 実測: 完成mp4のピークは ep010 -0.9 / ep012 -0.5 / **ep011 +0.2(デジタルクリップ)**。
 * レンダー後QAは統合ラウドネス(-14 LUFS ±1.0)しか見ておらず、3本とも緑で通っていた。
 * mp3/AACの符号化で1dB程度オーバーシュートするので、master 側は -1.0 で止める
 * (audio-mix のリミッタは -1.5 dBFS を狙うので、正常に焼けていれば必ず余裕がある)。
 */
export const MASTER_PEAK_CEILING_DB = -1.0;

export interface AudioFinding {
  code: string;
  message: string;
}

/** composition.html の <audio id="master"> の src と data-duration を読む */
export function parseMasterAudio(html: string): { src: string; durationSec: number } | null {
  const tag = /<audio[^>]*\bid="master"[^>]*>/.exec(html)?.[0];
  if (!tag) return null;
  const src = /\ssrc="([^"]+)"/.exec(tag)?.[1];
  const dur = /\sdata-duration="([\d.]+)"/.exec(tag)?.[1];
  if (!src) return null;
  return { src, durationSec: dur ? Number(dur) : NaN };
}

export interface AudioFacts {
  hasCues: boolean;
  hasMaster: boolean;
  /** <audio src> が指すパス(composition 基準の相対パス) */
  audioSrc: string | null;
  audioDurationSec: number;
  /** master.mp3 の実尺 */
  masterDurationSec: number;
  /** cues.json より master が新しいか */
  masterFresherThanCues: boolean;
  /** master の 0.1秒窓 RMS の下位10%点(dB)。ナレーションの合間に音の床があるか */
  p10WindowDb: number;
  /** 参考: 0.1秒窓 RMS の中央値(dB) */
  medianWindowDb: number;
  /** master のトゥルーピーク(dBFS) */
  peakDb: number;
}

/** 事実から契約違反を判定する(純粋関数 — I/Oを持たない) */
export function evaluateAudio(facts: AudioFacts): AudioFinding[] {
  const out: AudioFinding[] = [];
  if (!facts.hasCues) {
    out.push({
      code: "no_audio_cues",
      message:
        "audio-cues.json がありません。BGM/SEの設計が音源に落ちていない状態です(ep012 の無音事故と同じ入口)",
    });
  }
  if (!facts.hasMaster) {
    out.push({ code: "no_master", message: "narration/master.mp3 がありません。npm run audio-mix を実行してください" });
  }
  if (facts.audioSrc === null) {
    out.push({ code: "no_audio_tag", message: 'composition.html に <audio id="master"> がありません' });
    return out;
  }
  if (!/master\.mp3$/.test(facts.audioSrc)) {
    out.push({
      code: "audio_src_not_master",
      message:
        `<audio src> が "${facts.audioSrc}" を指しています。ミックス済みの narration/master.mp3 を指してください` +
        "(narration.wav のままだと BGM も SE も鳴りません)",
    });
  }
  if (facts.hasMaster && !facts.masterFresherThanCues) {
    out.push({
      code: "master_stale",
      message: "audio-cues.json のほうが master.mp3 より新しいです。npm run audio-mix で焼き直してください",
    });
  }
  if (
    facts.hasMaster &&
    Number.isFinite(facts.audioDurationSec) &&
    Math.abs(facts.masterDurationSec - facts.audioDurationSec) > DURATION_TOLERANCE_SEC
  ) {
    out.push({
      code: "duration_mismatch",
      message:
        `master.mp3 の尺 ${facts.masterDurationSec.toFixed(3)}s が <audio data-duration> ` +
        `${facts.audioDurationSec.toFixed(3)}s と一致しません`,
    });
  }
  if (facts.hasMaster && Number.isFinite(facts.peakDb) && facts.peakDb > MASTER_PEAK_CEILING_DB) {
    out.push({
      code: "master_peak_hot",
      message:
        `master.mp3 のトゥルーピークが ${facts.peakDb.toFixed(1)} dBFS で、天井 ${MASTER_PEAK_CEILING_DB} dBFS を超えています。` +
        "ナレーション+BGM+SEの総和がクリップしています — npm run audio-mix で焼き直してください(リミッタが入ります)",
    });
  }
  if (facts.hasMaster && facts.p10WindowDb < SILENCE_FLOOR_DB) {
    out.push({
      code: "no_bed",
      message:
        `master.mp3 の音の床(下位10%点)が ${facts.p10WindowDb.toFixed(1)}dB しかありません。` +
        "ナレーションの合間に何も鳴っていない = BGM/SE が乗っていない疑いがあります",
    });
  }
  return out;
}

/* ----------------------------- 以下 CLI(I/O) ----------------------------- */

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

function probeDurationSec(file: string): number {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], {
    encoding: "utf8",
  });
  return Number((r.stdout ?? "").trim());
}

/** 0.1秒窓ごとの RMS(dB)を全部集める */
export function windowRmsDb(file: string): number[] {
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-nostats", "-i", file, "-vn",
      "-af", "asetnsamples=n=4800:p=0,astats=metadata=1:reset=1," +
        "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
      "-f", "null", "-",
    ],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }
  );
  const out: number[] = [];
  /* 完全無音の窓は -inf で出る。捨てると「無音がどれだけあるか」が消えるので下限値に丸める */
  for (const m of (r.stdout ?? "").matchAll(/=(-?[\d.]+|-inf)/g)) {
    out.push(m[1] === "-inf" ? SILENT_WINDOW_DB : Math.max(SILENT_WINDOW_DB, Number(m[1])));
  }
  return out;
}

/** ファイルのトゥルーピーク(dBFS)。測れなければ NaN */
export function truePeakDb(file: string): number {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=framelog=quiet:peak=true", "-f", "null", "-"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const m = /Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(r.stderr ?? "");
  if (!m) return NaN;
  return m[1] === "-inf" ? SILENT_WINDOW_DB : Number(m[1]);
}

/** 昇順の分位点(0..1) */
export function percentile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

function main(): void {
  const epArg = process.argv[2];
  if (!epArg) fail("使い方: npx tsx src/pipeline/check-audio.ts episodes/<epId>");
  const epDir = path.resolve(process.cwd(), epArg);
  const compositionPath = path.join(epDir, "composition.html");
  if (!existsSync(compositionPath)) fail("composition.html がありません(HF経路専用の検査です)");

  const cuesPath = path.join(epDir, "audio-cues.json");
  const masterPath = path.join(epDir, "narration", "master.mp3");
  const audio = parseMasterAudio(readFileSync(compositionPath, "utf8"));
  const hasMaster = existsSync(masterPath);
  const windows = hasMaster ? windowRmsDb(masterPath) : [];

  const facts: AudioFacts = {
    hasCues: existsSync(cuesPath),
    hasMaster,
    audioSrc: audio?.src ?? null,
    audioDurationSec: audio?.durationSec ?? NaN,
    masterDurationSec: hasMaster ? probeDurationSec(masterPath) : NaN,
    masterFresherThanCues:
      hasMaster && existsSync(cuesPath)
        ? statSync(masterPath).mtimeMs >= statSync(cuesPath).mtimeMs
        : hasMaster,
    p10WindowDb: percentile(windows, 0.1),
    medianWindowDb: percentile(windows, 0.5),
    peakDb: hasMaster ? truePeakDb(masterPath) : NaN,
  };

  const findings = evaluateAudio(facts);
  console.log(
    `音声の配線検査: src=${facts.audioSrc ?? "(なし)"} / master ${
      facts.hasMaster ? `${facts.masterDurationSec.toFixed(2)}s` : "なし"
    } / 音の床 p10=${facts.p10WindowDb.toFixed(1)}dB(中央値 ${facts.medianWindowDb.toFixed(1)}dB)` +
      ` / ピーク ${Number.isFinite(facts.peakDb) ? facts.peakDb.toFixed(1) : "?"}dBFS(天井 ${MASTER_PEAK_CEILING_DB})`
  );
  if (findings.length === 0) {
    console.log("OK: ナレーション+BGM+SEのミックスが正しく配線されています");
    process.exit(0);
  }
  for (const f of findings) console.error(`NG [${f.code}] ${f.message}`);
  process.exit(1);
}

/* テストから import したときは走らせない */
if (process.argv[1] && path.basename(process.argv[1]) === "check-audio.ts") main();
