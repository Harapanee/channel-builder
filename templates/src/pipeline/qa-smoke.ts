/**
 * レンダー前スモークQA(全ショットの静止画抜き取り検査)。
 *
 * 本番レンダー(数十分〜)に突入する前に、全ショットを実際にヘッドレスブラウザで
 * 描画してみて「実行時クラッシュ」「静止したまま動かないシーン」「黒フレーム」を
 * 数分で洗い出す。
 *
 * 高速化の設計(重要):
 * renderStill をフレームごとに呼ぶ素朴な実装は、巨大バンドルのページロードが
 * 毎回走るため1枚あたり十数秒かかり、199ショット(約400フレーム)で30分近く
 * かかることを実測した。そこで QASmokeRoot.tsx のサンプラーComposition
 * (出力フレーム k = Episode の sampleFrames[k] フレーム目を <Freeze> 表示)を
 * @remotion/bundler で1回バンドルし、@remotion/renderer の openBrowser で開いた
 * 1ブラウザ上で renderFrames による**連続レンダー**として一気に描く。
 * ページロードはワーカーごとに1回で済む(render-thumbs.ts の「1回バンドル+
 * ブラウザ再利用」イディオムの発展形)。
 *
 * クラッシュの隔離: renderFrames は1フレームでも例外が出ると全体が失敗する。
 * 失敗したら「未取得の最小サンプル」を renderStill で単独再現してエラー要約を
 * 記録し、その次のサンプルから renderFrames を再開する(クラッシュ1件につき
 * 1回の再開で済む)。
 *
 * 検査内容(ショットごと):
 * - フレームA = startSec + 0.5s / フレームB = startSec + min(2.5s, 尺 - 0.2s)
 *   を scale 0.25 の PNG で描画
 * - (a) 描画が例外 → ランタイムエラー(shotId + エラー要約)
 * - (b) 尺3秒以上のショットで A と B の PNG バッファが完全一致 → 静止疑い
 *   (bibleの画風は boiling で常時揺れるため、完全一致は異常)
 * - (c) 全画素がほぼ黒 → 黒フレーム疑い
 *
 * 出力: コンソールに [OK]/[NG] 一覧 + episodes/<epId>/review/qa-smoke-report.json。
 * 1件でもNGなら exit 1。中間PNGはOSのtmpに置き、終了時に削除する。
 *
 * CLI: tsx src/pipeline/qa-smoke.ts episodes/<epId> [--fast] [--concurrency N]
 *   --fast        フレームBを省略(静止疑い検査なし)して約半分の時間で走る
 *   --concurrency renderFrames のワーカー数(既定: min(8, CPU-2))
 */
import path from "node:path";
import os from "node:os";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { bundle } from "@remotion/bundler";
import {
  openBrowser,
  renderFrames,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import sharp from "sharp";
import type { ShotsFile } from "../schemas/types";

/** 「ほぼ黒」判定: RGB各チャネルの平均輝度がこの値未満(0-255) */
const BLACK_MEAN_THRESHOLD = 20;
/** 静止疑い検査を行う最小ショット尺(秒) */
const STATIC_CHECK_MIN_DUR_SEC = 3;
/** レンダー倍率(1920x1080 → 480x270) */
const RENDER_SCALE = 0.25;
/** クラッシュ隔離用 renderStill の再試行回数(一過性失敗との切り分け) */
const ISOLATE_ATTEMPTS = 2;
/** renderFrames 再開の上限(暴走防止。通常はクラッシュ数+1回で終わる) */
const MAX_PASSES = 30;

type Sample = {
  index: number; // 出力フレーム番号 = sampleFrames のindex
  shotId: string;
  label: "A" | "B";
  episodeFrame: number;
};

type ShotVerdict = {
  shotId: string;
  frames: { label: string; episodeFrame: number }[];
  issues: string[]; // 空ならOK
};

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let fast = false;
  let concurrency = Math.min(8, Math.max(2, os.cpus().length - 2));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fast") fast = true;
    else if (a === "--concurrency") {
      concurrency = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error("--concurrency には1以上の整数を指定してください");
      }
    } else positional.push(a);
  }
  return { episodeDir: positional[0], fast, concurrency };
}

async function isNearlyBlack(pngPath: string): Promise<boolean> {
  const stats = await sharp(pngPath).stats();
  // PNGはRGBAの4チャネル。RGBの3チャネルすべての平均輝度がしきい値未満なら黒疑い
  const rgb = stats.channels.slice(0, 3);
  return rgb.every((c) => c.mean < BLACK_MEAN_THRESHOLD);
}

function shortError(e: unknown): string {
  return String(e instanceof Error ? e.message : e)
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

async function main() {
  const { episodeDir, fast, concurrency } = parseArgs(process.argv.slice(2));
  if (!episodeDir) {
    console.error(
      "usage: qa-smoke.ts episodes/<epId> [--fast] [--concurrency N]"
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
  const shots = shotsFile.shots;
  const maxFrame =
    Math.max(1, Math.round(shotsFile.narration.durationSec * fps)) - 1;

  const startedAt = Date.now();
  console.log(
    `qa-smoke: ${episodeDir} — ${shots.length} shots, mode=${fast ? "fast(Aのみ)" : "full(A+B)"}, concurrency=${concurrency}`
  );

  // ---- サンプル(ショット×抜き取りフレーム)の組み立て -------------------
  const samples: Sample[] = [];
  for (const shot of shots) {
    const dur = shot.endSec - shot.startSec;
    const tA = shot.startSec + Math.min(0.5, dur / 2);
    const frameA = Math.min(maxFrame, Math.max(0, Math.round(tA * fps)));
    samples.push({
      index: samples.length,
      shotId: shot.shotId,
      label: "A",
      episodeFrame: frameA,
    });
    if (fast) continue;
    const tB = shot.startSec + Math.min(2.5, dur - 0.2);
    const frameB = Math.min(maxFrame, Math.max(0, Math.round(tB * fps)));
    if (frameB > frameA) {
      samples.push({
        index: samples.length,
        shotId: shot.shotId,
        label: "B",
        episodeFrame: frameB,
      });
    }
  }
  const sampleFrames = samples.map((s) => s.episodeFrame);

  console.log("bundling...");
  const serveUrl = await bundle({
    // qa-smoke専用のサンプラーRoot。QASmokeRoot.tsxのコメント参照
    entryPoint: path.resolve("src/remotion/QASmokeRoot.tsx"),
    publicDir: path.resolve("public"),
  });

  const browser = await openBrowser("chrome");
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "qa-smoke-"));

  let exitCode = 1;
  try {
    const inputProps = { episodeDir, sampleFrames };
    const composition = await selectComposition({
      serveUrl,
      id: "QASmoke",
      inputProps,
      puppeteerInstance: browser,
    });

    // ---- renderFrames 連続レンダー(クラッシュしたら隔離して再開) --------
    const savedPath = new Map<number, string>(); // sample index -> tmp png
    const runtimeErrors = new Map<number, string>(); // sample index -> エラー要約
    const pngPathOf = (s: Sample) =>
      path.join(tmpDir, `${s.shotId}-${s.label}.png`);

    let rendered = 0;
    const onFrameBuffer = (buffer: Buffer, frame: number) => {
      const s = samples[frame];
      const p = pngPathOf(s);
      writeFileSync(p, buffer);
      savedPath.set(frame, p);
      rendered++;
      if (rendered % 100 === 0) {
        console.log(`  ...rendered ${rendered}/${samples.length} frames`);
      }
    };

    let cursor = 0;
    for (let pass = 1; pass <= MAX_PASSES && cursor < samples.length; pass++) {
      try {
        await renderFrames({
          composition,
          serveUrl,
          inputProps,
          outputDir: null,
          onFrameBuffer,
          imageFormat: "png",
          scale: RENDER_SCALE,
          concurrency,
          muted: true,
          frameRange: [cursor, samples.length - 1],
          puppeteerInstance: browser,
          logLevel: "error",
          onStart: () => undefined,
          onFrameUpdate: () => undefined,
        });
        cursor = samples.length; // 完走
      } catch (e) {
        // 最初の未取得サンプル = クラッシュの最有力候補。単独で再現して要約を取る
        let m = cursor;
        while (m < samples.length && savedPath.has(m)) m++;
        if (m >= samples.length) break;
        const s = samples[m];
        console.log(
          `  renderFrames failed (${shortError(e).slice(0, 80)}) — isolating frame ${m} (${s.shotId}/${s.label})`
        );
        let isolated = false;
        for (
          let attempt = 1;
          attempt <= ISOLATE_ATTEMPTS && !isolated;
          attempt++
        ) {
          try {
            const { buffer } = await renderStill({
              composition,
              serveUrl,
              output: null,
              inputProps,
              frame: m,
              scale: RENDER_SCALE,
              imageFormat: "png",
              puppeteerInstance: browser,
              logLevel: "error",
            });
            if (!buffer) throw new Error("renderStill returned no buffer");
            writeFileSync(pngPathOf(s), buffer);
            savedPath.set(m, pngPathOf(s));
            isolated = true; // 一過性失敗だった(フレーム自体は正常)
          } catch (err) {
            if (attempt === ISOLATE_ATTEMPTS) {
              runtimeErrors.set(m, shortError(err));
            }
          }
        }
        cursor = m + 1; // クラッシュ地点の次から再開
      }
    }
    // MAX_PASSES を使い切って未取得のサンプルはランタイムエラー扱い
    for (let i = 0; i < samples.length; i++) {
      if (!savedPath.has(i) && !runtimeErrors.has(i)) {
        runtimeErrors.set(i, "レンダー未完(renderFrames再開上限に到達)");
      }
    }

    // ---- ショット単位の判定 ----------------------------------------------
    const byShot = new Map<string, Sample[]>();
    for (const s of samples) {
      const list = byShot.get(s.shotId) ?? [];
      list.push(s);
      byShot.set(s.shotId, list);
    }

    const verdicts: ShotVerdict[] = [];
    for (const shot of shots) {
      const dur = shot.endSec - shot.startSec;
      const shotSamples = byShot.get(shot.shotId) ?? [];
      const issues: string[] = [];

      for (const s of shotSamples) {
        const err = runtimeErrors.get(s.index);
        if (err !== undefined) {
          issues.push(
            `ランタイムエラー(frame ${s.episodeFrame}/${s.label}): ${err}`
          );
          continue;
        }
        const p = savedPath.get(s.index);
        if (p && (await isNearlyBlack(p))) {
          issues.push(
            `黒フレーム疑い(frame ${s.episodeFrame}/${s.label}): 全画素がほぼ黒`
          );
        }
      }

      // 静止疑い: 尺3秒以上でA・B双方の描画に成功し、PNGが完全一致
      const a = shotSamples.find((s) => s.label === "A");
      const b = shotSamples.find((s) => s.label === "B");
      const pa = a !== undefined ? savedPath.get(a.index) : undefined;
      const pb = b !== undefined ? savedPath.get(b.index) : undefined;
      if (dur >= STATIC_CHECK_MIN_DUR_SEC && pa && pb) {
        if (readFileSync(pa).equals(readFileSync(pb))) {
          issues.push(
            `静止疑い: frame ${a!.episodeFrame} と ${b!.episodeFrame} が完全一致(${dur.toFixed(1)}秒ショットが無動作)`
          );
        }
      }

      verdicts.push({
        shotId: shot.shotId,
        frames: shotSamples.map((s) => ({
          label: s.label,
          episodeFrame: s.episodeFrame,
        })),
        issues,
      });
    }

    // ---- コンソール出力 ----------------------------------------------------
    const ngList = verdicts.filter((v) => v.issues.length > 0);
    for (const v of verdicts) {
      if (v.issues.length === 0) {
        console.log(`[OK] ${v.shotId}`);
      } else {
        for (const issue of v.issues) {
          console.log(`[NG] ${v.shotId}: ${issue}`);
        }
      }
    }

    const elapsedSec = Math.round((Date.now() - startedAt) / 10) / 100;
    console.log(
      `qa-smoke: ${verdicts.length - ngList.length}/${verdicts.length} shots OK, ` +
        `${samples.length} frames sampled, ${elapsedSec}s elapsed`
    );

    // ---- レポートJSON ------------------------------------------------------
    const reviewDir = path.join(episodeDir, "review");
    mkdirSync(reviewDir, { recursive: true });
    const reportPath = path.join(reviewDir, "qa-smoke-report.json");
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          episodeDir,
          generatedAt: new Date().toISOString(),
          mode: fast ? "fast" : "full",
          concurrency,
          shotsTotal: verdicts.length,
          framesSampled: samples.length,
          elapsedSec,
          ok: ngList.length === 0,
          ngCount: ngList.length,
          ng: ngList,
          shots: verdicts,
        },
        null,
        2
      ) + "\n"
    );
    console.log(`report: ${reportPath}`);

    exitCode = ngList.length === 0 ? 0 : 1;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true }); // 中間PNGを削除
    await browser.close({ silent: true }).catch(() => undefined);
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
