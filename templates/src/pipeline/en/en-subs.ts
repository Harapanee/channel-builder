/**
 * 英語字幕(WebVTT)。英語音声と同じ材料(en.json の行・timing の開始秒・英語音声の実測の行尺)から作る。
 * 既定は位置指定なし(YouTube 既定の画面下)。日本語字幕を焼かなくなった(h3Pipeline.burnSubtitles: false。
 * ユーザー決定 2026-10-13)。焼き字幕のある旧回を作り直すときだけ top(line:5%=画面上部)を使う。
 */
export function vttTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000),
    m = Math.floor((ms % 3600000) / 60000),
    s = Math.floor((ms % 60000) / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms % 1000, 3)}`;
}

export function buildVtt(
  lines: { lineId: string; startSec: number }[],
  text: Record<string, string>,
  durations: Record<string, number>,
  opts: { top: boolean },
): string {
  const pos = opts.top ? " line:5%" : "";
  const cues = lines.map((l) => {
    const d = durations[l.lineId];
    if (!Number.isFinite(d) || d <= 0)
      throw new Error(
        `${l.lineId}: 英語音声の尺がありません(npm run en:tts を先に)`,
      );
    return `${vttTime(l.startSec)} --> ${vttTime(l.startSec + d)}${pos}\n${text[l.lineId]}`;
  });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}
