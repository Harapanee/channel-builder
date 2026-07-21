/**
 * 指定ショット/時刻の静止画を一括レンダーする(レビュー用フレーム取得)。
 *
 * 背景: compliance-reviewer の視覚伝達検査は従来 preview.mp4 からの
 * ffmpegフレーム抽出に依存しており、レビューのたびにフルプレビューレンダー
 * (80秒動画で約12分、通常尺では30分超)が走っていた。検査に必要なのは
 * 十数枚のフレームだけであり、フルレンダーは不要。
 *
 * 実装は qa-smoke.ts と同じ「QASmokeRoot サンプラーを1回バンドルし、
 * renderFrames で連続レンダー」イディオム(renderStill 連打はページロードが
 * 毎回走り1枚数十秒かかる)。scale 0.5(960x540)で文字の判読可。
 *
 * CLI: tsx src/pipeline/render-stills.ts episodes/<epId> [--shots s01,s05]
 *        [--at 12.5,40.2] [--scale 0.5] [--out <dir>]
 *   --shots  ショットIDのカンマ区切り。各ショットの中央時刻を描く。
 *            省略時(--atも無い場合)は全ショットの中央時刻
 *   --at     追加の任意時刻(秒)のカンマ区切り
 *   --out    出力先(既定: episodes/<epId>/review/stills/)
 * 出力: <out>/<shotId>-t<秒>.png / at-t<秒>.png。書き出したパスを標準出力に列挙。
 */
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { bundle } from "@remotion/bundler";
import {
  openBrowser,
  renderFrames,
  selectComposition,
} from "@remotion/renderer";
import type { ShotsFile } from "../schemas/types";

type Sample = { name: string; episodeFrame: number };

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let shots: string[] | null = null;
  let at: number[] = [];
  let scale = 0.5;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--shots") shots = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--at")
      at = (argv[++i] ?? "")
        .split(",")
        .filter(Boolean)
        .map((s) => Number.parseFloat(s));
    else if (a === "--scale") scale = Number.parseFloat(argv[++i] ?? "0.5");
    else if (a === "--out") out = argv[++i] ?? null;
    else positional.push(a);
  }
  return { episodeDir: positional[0], shots, at, scale, out };
}

async function main() {
  const { episodeDir, shots, at, scale, out } = parseArgs(
    process.argv.slice(2)
  );
  if (!episodeDir) {
    console.error(
      "usage: render-stills.ts episodes/<epId> [--shots s01,s05] [--at 12.5] [--scale 0.5] [--out dir]"
    );
    process.exit(1);
  }
  const shotsPath = path.join(episodeDir, "shots.json");
  if (!existsSync(shotsPath)) {
    console.error(`${shotsPath} がありません`);
    process.exit(1);
  }
  const shotsFile = JSON.parse(readFileSync(shotsPath, "utf-8")) as ShotsFile;
  const fps = shotsFile.fps;
  const maxFrame =
    Math.max(1, Math.round(shotsFile.narration.durationSec * fps)) - 1;
  const toFrame = (sec: number) =>
    Math.min(maxFrame, Math.max(0, Math.round(sec * fps)));

  const samples: Sample[] = [];
  const wanted = shots ?? (at.length > 0 ? [] : shotsFile.shots.map((s) => s.shotId));
  for (const shotId of wanted) {
    const shot = shotsFile.shots.find((s) => s.shotId === shotId);
    if (!shot) {
      console.error(`shotId不明: ${shotId}(shots.jsonに存在しない)`);
      process.exit(1);
    }
    const mid = (shot.startSec + shot.endSec) / 2;
    samples.push({
      name: `${shot.shotId}-t${mid.toFixed(1)}`,
      episodeFrame: toFrame(mid),
    });
  }
  for (const sec of at) {
    if (!Number.isFinite(sec)) {
      console.error(`--at の時刻が不正: ${sec}`);
      process.exit(1);
    }
    samples.push({ name: `at-t${sec.toFixed(1)}`, episodeFrame: toFrame(sec) });
  }
  if (samples.length === 0) {
    console.error("描画対象がありません(--shots か --at を指定)");
    process.exit(1);
  }

  const outDir = out ?? path.join(episodeDir, "review", "stills");
  mkdirSync(outDir, { recursive: true });

  console.log(`render-stills: ${episodeDir} — ${samples.length} frames, scale=${scale}`);
  console.log("bundling...");
  const serveUrl = await bundle({
    entryPoint: path.resolve("src/remotion/QASmokeRoot.tsx"),
    publicDir: path.resolve("public"),
  });
  const browser = await openBrowser("chrome");

  try {
    const inputProps = {
      episodeDir,
      sampleFrames: samples.map((s) => s.episodeFrame),
    };
    const composition = await selectComposition({
      serveUrl,
      id: "QASmoke",
      inputProps,
      puppeteerInstance: browser,
    });
    const written: string[] = [];
    await renderFrames({
      composition,
      serveUrl,
      inputProps,
      outputDir: null,
      onFrameBuffer: (buffer: Buffer, frame: number) => {
        const p = path.join(outDir, `${samples[frame].name}.png`);
        writeFileSync(p, buffer);
        written.push(p);
      },
      imageFormat: "png",
      scale,
      concurrency: 4,
      muted: true,
      frameRange: [0, samples.length - 1],
      puppeteerInstance: browser,
      logLevel: "error",
      onStart: () => undefined,
      onFrameUpdate: () => undefined,
    });
    for (const p of written.sort()) console.log(p);
    console.log(`render-stills: ${written.length}/${samples.length} frames written`);
    process.exit(written.length === samples.length ? 0 : 1);
  } finally {
    await browser.close({ silent: true }).catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
