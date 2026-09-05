/**
 * H3 経路の図解オーバーレイ(figures)— 契約と純関数。
 *
 * 設計: docs/superpowers/specs/2026-09-04-h3-figure-overlay-design.md
 * 宣言(h3/episodes/<epId>/figures.json)から表示窓を決め、透過PNG連番として焼き(render-figures.ts)、
 * assemble が字幕と同じ overlay 経路で重ねる。ここには DOM も ffmpeg も置かない。
 */
import { createHash } from "node:crypto";
import type { TimingLine } from "./plan";
import type { Cut } from "./types";

export interface Phrase {
  text: string;
  startSec: number;
  endSec: number;
}

/** timing.json の行(句の区切りつき)。TimingLine に phrases を足したもの */
export interface FigureLine extends TimingLine {
  phrases?: Phrase[];
}

/**
 * 項目を出す瞬間の指定(先バレ防止)。
 * その数字をナレーションが言い始める句に留める。atLineId 省略時は図解の lineId の句。
 * 無い項目は前の項目の直後(型ごとの間隔)に出る。bars / scale / timeline / grid の segments では
 * 2つ目以降の項目に必須(validateFigure が検査する)。
 */
export interface RevealAnchor {
  atLineId?: string;
  atPhrase?: number;
}

export interface BarItem extends RevealAnchor {
  label: string;
  /** 棒の長さの根拠(比で伸びる) */
  value: number;
  /** 棒の先に出す文字(「2.9倍」「15〜30万頭」) */
  display: string;
  /** 強調(赤) */
  accent?: boolean;
}

export interface GridSegment extends RevealAnchor {
  label: string;
  count: number;
  /** ink / indigo / red / yellow / paper */
  color?: string;
}

interface FigureBase {
  id: string;
  /** 窓の起点となる行 */
  lineId: string;
  /** 窓の頭を行の何番目の句にするか(省略で行頭) */
  fromPhrase?: number;
  /** 窓の尻をこの行にする(省略で lineId) */
  toLineId?: string;
  /** 窓の尻をその行の何番目の句の終わりにするか(省略で行末) */
  toPhrase?: number;
  /** 行末のあとに残す秒(既定 0.3)。次の行頭を越えない */
  holdSec?: number;
  /** 下の映像を暗くする量 0〜1(既定 0.55) */
  dim?: number;
  title: string;
  /** 板の下に出す一言(任意) */
  caption?: string;
  /** 一言を出す句(省略時は板と同時に出る) */
  captionAtLineId?: string;
  captionAtPhrase?: number;
}

export interface BarsFigure extends FigureBase {
  type: "bars";
  items: BarItem[];
}

export interface GridFigure extends FigureBase {
  type: "grid";
  /** 粒の総数(既定 100) */
  total?: number;
  /** 「何個中何個」で強調する個数 */
  highlight?: number;
  /** 強調の見出し(「大人のメスの死因 56%」) */
  highlightLabel?: string;
  /** 内訳(highlight の代わり) */
  segments?: GridSegment[];
  /** "remove" なら強調ぶんが消えていく */
  mode?: "add" | "remove";
  /** 粒の絵: dot(既定)/ bowl / otter */
  icon?: "dot" | "bowl" | "otter";
}

export interface RecapItem extends RevealAnchor {
  /** 「1回目の請求書」など */
  label: string;
  /** 中身の一言 */
  text: string;
  /** 今回の章で新しく積まれた項目(強調) */
  now?: boolean;
}

/** 章の切れ目で「ここまでの請求書」を積み直す板。章カードの直後の行に置く */
export interface RecapFigure extends FigureBase {
  type: "recap";
  items: RecapItem[];
}

export interface TimelineEvent extends RevealAnchor {
  /** 目盛りの文字(「生後3日」「1年」) */
  at: string;
  /** 目盛りの位置(0〜1。省略時は等間隔) */
  pos?: number;
  label: string;
  accent?: boolean;
}

/** 一生のタイムライン。左から右へ目盛りが順に立つ */
export interface TimelineFigure extends FigureBase {
  type: "timeline";
  events: TimelineEvent[];
}

export interface ScaleItem extends RevealAnchor {
  label: string;
  /** 実寸(同じ単位で。棒ではなく面積の印象で見せるため幅と高さの両方に効く) */
  size: number;
  display: string;
  /** hand / bottle / pole / human / otter / none */
  icon?: string;
  accent?: boolean;
}

/** 大きさの実物比較(bible §8 の署名: 手のひら・500mlペットボトル・電柱との対比) */
export interface ScaleFigure extends FigureBase {
  type: "scale";
  items: ScaleItem[];
}

export type Figure = BarsFigure | GridFigure | RecapFigure | TimelineFigure | ScaleFigure;

export interface FiguresFile {
  episodeId: string;
  figures: Figure[];
}

export interface FigureIndexEntry {
  id: string;
  /** 図解(既定)か章カード(cuts.json の card から機械生成。2026-09-05) */
  kind?: "figure" | "card";
  /** 連番の置き場(エピソード基準の相対 or 絶対) */
  dir: string;
  /** 絶対時刻のフレーム(Math.round(fromSec * fps)) */
  startFrame: number;
  frames: number;
  /** 宣言のハッシュ(焼き直し要否の判定) */
  hash: string;
}

export interface FigureIndex {
  episodeId: string;
  fps: number;
  entries: FigureIndexEntry[];
}

export const DEFAULT_HOLD_SEC = 0.3;
export const DEFAULT_DIM = 0.55;
/** 冒頭はこの秒数まで図解を置かない(bible 69行) */
export const EARLIEST_SEC = 45;
export const FADE_SEC = 0.35;

export interface Window {
  fromSec: number;
  toSec: number;
}

function nextLineStart(lineId: string, lineById: Map<string, FigureLine>): number | undefined {
  const lines = [...lineById.values()].sort((a, b) => a.startSec - b.startSec);
  const i = lines.findIndex((l) => l.lineId === lineId);
  return i >= 0 && i + 1 < lines.length ? lines[i + 1].startSec : undefined;
}

/** 宣言から表示窓(絶対秒)を決める */
export function figureWindow(fig: Figure, lineById: Map<string, FigureLine>, totalDurationSec?: number): Window {
  const from = lineById.get(fig.lineId);
  if (!from) throw new Error(fig.id + ": timing.json に " + fig.lineId + " がありません");
  const toId = fig.toLineId ?? fig.lineId;
  const to = lineById.get(toId);
  if (!to) throw new Error(fig.id + ": timing.json に " + toId + " がありません");
  const fromSec = fig.fromPhrase === undefined ? from.startSec : phraseAt(fig, from, fig.fromPhrase).startSec;
  const hold = fig.holdSec ?? DEFAULT_HOLD_SEC;
  let toSec = (fig.toPhrase === undefined ? to.endSec : phraseAt(fig, to, fig.toPhrase).endSec) + hold;
  const ceiling = nextLineStart(toId, lineById) ?? totalDurationSec;
  if (ceiling !== undefined) toSec = Math.min(toSec, ceiling);
  return { fromSec, toSec };
}

function phraseAt(fig: Figure, line: FigureLine, i: number): Phrase {
  const p = line.phrases?.[i];
  if (!p) throw new Error(fig.id + ": " + line.lineId + " に句 " + i + " がありません(句は " + (line.phrases?.length ?? 0) + " 個)");
  return p;
}

/** 型ごとの「留めが無い項目」の間隔(秒) */
const CADENCE_SEC: Record<Figure["type"], number> = { bars: 0.45, scale: 0.5, timeline: 0.35, recap: 0.4, grid: 0.6 };

/** 図解の並ぶ項目(bars/scale の items・timeline の events・recap の items・grid の segments)。他は空 */
export function figureItems(fig: Figure): RevealAnchor[] {
  if (fig.type === "timeline") return fig.events;
  if (fig.type === "grid") return fig.segments ?? [];
  return fig.items;
}

/** 留め(atPhrase)が全項目に必須の型(2つ目以降)。数字が順に語られる型 */
export function anchorsRequired(fig: Figure): boolean {
  return fig.type === "bars" || fig.type === "scale" || fig.type === "timeline" || (fig.type === "grid" && (fig.segments?.length ?? 0) > 1);
}

export interface Reveals {
  /** 各項目を出す時刻(窓の頭からの秒。負にはならない) */
  items: number[];
  /** 一言を出す時刻(省略時 undefined = 板と同時) */
  caption?: number;
}

function anchorSec(fig: Figure, a: RevealAnchor, lineById: Map<string, FigureLine>): number | undefined {
  if (a.atPhrase === undefined) {
    if (a.atLineId !== undefined) throw new Error(fig.id + ": atLineId には atPhrase が要ります");
    return undefined;
  }
  const lid = a.atLineId ?? fig.lineId;
  const line = lineById.get(lid);
  if (!line) throw new Error(fig.id + ": timing.json に " + lid + " がありません(atLineId)");
  return phraseAt(fig, line, a.atPhrase).startSec;
}

/**
 * 各項目を出す瞬間を決める(窓の頭からの相対秒)。
 * 留めのある項目はその句の頭、無い項目は前の項目の直後(型ごとの間隔)。先頭で留めが無ければ 0。
 * 描画(render-figures)はこの値をそのままタイムラインに置く(尺に合わせて縮めない)。
 */
export function figureReveals(fig: Figure, lineById: Map<string, FigureLine>, win: Window): Reveals {
  const cadence = CADENCE_SEC[fig.type];
  const items: number[] = [];
  for (const it of figureItems(fig)) {
    const abs = anchorSec(fig, it, lineById);
    const prev = items.length ? items[items.length - 1] : -cadence;
    // 同じ句に留めた項目が重なって出ないよう、前の項目から最低 0.2 秒ずらす(先頭は 0)
    const floor = items.length ? prev + 0.2 : 0;
    items.push(abs === undefined ? prev + cadence : Math.max(floor, abs - win.fromSec));
  }
  const cap = anchorSec(fig, { atLineId: fig.captionAtLineId, atPhrase: fig.captionAtPhrase }, lineById);
  return { items, caption: cap === undefined ? undefined : Math.max(0, cap - win.fromSec) };
}

function validateReveals(fig: Figure, lineById: Map<string, FigureLine>, w: Window): string[] {
  const out: string[] = [];
  let r: Reveals;
  try {
    r = figureReveals(fig, lineById, w);
  } catch (e) {
    return [(e as Error).message];
  }
  const items = figureItems(fig);
  const span = w.toSec - w.fromSec;
  if (anchorsRequired(fig)) {
    items.forEach((it, i) => {
      if (i > 0 && it.atPhrase === undefined) out.push(fig.id + ": " + (i + 1) + "番目の項目に atPhrase が無い(数字はナレーションが言う句に留めて先バレさせない)");
    });
  }
  let lastAnchored = -Infinity;
  items.forEach((it, i) => {
    if (it.atPhrase === undefined) return;
    const abs = w.fromSec + r.items[i];
    const anchored = anchorSec(fig, it, lineById)!;
    if (anchored < lastAnchored - 1e-6) out.push(fig.id + ": " + (i + 1) + "番目の項目が前の項目より先に出る(項目の順を語られる順にそろえる)");
    lastAnchored = anchored;
    if (anchored < w.fromSec - 1e-6) out.push(fig.id + ": " + (i + 1) + "番目の項目の句(" + anchored.toFixed(1) + "秒)が窓の頭(" + w.fromSec.toFixed(1) + "秒)より前");
    if (r.items[i] > span - FADE_SEC) out.push(fig.id + ": " + (i + 1) + "番目の項目の句(" + abs.toFixed(1) + "秒)が窓の尻(" + w.toSec.toFixed(1) + "秒)に食い込む。toLineId / toPhrase を延ばす");
  });
  if (r.caption !== undefined && r.caption > span - FADE_SEC) out.push(fig.id + ": caption の句が窓の尻に食い込む");
  return out;
}

/** 規則の機械検査。空なら合格 */
export function validateFigure(fig: Figure, lineById: Map<string, FigureLine>, cuts: Record<string, Cut>): string[] {
  const out: string[] = [];
  let w: Window;
  try {
    w = figureWindow(fig, lineById);
  } catch (e) {
    return [(e as Error).message];
  }
  out.push(...validateReveals(fig, lineById, w));
  if (w.fromSec < EARLIEST_SEC) out.push(fig.id + ": 冒頭" + EARLIEST_SEC + "秒以内(" + w.fromSec.toFixed(1) + "秒)には図解を置かない(bible 冒頭45秒の規則)");
  if (!(w.fromSec < w.toSec)) out.push(fig.id + ": 窓が空です(" + w.fromSec + " → " + w.toSec + ")");
  for (const lid of new Set([fig.lineId, fig.toLineId ?? fig.lineId])) {
    const hit = Object.entries(cuts).find(([, c]) => c.lineIds.includes(lid));
    if (!hit) { out.push(fig.id + ": " + lid + " を持つカットが cuts.json にありません"); continue; }
    const [cid, c] = hit;
    if (c.card) out.push(fig.id + ": " + cid + " は章カードなので図解を重ねない");
    if (c.text) out.push(fig.id + ": " + cid + " は画面内に文字を出すカットなので図解を重ねない");
    if (c.noSub) out.push(fig.id + ": " + cid + " は noSub なので図解を重ねない");
  }
  if (fig.type === "bars" && fig.items.length < 2) out.push(fig.id + ": bars は2本以上(比較で見せる)");
  if (fig.type === "scale" && fig.items.length < 2) out.push(fig.id + ": scale は2つ以上(比較で見せる)");
  if (fig.type === "timeline" && fig.events.length < 2) out.push(fig.id + ": timeline は出来事2つ以上");
  if (fig.type === "recap" && (fig.items.length < 1 || fig.items.length > 5)) out.push(fig.id + ": recap は1〜5項目");
  if (fig.type === "recap") {
    // 章カードの直後の行に置く(章の切れ目で積み直す道具なので、それ以外の場所では意味が濁る)
    const lines = [...lineById.values()].sort((a, b) => a.startSec - b.startSec);
    const i = lines.findIndex((l) => l.lineId === fig.lineId);
    const prevId = i > 0 ? lines[i - 1].lineId : undefined;
    const prevCut = prevId ? Object.values(cuts).find((c) => c.lineIds.includes(prevId)) : undefined;
    if (!prevCut?.card) out.push(fig.id + ": recap は章カードの直後の行に置く(" + fig.lineId + " の直前は章カードではない)");
  }
  if (fig.type === "grid") {
    const total = fig.total ?? 100;
    const sum = fig.segments ? fig.segments.reduce((a, s) => a + s.count, 0) : (fig.highlight ?? 0);
    if (sum > total) out.push(fig.id + ": 粒の合計 " + sum + " が total " + total + " を超えています");
  }
  return out;
}

export function figureHash(fig: Figure, fps: number, window: Window): string {
  return createHash("sha1").update(JSON.stringify({ fig, fps, window })).digest("hex").slice(0, 12);
}

export interface FigureChunkOverlay {
  id: string;
  dir: string;
  /** 連番の読み始め(f%05d の番号) */
  startNumber: number;
  frames: number;
  /** 区間内の置き時刻(秒・小数3桁の文字列。ffmpeg の式へそのまま入れる) */
  atSec: string;
}

/**
 * 1区間(CHUNK)に重なる図解の連番範囲を切り出す。
 * 図解は複数のクリップ・区間にまたがれるので、区間ごとに必要なフレームだけ読む。
 */
export function figureOverlaysForChunk(
  entries: FigureIndexEntry[],
  baseFrame: number,
  chunkFrames: number,
  fps: number,
): FigureChunkOverlay[] {
  const chunkEnd = baseFrame + chunkFrames;
  const out: FigureChunkOverlay[] = [];
  for (const e of entries) {
    const s = Math.max(e.startFrame, baseFrame);
    const t = Math.min(e.startFrame + e.frames, chunkEnd);
    if (t <= s) continue;
    out.push({
      id: e.id, dir: e.dir,
      startNumber: s - e.startFrame,
      frames: t - s,
      atSec: ((s - baseFrame) / fps).toFixed(3),
    });
  }
  return out;
}

/**
 * 同じ型が何本続いたか(figure-planner の単調さの自己検算用)。
 * 窓の順に並べた型の列から、2本以上続いた区間だけを返す。
 */
export function typeRuns(types: Figure["type"][]): { type: Figure["type"]; from: number; count: number }[] {
  const out: { type: Figure["type"]; from: number; count: number }[] = [];
  let i = 0;
  while (i < types.length) {
    let j = i;
    while (j + 1 < types.length && types[j + 1] === types[i]) j++;
    if (j > i) out.push({ type: types[i], from: i, count: j - i + 1 });
    i = j + 1;
  }
  return out;
}
