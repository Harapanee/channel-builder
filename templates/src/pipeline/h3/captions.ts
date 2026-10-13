/**
 * 日本語字幕(WebVTT)。映像へ焼かず YouTube 字幕として上げる回(.channel-system.json
 * h3Pipeline.burnSubtitles: false。2026-10-13 ユーザー決定)のためのもの。
 *
 * 規則は焼き字幕(render-subs.py)と同じ: **1回の表示につき1文**・字幕の数字は台本の `display`(bible §8)。
 * 表示表記は行の displayText を優先する。焼き字幕は句の displayText しか見ないため、句の数が
 * 表示と合わない行(ep065 L105「二十センチ、下に」→ display「20センチ下に」)で読み表記が出ていた。
 * 位置は指定しない(YouTube 既定の画面下)。
 */
/** hh:mm:ss.mmm(en/en-subs.ts の vttTime と同じ。テンプレに en/ が無いのでここに持つ) */
export function vttTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms % 1000, 3)}`;
}

export interface CaptionLine {
  lineId: string;
  text: string;
  displayText?: string;
  startSec: number;
  endSec: number;
  noSubtitle?: boolean;
  phrases?: { text: string; displayText?: string; startSec: number; endSec: number }[];
}

export interface Cue {
  text: string;
  start: number;
  end: number;
}

const SENTENCE_RE = /[^。！？!?]+[。！？!?]+[」』)]*|[^。！？!?]+$/g;
const MAX_CHARS = 42; // render-subs.py の SENTENCE_MAX_CHARS と同じ

/** 字幕の表記: 行の displayText → 全句の displayText を句読点を拾い直して連結 → 読み表記 */
export function displayOf(line: CaptionLine): string {
  if (line.displayText) return line.displayText;
  const ps = line.phrases ?? [];
  if (!(ps.length > 0 && ps.every((p) => p.displayText))) return line.text;
  let out = "", pos = 0;
  for (const p of ps) {
    const i = line.text.indexOf(p.text, pos);
    if (i < 0) return ps.map((x) => x.displayText).join("");
    out += line.text.slice(pos, i) + p.displayText;
    pos = i + p.text.length;
  }
  return out + line.text.slice(pos);
}

function sentences(s: string): { text: string; offset: number }[] {
  return [...s.matchAll(SENTENCE_RE)].map((m) => ({ text: m[0], offset: m.index ?? 0 }));
}

/** 文の時刻: 読み表記の文 k の最初の句の開始(k=0 は行頭)。句が当てはまらなければ null */
function sentenceStarts(line: CaptionLine, raw: { offset: number }[]): number[] | null {
  const ps = line.phrases ?? [];
  const at: { pos: number; start: number }[] = [];
  let pos = 0;
  for (const p of ps) {
    const i = line.text.indexOf(p.text, pos);
    if (i < 0) return null;
    at.push({ pos: i, start: p.startSec });
    pos = i + p.text.length;
  }
  const starts = [line.startSec];
  for (const s of raw.slice(1)) {
    const hit = at.find((a) => a.pos >= s.offset);
    if (!hit) return null;
    starts.push(hit.start);
  }
  return starts;
}

/** 42字を超える文を、中央に近い読点の直後で割る。時間は字数で按分 */
function splitLong(c: Cue): Cue[] {
  const n = c.text.length;
  if (n <= MAX_CHARS) return [c];
  let best = -1;
  for (let i = 0; i < n - 1; i++) {
    if (c.text[i] === "、" && (best < 0 || Math.abs(i + 1 - n / 2) < Math.abs(best - n / 2))) best = i + 1;
  }
  if (best < 0) return [c];
  const mid = c.start + ((c.end - c.start) * best) / n;
  return [...splitLong({ text: c.text.slice(0, best), start: c.start, end: mid }), ...splitLong({ text: c.text.slice(best), start: mid, end: c.end })];
}

/** 行 → cue。noSubtitle の行と skip(cuts の noSub カットの行)は出さない */
export function captionCues(lines: CaptionLine[], skip: Set<string>): Cue[] {
  return lines
    .filter((l) => !l.noSubtitle && !skip.has(l.lineId))
    .flatMap((line) => {
      const disp = displayOf(line);
      const whole: Cue[] = [{ text: disp, start: line.startSec, end: line.endSec }];
      const ds = sentences(disp);
      const rs = sentences(line.text);
      let cues = whole;
      if (ds.length > 1 && ds.length === rs.length) {
        const starts = sentenceStarts(line, rs);
        if (starts) cues = ds.map((d, k) => ({ text: d.text.trim(), start: starts[k], end: k + 1 < starts.length ? starts[k + 1] : line.endSec }));
      }
      return cues.flatMap(splitLong);
    });
}

export function buildJaVtt(lines: CaptionLine[], skip: Set<string>): string {
  const body = captionCues(lines, skip).map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}`);
  return `WEBVTT\n\n${body.join("\n\n")}\n`;
}
