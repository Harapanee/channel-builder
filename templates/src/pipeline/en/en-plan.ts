/**
 * 英語版(YouTube 多言語音声)の計画: 行の枠・語数予算・英訳の検査・収まり判定(純粋関数のみ)。
 *
 * 映像のカットは日本語ナレーションの行の開始秒で切られている。英語も同じ開始秒から読み始め、
 * 次の行の開始までに読み終えれば、映像とのずれは行の中に閉じる。行をまたいで押し出すと
 * 後ろの全カットがずれるので、収まらない行は話速→訳し直しの順で直す(黙って重ねない)。
 */
export const MIN_GAP_SEC = 0.15;
/** am_adam・話速1.0の実測の読み上げ速度(MLX 版・ep064 の中央値 3.24語/秒。onnx 版は 3.12。2026-10-12) */
export const SPOKEN_WPS = 3.2;
/**
 * 英語が日本語より早く読み終わってよい上限(秒)。これを超えると行間が空きすぎる(ep064 初版は
 * 上限だけを渡して訳させた結果、英語の行間の中央値 1.74秒・日本語は 0.35秒。ユーザー指摘 2026-10-12)
 */
export const SHORT_TOL_SEC = 0.7;
/** 最終行の後ろに残す余白 */
export const TAIL_SEC = 0.3;

export interface TimingLike {
  totalDurationSec: number;
  lines: { lineId: string; text: string; startSec: number; endSec: number }[];
}

export interface EnScript {
  episodeId: string;
  lines: Record<string, string>;
  title: string;
  description: string;
  thumbText: string;
}

export interface Slot {
  lineId: string;
  startSec: number;
  /** 読み始めから次の行の開始まで(英語が使える最大の尺) */
  slotSec: number;
  /** 日本語の発話尺(英語はここまで埋めるのが目標) */
  jaDurSec: number;
  minWords: number;
  maxWords: number;
}

export type Fit =
  | { kind: "ok" }
  | { kind: "speed"; speed: number }
  | { kind: "shrink"; overSec: number }
  | { kind: "expand"; shortSec: number };

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function lineSlots(timing: TimingLike): Slot[] {
  return timing.lines.map((l, i) => {
    const end =
      i + 1 < timing.lines.length
        ? timing.lines[i + 1].startSec
        : timing.totalDurationSec - TAIL_SEC;
    const slotSec = r3(end - l.startSec);
    const jaDurSec = r3(l.endSec - l.startSec);
    const maxWords = Math.floor((slotSec - MIN_GAP_SEC) * SPOKEN_WPS);
    const minWords = Math.min(
      maxWords,
      Math.max(1, Math.floor((jaDurSec - SHORT_TOL_SEC) * SPOKEN_WPS)),
    );
    return {
      lineId: l.lineId,
      startSec: l.startSec,
      slotSec,
      jaDurSec,
      minWords,
      maxWords,
    };
  });
}

const JA = /[぀-ヿ㐀-鿿]/;
/** クレジット行は日本語の固有名詞をそのまま書く(規約上の表記)ので日本語検査から外す */
const CREDIT = /^Japanese narration: VOICEVOX:/;

/** linesOnly: 行だけ訳した段階(公開パッケージ前)。タイトル・説明・サムネ文字は問わない */
export function checkEnScript(
  en: EnScript,
  timing: TimingLike,
  opts: { linesOnly?: boolean } = {},
): string[] {
  const out: string[] = [];
  const ids = new Set(timing.lines.map((l) => l.lineId));
  for (const id of ids)
    if (!(id in en.lines)) out.push(`${id}: 英訳がありません`);
  for (const [id, text] of Object.entries(en.lines)) {
    if (!ids.has(id)) out.push(`${id}: timing にない行です`);
    else if (text.trim() === "") out.push(`${id}: 空です`);
    else if (JA.test(text)) out.push(`${id}: 日本語の文字が残っています`);
  }
  if (opts.linesOnly) return out;
  for (const key of ["title", "description", "thumbText"] as const) {
    const v = en[key] ?? "";
    if (v.trim() === "") out.push(`${key}: 空です`);
    if (/[<>]/.test(v)) out.push(`${key}: <> は YouTube が拒否します`);
    const body = v
      .split("\n")
      .filter((ln) => !CREDIT.test(ln))
      .join("\n");
    if (JA.test(body)) out.push(`${key}: 日本語の文字が残っています`);
  }
  if ((en.title ?? "").length > 100)
    out.push(`title: 100文字を超えています(${en.title.length})`);
  if (Buffer.byteLength(en.description ?? "", "utf8") > 5000)
    out.push("description: 5000バイトを超えています");
  return out;
}

/**
 * 1行の音の尺が枠に合うかを判定する。はみ出し → 話速を上げる(上限まで)→ 縮める訳し直し。
 * 日本語より許容以上に早く終わる → 話速を下げる(下限まで)→ 足す訳し直し。
 */
export function fitDecision(
  slot: { slotSec: number; jaDurSec: number },
  durSec: number,
  currentSpeed: number,
  limits: { maxSpeed: number; minSpeed: number },
): Fit {
  if (
    ![
      durSec,
      currentSpeed,
      slot.slotSec,
      slot.jaDurSec,
      limits.minSpeed,
      limits.maxSpeed,
    ].every((x) => Number.isFinite(x) && x > 0) ||
    slot.slotSec <= MIN_GAP_SEC
  )
    throw new Error("invalid duration/speed/slot");
  const room = slot.slotSec - MIN_GAP_SEC;
  const atUnit = durSec * currentSpeed; // 話速1.0での尺に換算(Kokoro の尺はほぼ 1/speed)
  if (durSec > room) {
    const need = Math.ceil((atUnit / room) * 1.02 * 100) / 100;
    if (need <= limits.maxSpeed) return { kind: "speed", speed: need };
    return { kind: "shrink", overSec: durSec - room };
  }
  const shortSec = slot.jaDurSec - durSec;
  if (shortSec <= SHORT_TOL_SEC) return { kind: "ok" };
  const target = Math.min(slot.jaDurSec, room);
  const slow = Math.ceil((atUnit / target) * 100) / 100;
  if (slow >= limits.minSpeed) return { kind: "speed", speed: slow };
  return { kind: "expand", shortSec };
}

/** Shorter speech is a listening warning; only overlap/unfinished speed fitting blocks production. */
export function fitExitCode(rewrite: { kind: string }[]): 0 | 1 {
  return rewrite.some((r) => r.kind !== "expand") ? 1 : 0;
}
