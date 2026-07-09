/**
 * shots.json のリタイミング。
 *
 * 台本改訂→再TTSで timing.json が変わったとき、各ショットの startSec/endSec を
 * lineIds から機械的に再導出する。ショット境界の規則:
 *   - shot[i].startSec = shot[i] の先頭行の開始時刻(先頭ショットは 0)
 *   - shot[i].endSec   = shot[i+1].startSec(最終ショットは totalDurationSec)
 * これにより「ショットは自分の行+直後のポーズを含む」という既存の設計を保つ。
 * sfx の atSec はショット相対のまま維持し、短くなったショットからはみ出す場合のみ
 * 末尾へクランプする(カスタムシーン内部の固定アニメ時刻と同期しているため、
 * 比例スケールはしない)。
 *
 * CLI: tsx src/pipeline/retime-shots.ts episodes/<epId>
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const epDir = process.argv[2];
if (!epDir) {
  console.error("usage: retime-shots.ts episodes/<epId>");
  process.exit(1);
}

const shotsPath = path.join(epDir, "shots.json");
const timingPath = path.join(epDir, "timing.json");
const shots = JSON.parse(readFileSync(shotsPath, "utf8"));
const timing = JSON.parse(readFileSync(timingPath, "utf8"));

const lineStart = new Map<string, number>();
for (const l of timing.lines) lineStart.set(l.lineId, l.startSec);

const starts: number[] = shots.shots.map((shot: any, i: number) => {
  if (i === 0) return 0;
  const first = shot.lineIds[0];
  const s = lineStart.get(first);
  if (s === undefined) {
    console.error(`shot ${shot.shotId}: lineId ${first} が timing.json にありません`);
    process.exit(1);
  }
  return Number(s.toFixed(3));
});

for (let i = 0; i < shots.shots.length; i++) {
  const shot = shots.shots[i];
  const oldDur = shot.endSec - shot.startSec;
  shot.startSec = starts[i];
  // 最終ショットの endSec は narration.durationSec と厳密一致が必要なため丸めない
  shot.endSec =
    i < shots.shots.length - 1 ? starts[i + 1] : timing.totalDurationSec;
  const newDur = shot.endSec - shot.startSec;
  for (const s of shot.sfx ?? []) {
    if (s.atSec > newDur - 0.05) {
      const clamped = Number(Math.max(0, newDur - 0.05).toFixed(2));
      console.log(
        `  ${shot.shotId} sfx ${s.cue}: atSec ${s.atSec} -> ${clamped}(クランプ)`
      );
      s.atSec = clamped;
    }
  }
  console.log(
    `${shot.shotId}: ${shot.startSec.toFixed(2)}-${shot.endSec.toFixed(2)} ` +
      `(${oldDur.toFixed(2)}s -> ${newDur.toFixed(2)}s)`
  );
}

shots.narration.durationSec = timing.totalDurationSec;
writeFileSync(shotsPath, JSON.stringify(shots, null, 2) + "\n");
console.log(`OK: ${shotsPath} をリタイミングしました(total ${timing.totalDurationSec}s)`);
