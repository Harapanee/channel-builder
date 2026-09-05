/**
 * クリップを区間の尺へ収めて1本にする。
 *
 * v2(scratchpad_gen/minimax-style/10-remake)で実測して確立した知見:
 *  - クリップは切らずに**早回しして**区間に収める(先頭から切ると64%の行が描画途中で切れた)
 *  - 尺は秒でなく**フレーム数**で決める(秒で計算したら303本で +6.6秒ずれた)
 *  - 303本を1回の ffmpeg に渡せないので**区間(20本)ごとに焼く**
 *  - **字幕はその区間を焼くときに同時に重ねる**(全長に段階的に重ねると再エンコードを繰り返す)
 *  - 中間ファイルの再利用は「存在する」ではなく「尺が読める」で判定する(書き込み途中を完成品と誤認した事故)
 *  - エンコードは h264_videotoolbox(libx264 medium の13倍速・等倍で画質差なし)
 *  - 音は master.mp3(ナレーション+BGM)が主。ambient.wav(h3:ambient が生成クリップの音を
 *    まとめた環境音)があれば最終 mux でその下へ敷く。無ければ従来どおり master.mp3 のみ
 *
 * **尺の基準はタイムライン区間である。** 発話区間の合計にすると ep015 で 130.05秒短くなる
 * (Σ(endSec - startSec) = 844.89秒 に対し総尺 974.94秒)。
 *
 *   npm run h3:assemble -- <epId> [--out <名前.mp4>] [--plan]
 *
 * 既定の出力先 episodes/<epId>/out/final.mp4 に**既存ファイルがあれば1バイトも書かずに exit 2**。
 * HyperFrames 版の完成品が同じ場所にあり、episodes/<epId>/out/ は .gitignore なので復元できない。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SILENCE_FLOOR_DB, percentile, windowRmsDb } from "../check-audio";
import { OUT_FPS, ROOT, clipsDir, epBase } from "./config";
import type { TimingLine } from "./plan";
import type { Cut, CutsFile } from "./types";
import { figureOverlaysForChunk } from "./figures";
import type { FigureChunkOverlay, FigureIndex } from "./figures";

export interface Segment {
  clipId: string;
  lineIds: string[];
  /** 受け持ち区間の開始(絶対時刻) */
  startSec: number;
  /** 受け持ちフレーム数 */
  frames: number;
  /** 完成品の先頭からのフレーム数。字幕窓の計算に使う */
  offsetFrames: number;
  /** 早回しをやめて頭から等速で使う(cuts.json の holdSlow) */
  holdSlow: boolean;
  /** 字幕を敷かない(cuts.json の noSub)。画面内に文字を出すカット用 */
  noSub: boolean;
  /** 章カード(cuts.json の card)。文字は h3:figures が不透明な板として焼くので、生成クリップが無ければ紙色で合成する */
  card?: boolean;
}

/**
 * 組み立て前の master.mp3 の検査に要る事実。
 *
 * なぜ要るか(退行を作らないため):
 *   HF経路は `check:audio` が `no_bed`(BGM/SEが乗っていない)と `master_stale`
 *   (cues を直したのに焼き直していない)で止める。H3経路は composition.html を持たず
 *   `check:audio` を走らせないので、**bgm-plan.json を直す → h3:audio-cues → audio-mix を
 *   忘れる → assemble が古い master.mp3 を載せて正常終了**、が素通りしてしまう。
 *   ep012-octopus の全編無音事故はまさにこの型だった。判定の閾値と計測は check-audio.ts の
 *   ものをそのまま使う(import するだけ。あちらは HF_IDENTICAL で1バイトも変えない)。
 *
 *   SE台帳の突合(`se_ledger_stale`)はH3に台帳が無いので入れない。
 *   ラウドネス・ピークの判定は audio-mix の担当なので入れない。
 */
export interface MasterAudioFacts {
  /** master.mp3 の 0.1秒窓 RMS の下位10%点(dB) */
  p10WindowDb: number;
  masterMtimeMs: number;
  /** audio-cues.json の更新時刻。cues が無ければ 0(焼き直し漏れは判定しない) */
  cuesMtimeMs: number;
}

/** master.mp3 の契約違反を判定する(純粋関数 — I/Oを持たない) */
export function checkMasterAudio(facts: MasterAudioFacts): string[] {
  const out: string[] = [];
  if (facts.p10WindowDb < SILENCE_FLOOR_DB) {
    out.push(
      "no_bed: master.mp3 の音の床(下位10%点)が " + facts.p10WindowDb.toFixed(1) + "dB しかありません"
        + "(下限 " + SILENCE_FLOOR_DB + "dB)。ナレーションの合間に何も鳴っていない = BGM が乗っていません。"
        + "bgm-plan.json の envelope が全時間帯を覆っているかを見てから npm run audio-mix"
    );
  }
  if (facts.cuesMtimeMs > 0 && facts.masterMtimeMs < facts.cuesMtimeMs) {
    out.push(
      "master_stale: audio-cues.json のほうが master.mp3 より新しいです。"
        + "音を作り直し忘れています — npm run audio-mix episodes/<epId>"
    );
  }
  return out;
}

/**
 * ambient.wav の検査に要る事実。
 *
 * なぜ要るか(checkMasterAudio と非対称にしないため):
 *   `amix=duration=first` は入力の長さの食い違いを完全に隠す。台本修正 → npm run tts で
 *   timing.json が変わっても ambient.wav は焼き直さない限り旧尺のままで、それでも
 *   assemble は正常終了して**全区間ずれた音**を完成品に載せる。不合格クリップを
 *   作り直した場合も同様に、作り直す前の音がそのまま残る(尺が変わらないので気づけない)。
 *   master.mp3 にはこの型の事故(ep012-octopus の全編無音)を防ぐ checkMasterAudio が
 *   既にあり、ambient にだけ同じ砦が無いのは非対称である。
 */
export interface AmbientAudioFacts {
  /** ambient.wav の実尺(秒) */
  ambientDurationSec: number;
  /** timing.json の総尺(秒)。ambient.wav はこれと一致していなければならない */
  totalDurationSec: number;
  ambientMtimeMs: number;
  timingMtimeMs: number;
  cutsMtimeMs: number;
}

/** ambient.wav の契約違反を判定する(純粋関数 — I/Oを持たない) */
export function checkAmbient(facts: AmbientAudioFacts): string[] {
  const out: string[] = [];
  const diff = Math.abs(facts.ambientDurationSec - facts.totalDurationSec);
  if (diff > 0.05) {
    out.push(
      "ambient_duration_mismatch: ambient.wav が " + facts.ambientDurationSec.toFixed(2) + "秒"
        + " / 総尺 " + facts.totalDurationSec.toFixed(2) + "秒(差 " + diff.toFixed(2) + "秒)。"
        + "npm run h3:ambient -- <epId> で焼き直してください"
    );
  }
  if (facts.timingMtimeMs > facts.ambientMtimeMs) {
    out.push(
      "ambient_stale: timing.json のほうが ambient.wav より新しいです。"
        + "台本修正を反映していません — npm run h3:ambient -- <epId>"
    );
  }
  if (facts.cutsMtimeMs > facts.ambientMtimeMs) {
    out.push(
      "ambient_stale: cuts.json のほうが ambient.wav より新しいです。"
        + "カット(不合格クリップの作り直し等)を反映していません — npm run h3:ambient -- <epId>"
    );
  }
  return out;
}

/** narration/ambient.wav の場所。assemble.ts と preview-chapter.ts で共有する(プレビューと本番の一致が要) */
export function ambientPath(epId: string): string {
  return join(ROOT, "episodes", epId, "narration", "ambient.wav");
}

function boundsOf(cut: Cut, lines: TimingLine[], totalDurationSec: number): { start: number; stop: number } {
  if (cut.lineIds.length === 0) throw new Error("lineIds が空のカットがあります(cuts.json が壊れています)");
  const index = new Map(lines.map((l, i) => [l.lineId, i]));
  const headId = cut.lineIds[0];
  const tailId = cut.lineIds[cut.lineIds.length - 1];
  const first = index.get(headId);
  const last = index.get(tailId);
  if (first === undefined) throw new Error("timing.json に " + headId + " がありません(cuts.json と食い違っている)");
  if (last === undefined) throw new Error("timing.json に " + tailId + " がありません(cuts.json と食い違っている)");
  return {
    start: lines[first].startSec,
    stop: last + 1 < lines.length ? lines[last + 1].startSec : totalDurationSec,
  };
}

/** カットが受け持つタイムライン区間を、完成品の fps でフレーム数にする */
export function targetFrames(cut: Cut, lines: TimingLine[], totalDurationSec: number, fps: number): number {
  const { start, stop } = boundsOf(cut, lines, totalDurationSec);
  return Math.round(stop * fps) - Math.round(start * fps);
}

/**
 * クリップの並びを組む。
 * offsetFrames は「積み上げたフレーム数」であり、同時に「Math.round(startSec * fps)」と一致する。
 * 字幕の表示窓を絶対時刻からの引き算で出しているため、この恒等式が崩れると字幕がずれる。
 * カットがタイムラインを隙間なく覆っていなければ崩れるので、その場で止める。
 */
export function buildSegments(
  cuts: Record<string, Cut>,
  lines: TimingLine[],
  totalDurationSec: number,
  fps: number,
): Segment[] {
  const entries = Object.entries(cuts)
    .map(([clipId, cut]) => ({ clipId, cut, ...boundsOf(cut, lines, totalDurationSec) }))
    .sort((a, b) => a.start - b.start);
  let cursor = 0;
  return entries.map((e) => {
    const offsetFrames = Math.round(e.start * fps);
    if (cursor !== offsetFrames) {
      throw new Error(
        e.clipId + " で字幕窓の恒等式が崩れます(積み上げ " + cursor + "F / 絶対時刻 " + offsetFrames +
          "F)。カットがタイムラインを隙間なく覆っていません",
      );
    }
    const frames = Math.round(e.stop * fps) - offsetFrames;
    cursor += frames;
    return {
      clipId: e.clipId, lineIds: e.cut.lineIds, startSec: e.start, frames, offsetFrames,
      holdSlow: Boolean(e.cut.holdSlow),
      noSub: Boolean(e.cut.noSub),
      card: Boolean(e.cut.card),
    };
  });
}

/** 元のフレーム数を目標フレーム数へ合わせる setpts フィルタ */
export function speedFilter(srcFrames: number, dstFrames: number): string {
  return "setpts=" + (dstFrames / srcFrames).toFixed(6) + "*PTS";
}

/**
 * クリップを区間へ収めるフィルタ。
 *
 * 既定は `setpts` で目標フレーム数へ詰める(早回し)。**holdSlow のときは伸縮しない** —
 * 後段の `trim=end_frame=<目標>` が頭から必要ぶんだけ切るので、等速のまま尺が合う。
 * 代わりにクリップ後半の絵は落ちるので、書き手は先頭で完結する構図にする必要がある。
 */
export function videoFilter(srcFrames: number, dstFrames: number, holdSlow = false): string {
  return holdSlow ? "null" : speedFilter(srcFrames, dstFrames);
}

export interface OverlayWindow {
  lineId: string;
  /** 字幕PNG(台帳 subs.json の png)。無ければ sub_<lineId>.png */
  png?: string;
  /** 区間の先頭を 0 とした表示開始(秒・文字列) */
  from: string;
  /** 同・表示終了。発話の終わり(endSec)で消す。次の行が始まるまでの無音では字幕を出さない */
  to: string;
}

/**
 * 1クリップに乗る字幕の表示窓。**束ねたカットは複数行ぶん返る。**
 * 絶対時刻(Math.round(秒 * fps))から区間先頭のフレーム数を引く。この式は
 * offsetFrames が絶対時刻と一致していること(= buildSegments の恒等式)が前提。
 */
export interface SubEntry {
  png: string;
  start: number;
  end: number;
}

/** subs/subs.json(h3:subs の台帳)を行IDごとにまとめる。1行が複数の文に分かれていれば複数件 */
export function subsByLine(entries: { id: string; png: string; start: number; end: number }[]): Map<string, SubEntry[]> {
  const m = new Map<string, SubEntry[]>();
  for (const e of entries) {
    const list = m.get(e.id) ?? [];
    list.push({ png: e.png, start: e.start, end: e.end });
    m.set(e.id, list);
  }
  for (const list of m.values()) list.sort((a, b) => a.start - b.start);
  return m;
}

export function overlayWindows(
  segment: Segment,
  lineById: Map<string, TimingLine>,
  baseFrames: number,
  fps: number,
  ledger?: Map<string, SubEntry[]>,
): OverlayWindow[] {
  // noSub のカットは画面の中に文字を持っている。字幕を重ねると同じ意味を二度読ませることになる。
  // **表示窓を返さないだけで、字幕PNG の有無は問わない**(呼び出し側の存在検査も noSub を飛ばす)。
  if (segment.noSub) return [];
  const win = (start: number, end: number) => ({
    from: ((Math.round(start * fps) - baseFrames) / fps).toFixed(3),
    to: ((Math.round(end * fps) - baseFrames) / fps).toFixed(3),
  });
  return segment.lineIds.flatMap((lineId) => {
    const line = lineById.get(lineId);
    if (!line) throw new Error("timing.json に " + lineId + " がありません(cuts.json と食い違っている)");
    // 台帳(1回の表示=1文)があればそれを使う。無い行は従来どおり行全体を1枚
    const subs = ledger?.get(lineId);
    if (subs && subs.length > 0) return subs.map((e) => ({ lineId, png: e.png, ...win(e.start, e.end) }));
    return [{ lineId, ...win(line.startSec, line.endSec) }];
  });
}

export interface PartCacheClip {
  id: string;
  frames: number;
  src: number;
  holdSlow: boolean;
  /**
   * クリップファイルの mtime(ms)。**中身までは見ていない鍵の穴を塞ぐ**:
   * 不合格クリップを同じ frames・同じパスのまま焼き直すと id/frames/src/holdSlow は
   * 何も変わらないため、鍵が同一になり古い part がそのまま再利用される
   * (ffmpeg が途中で落ちた実行のあとに part が残っていると起きる)。
   * ファイルの更新時刻を鍵に含めることで、作り直したクリップは必ず新しい part を焼く。
   */
  mtimeMs: number;
}

/**
 * 焼き済み part(assemble-parts / preview-parts-*)を再利用してよいかの判定に使う鍵。
 *
 * `holdSlow` は画面に出ない値だが `videoFilter` の出力(setpts か null か)を切り替えるため、
 * ここに含めないと「cuts.json で holdSlow を立てて焼き直しても、まだ holdSlow を知らない
 * 頃に早回しで焼いた古い part がそのまま再利用される」という、検査を素通りする事故になる。
 * assemble.ts と preview-chapter.ts の両方がここを通ることで、鍵の作法を一本化する。
 */
export function partCacheSpec(base: number, clips: PartCacheClip[], overlays: OverlayWindow[], figures: FigureChunkOverlay[] = []): string {
  return JSON.stringify(figures.length === 0 ? { base, clips, overlays } : { base, clips, overlays, figures });
}

/**
 * holdSlow のカットは早回しをやめて頭から等速で必要フレームだけ使う(§5.1.3)。
 * その受け皿は `trim=end_frame=<目標>` だけであり、**素材フレーム数が目標に届かないと
 * 超過ぶんを黙って無視するだけでエラーにならない**(実機確認: 48F の素材に
 * end_frame=72 を掛けても48Fが出るだけ)。setpts のような伸縮の受け皿が無いぶん、
 * 早回しでは起きない「そのまま欠損」が起きる。焼く前に止める材料をここで作る。
 */
export function holdSlowShortfalls(clips: PartCacheClip[]): PartCacheClip[] {
  return clips.filter((c) => c.holdSlow && c.src < c.frames);
}

/** ffprobe の r_frame_rate("24/1" の形)を数値にする */
export function parseFrameRate(raw: string | undefined): number {
  const [num, den] = String(raw ?? "").split("/").map(Number);
  const fps = den ? num / den : num;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("fps が読めません(r_frame_rate=" + raw + ")");
  return fps;
}

/**
 * 素材の fps が完成品の fps と揃っていることを確かめる。
 *
 * **早回し倍率をフレーム比(dstFrames / srcFrames)で出しているため、これは fps 非依存ではない。**
 * 24fps 以外の素材が混ざると倍率が fps 比のぶんだけ狂い、`trim=end_frame` で切る側では
 * 区間が目標より短くなる。エラーにならず**以降の字幕だけが静かにずれる**ので、ここで止める。
 * H3 の出力は 24fps 固定なので、24 でないものが混ざっていること自体が異常である。
 */
export function assertUniformFps(clips: { clipId: string; fps: number }[], fps: number): void {
  const odd = clips.filter((c) => Math.abs(c.fps - fps) > 1e-6);
  if (odd.length === 0) return;
  throw new Error(
    fps + "fps 以外の素材が " + odd.length + "本あります(早回し倍率はフレーム比なので、fps が違うと"
    + "倍率ごと狂って区間が短くなり、以降の字幕が静かにずれます): "
    + odd.slice(0, 20).map((c) => c.clipId + "=" + c.fps + "fps").join(", ")
    + (odd.length > 20 ? " ..." : ""),
  );
}

// ───────────────────────── ここから CLI(import では走らない) ─────────────────────────

/*
 * この下の ffmpeg ヘルパ(CHUNK / probeClip / sourceFrames / durationOf / isUsable / runFfmpeg)には
 * export を足してある。preview-chapter.ts(章プレビュー)が同じ組み立てをするためで、
 * 複製すると「早回しは frames 比・再利用は尺が読めるかで判定」といった実測由来の作法が
 * 二重メンテになり、片側だけ直る事故が起きる。**足したのは export キーワードだけで、
 * 中身と main() の流れは1文字も変えていない。**
 */

export const CHUNK = 20;

interface Options {
  epId: string;
  outName: string;
  plan: boolean;
  /** 図解を置かない(figures.json 無しを明示的に許す) */
  noFigures: boolean;
}

export function parseArgs(argv: string[]): Options {
  let epId = "";
  let outName = "final.mp4";
  let plan = false;
  let noFigures = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") {
      outName = argv[i + 1] ?? "";
      i += 1;
    } else if (a === "--plan") {
      plan = true;
    } else if (a === "--no-figures") {
      noFigures = true;
    } else if (!a.startsWith("--")) {
      epId = a;
    } else {
      throw new Error("知らない引数です: " + a);
    }
  }
  if (!epId) throw new Error("使い方: npm run h3:assemble -- <epId> [--out <名前.mp4>] [--plan] [--no-figures]");
  if (!outName || outName !== basename(outName) || outName.startsWith(".")) {
    throw new Error("--out はファイル名だけで指定してください(out/ の外へは書きません): " + outName);
  }
  return { epId, outName, plan, noFigures };
}

function ffprobeJson(path: string): { streams?: { nb_frames?: string; r_frame_rate?: string }[]; format?: { duration?: string } } {
  const raw = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames,r_frame_rate",
      "-show_entries", "format=duration", "-of", "json", path],
    { encoding: "utf8" },
  );
  return JSON.parse(raw);
}

const probeCache = new Map<string, { frames: number; fps: number }>();
/** クリップの実フレーム数と fps。nb_frames が無いコンテナのために尺×fps で補う */
export function probeClip(path: string): { frames: number; fps: number } {
  const hit = probeCache.get(path);
  if (hit !== undefined) return hit;
  const j = ffprobeJson(path);
  const st = j.streams?.[0] ?? {};
  const fps = parseFrameRate(st.r_frame_rate);
  let n = Number(st.nb_frames);
  if (!Number.isFinite(n) || n <= 0) n = Math.round(Number(j.format?.duration ?? 0) * fps);
  if (!Number.isFinite(n) || n <= 0) throw new Error("フレーム数が読めません: " + path);
  const probe = { frames: n, fps };
  probeCache.set(path, probe);
  return probe;
}

export const sourceFrames = (path: string): number => probeClip(path).frames;

export function durationOf(path: string): number {
  return Number(execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
    { encoding: "utf8" },
  ).trim());
}

/** 「存在する」ではなく「尺が読める」で焼き直しを判定する(書きかけを完成品と誤認しない) */
export function isUsable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return durationOf(path) > 0.1;
  } catch {
    return false;
  }
}

export function runFfmpeg(args: string[]): void {
  try {
    execFileSync("ffmpeg", ["-v", "error", ...args], { encoding: "utf8" });
  } catch (e) {
    const err = e as { stderr?: string };
    throw new Error("ffmpeg が失敗しました:\n" + (err.stderr ?? String(e)).slice(-4000));
  }
}

/**
 * mux 後の出力を `-af volumedetect` に通し、音量ピーク(max_volume・dB)を得る。
 *
 * 設計 §5.2.4 は「リミッタは掛けない」とセットでこの検査を要求している —
 * 敷き量(ambient.json の gainDb)を実測で上げる判断が今後入るため、上げすぎて総和が
 * -1.0dBFS を超えても何も鳴らない検査になっていた。**これは警告で止めない**
 * (設計が「警告を出す」とだけ書いているため)。
 *
 * volumedetect の出力は stderr(info レベル)に出る。runFfmpeg は `-v error` で
 * 揉み消してしまうため、ここだけ spawnSync で別に呼ぶ。
 */
export function maxVolumeDb(path: string): number {
  const r = spawnSync("ffmpeg", ["-i", path, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const text = (r.stderr ?? "") + (r.stdout ?? "");
  const m = text.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  if (!m) throw new Error("max_volume が読めません: " + path);
  return Number(m[1]);
}

function main(): void {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error("❌ " + (e as Error).message);
    process.exit(2);
  }
  const { epId, outName } = opts;

  const outDir = join(ROOT, "episodes", epId, "out");
  const outPath = join(outDir, outName);
  // ここより前では何も書かない。既存の完成品(HyperFrames 版など)は .gitignore で復元できない
  if (existsSync(outPath)) {
    console.error("❌ " + outPath + " が既にあります。上書きしません");
    console.error("   別名で焼くなら: npm run h3:assemble -- " + epId + " --out final-h3.mp4");
    process.exit(2);
  }

  const timingPath = join(ROOT, "episodes", epId, "timing.json");
  const cutsPath = join(ROOT, "h3/episodes", epId, "cuts.json");
  const subsDir = join(ROOT, "h3/episodes", epId, "subs");
  const masterPath = join(ROOT, "episodes", epId, "narration", "master.mp3");
  for (const [what, p] of [["timing.json", timingPath], ["cuts.json", cutsPath], ["master.mp3", masterPath]]) {
    if (!existsSync(p)) {
      console.error("❌ " + what + " がありません: " + p);
      process.exit(1);
    }
  }

  const timing = JSON.parse(readFileSync(timingPath, "utf8")) as { totalDurationSec: number; lines: TimingLine[] };
  const cutsFile = JSON.parse(readFileSync(cutsPath, "utf8")) as CutsFile;
  const lineById = new Map(timing.lines.map((l) => [l.lineId, l]));
  const segments = buildSegments(cutsFile.cuts, timing.lines, timing.totalDurationSec, OUT_FPS);

  const clipPath = (s: Segment): string => join(clipsDir(epId), s.clipId + ".mp4");
  /**
   * 章カードで生成クリップが無いカットは紙色の静止映像を合成する(2026-09-05)。
   * 文字は h3:figures の card-<id> が不透明な板として上に載るので、下は何でもよい。
   * これにより章カードは GPU で生成しなくてよい(生成してあればそれを使う。見えないので差は無い)。
   */
  const synth = (s: Segment): boolean => Boolean(s.card) && !existsSync(clipPath(s));
  const srcFrames = (s: Segment): number => (synth(s) ? s.frames : sourceFrames(clipPath(s)));
  const srcMtime = (s: Segment): number => (synth(s) ? 0 : statSync(clipPath(s)).mtimeMs);
  const PAPER = "0xF4F1E7";
  const clipInputArgs = (s: Segment): string[] => synth(s)
    ? ["-f", "lavfi", "-i", "color=c=" + PAPER + ":s=1920x1080:r=" + OUT_FPS + ":d=" + (s.frames / OUT_FPS + 0.5).toFixed(3)]
    : ["-i", clipPath(s)];
  const subPath = (o: { lineId: string; png?: string }): string => o.png ?? join(subsDir, "sub_" + o.lineId + ".png");
  const ledgerPath = join(subsDir, "subs.json");
  const ledger = existsSync(ledgerPath)
    ? subsByLine(JSON.parse(readFileSync(ledgerPath, "utf8")) as { id: string; png: string; start: number; end: number }[])
    : undefined;

  const missingClips = segments.filter((s) => !existsSync(clipPath(s)) && !s.card);
  const synthCards = segments.filter(synth);
  if (synthCards.length > 0) console.log("章カード " + synthCards.length + "本は生成クリップが無いので紙色で合成します(文字は figures の card-* が載る): " + synthCards.map((s) => s.clipId).join(", "));
  if (missingClips.length > 0) {
    console.error("❌ 素材が足りません: " + missingClips.length + "本");
    console.error("   " + missingClips.slice(0, 20).map((s) => s.clipId).join(", ") + (missingClips.length > 20 ? " ..." : ""));
    process.exit(1);
  }
  const missingSubs = segments.filter((s) => !s.noSub)
    .flatMap((s) => overlayWindows(s, lineById, 0, OUT_FPS, ledger))
    .filter((o) => !existsSync(subPath(o))).map((o) => o.lineId);
  if (missingSubs.length > 0) {
    console.error("❌ 字幕PNGが足りません: " + missingSubs.length + "枚(" + missingSubs.slice(0, 10).join(", ") + ")");
    console.error("   先に: python3 src/pipeline/h3/render-subs.py " + epId);
    process.exit(1);
  }

  const totalFrames = segments.reduce((s, x) => s + x.frames, 0);
  const wantFrames = Math.round(timing.totalDurationSec * OUT_FPS);
  console.log("カット " + segments.length + "本 / " + totalFrames + "F(" + (totalFrames / OUT_FPS).toFixed(2) + "秒)"
    + " / 台本の総尺 " + timing.totalDurationSec.toFixed(2) + "秒(" + wantFrames + "F)");
  if (totalFrames !== wantFrames) {
    console.error("❌ フレーム合計が総尺と合いません(差 " + (totalFrames - wantFrames) + "F)");
    process.exit(1);
  }

  try {
    assertUniformFps(segments.filter((s) => !synth(s)).map((s) => ({ clipId: s.clipId, fps: probeClip(clipPath(s)).fps })), OUT_FPS);
  } catch (e) {
    console.error("❌ " + (e as Error).message);
    process.exit(1);
  }

  const slow = segments
    .map((s) => ({ s, ratio: s.frames / srcFrames(s) }))
    .filter((x) => x.ratio > 1);
  if (slow.length === 0) {
    console.log("早回し率が 1.0 を超えるクリップ: 0件(すべて生成尺が足りています)");
  } else {
    // holdSlow でない限り、この不足は setpts が引き伸ばしてスロー再生で吸収する(実害は見た目だけ)。
    // holdSlow のクリップは下の holdSlowShortfalls が別に検出し、そちらは異常終了させる
    console.log("⚠️ 生成尺が足りず setpts で引き伸ばされる(スロー再生になる)クリップ: " + slow.length + "件"
      + "(holdSlow のカットはここに出ません。素材不足なら焼く前に異常終了します)");
    for (const x of slow) {
      console.log("   " + x.s.clipId + " 目標 " + x.s.frames + "F / 素材 " + srcFrames(x.s)
        + "F → ×" + x.ratio.toFixed(4));
    }
  }

  // holdSlow は伸縮の受け皿(setpts)を持たない。素材フレームが足りなければ trim が黙って
  // 欠損させるだけなので、焼く前にここで止める(指摘1: 検査が緑なのに尺が欠ける型)
  {
    const clips: PartCacheClip[] = segments.map((s) => ({
      id: s.clipId, frames: s.frames, src: srcFrames(s), holdSlow: s.holdSlow,
      mtimeMs: srcMtime(s),
    }));
    const shortfalls = holdSlowShortfalls(clips);
    if (shortfalls.length > 0) {
      console.error("❌ holdSlow のカットで素材フレームが目標に届きません(焼くと欠損したまま完走します): "
        + shortfalls.length + "件");
      for (const x of shortfalls) {
        console.error("   " + x.id + " 目標 " + x.frames + "F / 素材 " + x.src + "F(不足 " + (x.frames - x.src) + "F)");
      }
      console.error("   trim=end_frame は超過分を黙って無視するだけでエラーになりません。"
        + "cuts.json の seconds を伸ばすか、holdSlow を外してください");
      process.exit(1);
    }
  }

  /* 音の検査(HF経路の check:audio が持っている砦を、H3経路でも失わないため)。
     ここで止めないと、古い master.mp3 を載せた完成品が「正常終了」で出てくる */
  {
    const cuesPath = join(ROOT, "episodes", epId, "audio-cues.json");
    if (!existsSync(cuesPath)) {
      console.log("⚠️ audio-cues.json が無いので焼き直し漏れ(master_stale)の検査はできません");
    }
    const facts: MasterAudioFacts = {
      p10WindowDb: percentile(windowRmsDb(masterPath), 0.1),
      masterMtimeMs: statSync(masterPath).mtimeMs,
      cuesMtimeMs: existsSync(cuesPath) ? statSync(cuesPath).mtimeMs : 0,
    };
    const problems = checkMasterAudio(facts);
    console.log("master.mp3 の音の床(p10): " + facts.p10WindowDb.toFixed(1) + "dB"
      + (problems.length === 0 ? "(検査OK)" : ""));
    if (problems.length > 0) {
      for (const m of problems) console.error("❌ " + m);
      process.exit(1);
    }
  }

  /* 図解(h3:figures の出力)。無ければ従来どおり字幕だけ。あれば宣言より新しいことを確かめる。
     章カード(card-<id>)も同じ index に入る(cuts.json の card から h3:figures が焼く) */
  const figIndexPath = join(ROOT, "h3/episodes", epId, "figures", "index.json");
  const figDeclPath = join(ROOT, "h3/episodes", epId, "figures.json");
  let figEntries: FigureIndex["entries"] = [];
  if (!existsSync(figDeclPath) && !opts.noFigures) {
    console.error("❌ figures.json がありません: " + figDeclPath);
    console.error("   H3経路の本編は図解オーバーレイを必須にしている(bible §8・2026-09-04)。figure-planner に宣言を書かせて");
    console.error("   `npm run h3:figures -- " + epId + "` を通すか、図解を置かない判断なら --no-figures を明示する");
    process.exit(1);
  }
  if (!existsSync(figDeclPath) && segments.some((s) => s.card)) {
    console.log("⚠️ --no-figures のため章カードの板を重ねません(H3 生成のカードの文字がそのまま出ます)");
  }
  if (existsSync(figDeclPath)) {
    if (!existsSync(figIndexPath)) {
      console.error("❌ figures.json はあるのに figures/index.json がありません。先に: npm run h3:figures -- " + epId);
      process.exit(1);
    }
    if (statSync(figIndexPath).mtimeMs < statSync(figDeclPath).mtimeMs) {
      console.error("❌ figures.json が figures/index.json より新しい(焼き直し漏れ)。先に: npm run h3:figures -- " + epId);
      process.exit(1);
    }
    const idx = JSON.parse(readFileSync(figIndexPath, "utf8")) as FigureIndex;
    if (idx.fps !== OUT_FPS) { console.error("❌ figures/index.json の fps が " + idx.fps + "(期待 " + OUT_FPS + ")"); process.exit(1); }
    figEntries = idx.entries;
    for (const e of figEntries) {
      const last = join(e.dir, "f" + String(e.frames - 1).padStart(5, "0") + ".png");
      if (!existsSync(join(e.dir, "f00000.png")) || !existsSync(last)) {
        console.error("❌ 図解の連番が足りません: " + e.id + "(" + e.frames + "F)。npm run h3:figures -- " + epId);
        process.exit(1);
      }
    }
    // 章カードは card-<id> として index に居なければならない(cuts.json の card を h3:figures が焼く)
    const cardMissing = segments.filter((s) => s.card && !figEntries.some((e) => e.id === "card-" + s.clipId));
    if (cardMissing.length > 0) {
      console.error("❌ 章カードの板が figures/index.json にありません: " + cardMissing.map((s) => s.clipId).join(", "));
      console.error("   章カードの文字は H3 に描かせず h3:figures が焼く(2026-09-05)。先に: npm run h3:figures -- " + epId);
      process.exit(1);
    }
    console.log("図解: " + figEntries.filter((e) => e.kind !== "card").length + "本 + 章カード " + figEntries.filter((e) => e.kind === "card").length + "本を重ねます");
  }

  if (opts.plan) {
    console.log("--plan なのでここまで(何も書いていません)。出力予定: " + outPath);
    return;
  }

  const parts = join(epBase(epId), "assemble-parts");
  mkdirSync(parts, { recursive: true });

  const chunks: Segment[][] = [];
  for (let i = 0; i < segments.length; i += CHUNK) chunks.push(segments.slice(i, i + CHUNK));

  const partFiles: string[] = [];
  chunks.forEach((chunk, ci) => {
    const base = chunk[0].offsetFrames;
    // 字幕は「そのクリップに乗る行」を全部重ねる(束ねたカットは1クリップに複数行)
    const overlays = chunk.flatMap((s) => overlayWindows(s, lineById, base, OUT_FPS, ledger));
    const chunkFrames = chunk.reduce((a, s) => a + s.frames, 0);
    const figs = figureOverlaysForChunk(figEntries, base, chunkFrames, OUT_FPS)
      .map((f) => ({ ...f, mtimeMs: statSync(join(f.dir, "f" + String(f.startNumber).padStart(5, "0") + ".png")).mtimeMs }));

    const spec = partCacheSpec(
      base,
      chunk.map((s) => ({
        id: s.clipId, frames: s.frames, src: srcFrames(s), holdSlow: s.holdSlow,
        mtimeMs: srcMtime(s),
      })),
      overlays,
      figs,
    );
    const tag = createHash("sha1").update(spec).digest("hex").slice(0, 8);
    const dest = join(parts, "part" + String(ci).padStart(3, "0") + "-" + tag + ".mp4");
    partFiles.push(dest);
    if (isUsable(dest)) {
      console.log("  区間 " + (ci + 1) + "/" + chunks.length + "(焼き済みを再利用)");
      return;
    }

    const args = ["-y"];
    for (const s of chunk) args.push(...clipInputArgs(s));
    for (const o of overlays) args.push("-i", subPath(o));
    // 図解の連番は必要な範囲だけ読む(-start_number)。入力番号は字幕の後ろに続く
    for (const g of figs) args.push("-framerate", String(OUT_FPS), "-start_number", String(g.startNumber), "-i", join(g.dir, "f%05d.png"));

    const f = chunk.map((s, i) =>
      "[" + i + ":v]" + videoFilter(srcFrames(s), s.frames, s.holdSlow)
      + ",fps=" + OUT_FPS + ",trim=start_frame=0:end_frame=" + s.frames + ",setpts=PTS-STARTPTS"
      + ",scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,format=yuv420p[v" + i + "]");
    f.push(chunk.map((_, i) => "[v" + i + "]").join("") + "concat=n=" + chunk.length + ":v=1:a=0[cat]");

    let chain = "[cat]";
    // 図解は映像の上・字幕の下に重ねる(暗転は図解側に焼き込み済み)
    figs.forEach((g, k) => {
      const inIdx = chunk.length + overlays.length + k;
      const end = (Number(g.atSec) + g.frames / OUT_FPS).toFixed(3);
      f.push("[" + inIdx + ":v]trim=end_frame=" + g.frames + ",setpts=PTS-STARTPTS+" + g.atSec + "/TB[fg" + k + "]");
      f.push(chain + "[fg" + k + "]overlay=0:0:eof_action=pass:enable='between(t," + g.atSec + "," + end + ")'[g" + k + "]");
      chain = "[g" + k + "]";
    });
    if (overlays.length === 0) {
      f.push(chain + "null[vout]");
    } else {
      overlays.forEach((o, k) => {
        const label = k === overlays.length - 1 ? "[vout]" : "[o" + k + "]";
        f.push(chain + "[" + (chunk.length + k) + ":v]overlay=0:0:enable='between(t," + o.from + "," + o.to + ")'" + label);
        chain = "[o" + k + "]";
      });
    }

    args.push("-filter_complex", f.join(";"), "-map", "[vout]",
      "-c:v", "h264_videotoolbox", "-b:v", "12M", "-pix_fmt", "yuv420p", dest);
    const t0 = Date.now();
    runFfmpeg(args);
    console.log("  区間 " + (ci + 1) + "/" + chunks.length + "(" + ((Date.now() - t0) / 1000).toFixed(1) + "秒)");
  });

  const listPath = join(parts, "list.txt");
  writeFileSync(listPath, partFiles.map((p) => "file '" + p + "'").join("\n") + "\n");
  const silent = join(parts, "video-subbed.mp4");
  runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", silent]);
  {
    const d = durationOf(silent);
    console.log("連結: " + d.toFixed(2) + "秒(音声 " + timing.totalDurationSec.toFixed(2)
      + "秒 / 差 " + (d - timing.totalDurationSec).toFixed(2) + "秒)");
    if (Math.abs(d - timing.totalDurationSec) > 0.5) console.log("⚠️ 尺がずれています");
  }

  mkdirSync(outDir, { recursive: true });
  // ambient.wav は前段(h3:ambient)が焼いた環境音。無いエピソード(未焼き・旧作)は
  // 従来どおり master.mp3 だけを載せる経路へ落とす
  const ambientWav = ambientPath(epId);
  const hasAmbient = existsSync(ambientWav);
  if (hasAmbient) {
    // ambient.wav の鮮度・尺を検査する(指摘2: master.mp3 と非対称にしないため)。
    // amix=duration=first は長さの食い違いを完全に隠すので、ここで止めないと
    // 古い/尺のずれた ambient.wav がそのまま完成品に乗る
    const facts: AmbientAudioFacts = {
      ambientDurationSec: durationOf(ambientWav),
      totalDurationSec: timing.totalDurationSec,
      ambientMtimeMs: statSync(ambientWav).mtimeMs,
      timingMtimeMs: statSync(timingPath).mtimeMs,
      cutsMtimeMs: statSync(cutsPath).mtimeMs,
    };
    const problems = checkAmbient(facts);
    if (problems.length > 0) {
      for (const m of problems) console.error("❌ " + m);
      process.exit(1);
    }
    console.log("環境音: ambient.wav を敷きます(検査OK)");
  } else {
    console.log("環境音: ambient.wav が無いので敷きません");
  }
  runFfmpeg(hasAmbient
    ? ["-y", "-i", silent, "-i", masterPath, "-i", ambientWav,
       // normalize=0 が要る。既定の normalize=1 は入力数で割ってナレーションを半分にする
       "-filter_complex", "[1:a][2:a]amix=inputs=2:duration=first:normalize=0[aout]",
       "-map", "0:v", "-map", "[aout]",
       "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", outPath]
    : ["-y", "-i", silent, "-i", masterPath, "-map", "0:v", "-map", "1:a",
       "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", outPath]);
  // 中間ファイルは残さない(ディスクの空きが十数GBしかない)
  rmSync(parts, { recursive: true, force: true });
  console.log("できました: " + outPath + "(" + durationOf(outPath).toFixed(2) + "秒)");

  // 指摘4: リミッタを掛けない設計なので、総和が -1.0dBFS を超えていないかを実測する。
  // 設計は「警告を出す」とだけ求めており、ここでは止めない
  try {
    const maxDb = maxVolumeDb(outPath);
    console.log("音量ピーク(max_volume): " + maxDb.toFixed(1) + "dB");
    if (maxDb > -1.0) {
      console.log("⚠️ 音量ピークが -1.0dBFS を超えています(" + maxDb.toFixed(1)
        + "dB)。ambient.json の gainDb を下げることを検討してください");
    }
  } catch (e) {
    console.log("⚠️ 音量ピークを測れませんでした: " + (e as Error).message);
  }
}

if (process.argv[1] && basename(process.argv[1]) === "assemble.ts") main();
