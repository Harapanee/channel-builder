/**
 * 英訳 episodes/<epId>/en/en.json の検査と、翻訳用の語数予算の表。
 *   npx tsx src/pipeline/en/en-check.ts <epId>            → 検査(exit 0 / 1)
 *   npx tsx src/pipeline/en/en-check.ts <epId> --lines-only → 行だけ検査(タイトル・説明・サムネ文字は問わない)
 *   npx tsx src/pipeline/en/en-check.ts <epId> --budget   → 「lineId<TAB>下限語数<TAB>上限語数<TAB>日本語」の表
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { checkEnScript, lineSlots, type EnScript, type TimingLike } from "./en-plan";

const epId = process.argv[2];
if (!epId) {
  console.error("usage: en-check.ts <epId> [--budget]");
  process.exit(2);
}
const epDir = path.join("episodes", epId);
const timing: TimingLike = JSON.parse(readFileSync(path.join(epDir, "timing.json"), "utf8"));
if (process.argv.includes("--budget")) {
  for (const s of lineSlots(timing)) {
    const ja = timing.lines.find((l) => l.lineId === s.lineId)!.text;
    console.log(`${s.lineId}\t${s.minWords}\t${s.maxWords}\t${ja}`);
  }
  process.exit(0);
}
const enPath = path.join(epDir, "en", "en.json");
if (!existsSync(enPath)) {
  console.error(`ありません: ${enPath}`);
  process.exit(1);
}
const problems = checkEnScript(JSON.parse(readFileSync(enPath, "utf8")) as EnScript, timing, {
  linesOnly: process.argv.includes("--lines-only"),
});
problems.forEach((p) => console.log(`NG ${p}`));
console.log(problems.length ? `${problems.length}件の問題` : "OK");
process.exit(problems.length ? 1 : 0);
