/** Targeted listening plan; legacy outputs remain explicitly unverified. */
import { existsSync } from "node:fs";
import path from "node:path";
import { json, verifyFit } from "./provenance";
export function subtitleQa(text: string, duration: number) {
  return {
    chars: text.length,
    charsPerSecond:
      Number.isFinite(duration) && duration > 0
        ? Number((text.length / duration).toFixed(2))
        : null,
    long: text.length > 84,
    alignment: "unknown" as const,
    warning:
      text.length > 84
        ? "Word alignment required before timed segmentation"
        : null,
  };
}
export function qa(epDir: string) {
  const timing = json(path.join(epDir, "timing.json")),
    en = json(path.join(epDir, "en/en.json")),
    out = path.join(epDir, "out/en");
  let provenance = "verified";
  try {
    verifyFit(epDir);
  } catch (e) {
    provenance = `unverified: ${(e as Error).message}`;
  }
  const durations = existsSync(path.join(out, "lines/durations.json"))
      ? json(path.join(out, "lines/durations.json"))
      : {},
    report = existsSync(path.join(out, "fit-report.json"))
      ? json(path.join(out, "fit-report.json"))
      : {};
  const ranges = timing.lines.flatMap((l: any, i: number) => {
    const text = en.lines[l.lineId] ?? "",
      d = durations[l.lineId],
      end = Number.isFinite(d) && d > 0 ? l.startSec + d : l.endSec;
    const next = timing.lines[i + 1]?.startSec ?? timing.totalDurationSec,
      gap = next - end,
      sub = subtitleQa(text, d),
      reasons = [];
    if (l.startSec < 45) reasons.push("opening45sec");
    if (gap > 2) reasons.push("gap>2sec");
    if (
      /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion|percent|half|quarter|twice)\b/i.test(
        text,
      )
    )
      reasons.push("numeric");
    if (report.speeds?.[l.lineId] && report.speeds[l.lineId] !== 1)
      reasons.push("speed-adjusted");
    if (sub.long) reasons.push("long-subtitle");
    if (!Number.isFinite(d) || d <= 0) reasons.push("duration-unavailable");
    return reasons.length
      ? [
          {
            lineId: l.lineId,
            startSec: l.startSec,
            endSec: Math.min(next, end),
            reviewThroughSec: Math.max(end, next),
            gapSec: Number(gap.toFixed(3)),
            reasons,
            text,
            subtitle: sub,
          },
        ]
      : [];
  });
  return {
    episodeId: path.basename(epDir),
    provenance,
    translationQuality: "not-reviewed",
    alignment: "unknown",
    ranges,
  };
}
if (process.argv[1]?.endsWith("en-qa.ts")) {
  const ep = process.argv[2];
  if (!ep) throw Error("usage: en-qa.ts <epId>");
  console.log(JSON.stringify(qa(path.join("episodes", ep)), null, 2));
}
