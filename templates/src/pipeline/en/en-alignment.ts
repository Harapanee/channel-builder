/** Word times must be measured against the exact WAV, never inferred from character counts. */
export interface WordTime {
  text: string;
  start: number;
  end: number;
}
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
export function alignedCues(text: string, words: WordTime[], duration: number) {
  if (
    !words.length ||
    normalize(words.map((w) => w.text).join(" ")) !== normalize(text)
  )
    throw Error("alignment text mismatch");
  let last = 0;
  for (const w of words) {
    if (
      !w.text.trim() ||
      !Number.isFinite(w.start) ||
      !Number.isFinite(w.end) ||
      w.start < last ||
      w.end <= w.start ||
      w.end > duration + 0.001 ||
      w.text.length > 42
    )
      throw Error("invalid word alignment");
    last = w.end;
  }
  const cues: { start: number; end: number; text: string }[] = [];
  let group: WordTime[] = [];
  const wrap = (ws: WordTime[]) => {
    const lines: string[] = [""];
    for (const w of ws) {
      const i = lines.length - 1;
      if ((lines[i] + (lines[i] ? " " : "") + w.text).length > 42)
        lines.push(w.text);
      else lines[i] += (lines[i] ? " " : "") + w.text;
    }
    return lines;
  };
  const flush = () => {
    if (group.length) {
      cues.push({
        start: group[0].start,
        end: group[group.length - 1].end,
        text: wrap(group).join("\n"),
      });
      group = [];
    }
  };
  for (const w of words) {
    if (wrap([...group, w]).length > 2) flush();
    group.push(w);
    if (/[.!?;:]$/.test(w.text)) flush();
  }
  flush();
  return cues;
}
