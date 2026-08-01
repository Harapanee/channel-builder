/**
 * composition.html を1回だけロードし、複数時刻のフレームをまとめて撮る高速プローブ。
 *
 * `npm run snapshot`(hyperframes CLI)は完成尺の composition では
 * Navigation timeout / protocolTimeout で失敗し、成功する規模でも1回7〜10分ブロックする。
 * 実装エージェントがその待ちでプロンプトキャッシュを失効させ、コンテキスト全体の
 * 再書き込みを繰り返していたため、専用の軽量プローブを用意する。
 *
 * ★2026-08-01 修正(フィデリティ事故): 初版は HFランタイムを注入せず、生のGSAP
 * タイムラインを `tl.time()` でシークするだけだった。HyperFrames で「時間窓の外のclipを
 * 隠す」のは **ランタイム(window.__player)の仕事**なので、注入しないと215clipぶんのDOMが
 * すべて重なって写る。ep012の実測では、レンダー済みmp4の同時刻フレームとの平均差が
 * 117(255階調)に達し、実装エージェントは**別物の絵**を見て合否判定していた。
 * ランタイムを注入して `__player.renderSeek()` でシークすると差は 2.25 に下がり、
 * かつ1枚あたり 30秒 → 3秒 になる(関係ないDOMをラスタライズしなくなるため)。
 * 手順は hyperframes CLI 自身のレンダー経路(dist/cli.js)と同じものを使っている。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { injectBase, resolveChromePath } from "./composition-dom";
import { BLANK_STD_THRESHOLD, SUBTITLE_ZONE_TOP, lumaStdOfFrame } from "./qa-flat-frames";

export type CompositionMeta = {
  compositionId: string;
  durationSec: number;
};

export type CaptureOptions = {
  compositionPath: string;
  /** 素材の相対パス(assets/...)を解決する基準 */
  projectRoot: string;
  times: number[];
  outDir: string;
};

export type CaptureResult = CompositionMeta & { files: string[] };

export type FrameReport = {
  file: string;
  /** 字幕帯を除いた領域の輝度の標準偏差。0 に近いほど「何も描かれていない」 */
  lumaStd: number;
  blank: boolean;
};

/** ページ遷移・タイムライン登録待ちの予算(ms)。長尺compositionはロードだけで60秒超になる */
export const LOAD_TIMEOUT_MS = 300000;
/** 1フレームぶんのシーク完了待ちの予算(ms) */
export const SEEK_TIMEOUT_MS = 60000;

/**
 * `--at 9,1,4.5` の指定を解釈する。
 * 尺を超える時刻を黙って撮ると「最後のフレーム」が返り、誤った合格判定につながるため拒否する。
 */
export function parseTimesArg(arg: string, durationSec: number): number[] {
  const raw = arg.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (raw.length === 0) throw new Error("時刻が指定されていません(--at 12.5,30 のように渡す)");
  const times = raw.map((s) => {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`時刻として解釈できません: ${s}`);
    if (n < 0 || n > durationSec) {
      throw new Error(`尺(${durationSec}秒)の範囲外の時刻です: ${s}`);
    }
    return n;
  });
  return [...new Set(times)].sort((a, b) => a - b);
}

/** 時刻からフレームのファイル名を作る */
export function frameFileName(sec: number): string {
  return `at-${sec}.png`;
}

/** composition が既にランタイムを持っているか(HFコンパイラと同じ判定) */
const RUNTIME_MARKERS = [
  "hyperframe.runtime.iife.js",
  "hyperframe-runtime.js",
  "data-hyperframes-preview-runtime",
];

/**
 * HFのプレビュー/レンダーと同じ形でランタイムを `<head>` へ注入する。
 * これが無いと `window.__player` が生えず、clipの時間窓制御が一切かからない。
 */
export function injectRuntime(html: string, runtimeUrl: string): string {
  if (RUNTIME_MARKERS.some((m) => html.includes(m))) return html;
  const tag = `<script data-hyperframes-preview-runtime="1" src="${runtimeUrl}"></script>`;
  return html.replace(/<head([^>]*)>/i, (m) => `${m}${tag}`);
}

/** ランタイムの実体を探す既定の候補(プロジェクト内 → npxキャッシュ) */
function defaultRuntimeCandidates(projectRoot: string): string[] {
  const names = ["hyperframe-runtime.js", "hyperframe.runtime.iife.js"];
  const out = names.map((n) => path.join(projectRoot, "node_modules", "hyperframes", "dist", n));
  const npxRoot = path.join(homedir(), ".npm", "_npx");
  if (existsSync(npxRoot)) {
    for (const dir of readdirSync(npxRoot)) {
      for (const n of names) {
        out.push(path.join(npxRoot, dir, "node_modules", "hyperframes", "dist", n));
      }
    }
  }
  return out;
}

/**
 * `hyperframe-runtime.js` の実体パスを返す。
 * 見つからないまま**黙って生GSAPシークへ落ちない** — それが上記フィデリティ事故の入口だった。
 */
export function resolveRuntimePath(
  projectRoot: string,
  candidates: (projectRoot: string) => string[] = defaultRuntimeCandidates
): string {
  const found = candidates(projectRoot).find((p) => existsSync(p));
  if (found) return found;
  throw new Error(
    "hyperframe-runtime.js が見つかりません(HyperFrames が未取得)。" +
      "`npm run dev` を一度実行してから再試行してください。" +
      "ランタイム無しで撮ったフレームは、時間窓外のclipが重なった別物の絵になります"
  );
}

/** 素材のデコード待ちの上限(ms)。読めない素材があっても撮影は続行する */
export const DECODE_TIMEOUT_MS = 30000;

/**
 * 画面上の `<img>` のデコード完了を待つ。
 *
 * なぜ要るか(sekaishi-longform ep001-plague-doctor で実測): HFランタイムの
 * `__renderReady` は clip の構築完了を示すだけで、**素材画像のデコードは待たない**。
 * 285clip・素材48点の composition では t=300 の撮影時点で古文書の画像が未デコードのまま撮られ、
 * 素材が載るはずの位置が下地の色で写った(**同じclipの t=301 では正しく写る**)。
 * 実装エージェントはこの絵を見て「素材が抜けている」と誤判定する。
 * probe は「レンダー結果と一致する絵」を出すための道具なので、これは道具側の欠陥である。
 *
 * `complete` ではなく `decode()` を待つ(`complete` は読み込み試行の終了であって
 * デコード完了ではない)。読めない素材で止まらないよう、個々の失敗は握りつぶし、全体にも上限を置く。
 */
export async function settleImages(
  page: { evaluate: (expr: string) => Promise<unknown> },
  timeoutMs: number = DECODE_TIMEOUT_MS
): Promise<void> {
  // NOTE: evaluate には「文字列」を渡す(tsx の keepNames 対策。上の goto 周辺と同じ理由)
  const done = page.evaluate(`(() => {
    var imgs = Array.prototype.slice.call(document.images || []);
    return Promise.all(imgs.map(function (im) {
      var p = im.decode ? im.decode() : Promise.resolve();
      return p.catch(function () {});
    })).then(function () { return true; });
  })()`);
  await Promise.race([
    done.catch(() => undefined),
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
    }),
  ]);
}

/**
 * composition を1回だけロードし、指定時刻のフレームをまとめて撮る。
 *
 * 実測(ep012・215clip・490KB): ロード約65秒 + 1枚あたり約3秒。
 * ロードは1回で償却されるので、時刻は必ずまとめて渡すこと。
 */
export async function captureFrames(opts: CaptureOptions): Promise<CaptureResult> {
  const source = readFileSync(opts.compositionPath, "utf8");
  const meta = readCompositionMeta(source);
  mkdirSync(opts.outDir, { recursive: true });

  const chromePath = resolveChromePath(opts.projectRoot);
  const runtimeUrl = pathToFileURL(resolveRuntimePath(opts.projectRoot)).href;
  const rootUrl = pathToFileURL(opts.projectRoot).href.replace(/\/?$/, "/");
  const html = injectRuntime(injectBase(source, rootUrl), runtimeUrl);

  // NOTE: page.setContent() は使わない。composition-dom.ts と同じ理由で、
  // setContent した文書の origin は file:// にならず Chrome がローカル素材の読み込みを拒否する。
  const tmpDir = mkdtempSync(path.join(tmpdir(), "hf-probe-frames-"));
  const files: string[] = [];
  try {
    const tmpHtml = path.join(tmpDir, "probe.html");
    writeFileSync(tmpHtml, html);

    const browser = await chromium.launch({ executablePath: chromePath, args: ["--mute-audio"] });
    try {
      const page = await browser.newPage({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
      });
      // load ではなく domcontentloaded を待つ。ランタイム込みの長尺compositionは
      // load イベントまで30秒(playwright既定)を超えることがある。
      await page.goto(pathToFileURL(tmpHtml).href, {
        waitUntil: "domcontentloaded",
        timeout: LOAD_TIMEOUT_MS,
      });

      // NOTE: page.evaluate() には「文字列」を渡す(composition-dom.ts と同じ理由)。
      // tsx(esbuild)の keepNames が関数を __name() でラップするため、
      // アロー関数を渡すとブラウザ側で ReferenceError: __name になる。
      await page.waitForFunction(
        `(() => {
          var tl = window.__timelines && window.__timelines[${JSON.stringify(meta.compositionId)}];
          return !!tl;
        })()`,
        undefined,
        { timeout: LOAD_TIMEOUT_MS, polling: 100 }
      );
      await page.waitForFunction("window.__playerReady === true", undefined, {
        timeout: LOAD_TIMEOUT_MS,
        polling: 100,
      });
      const hasPlayer = await page.evaluate(`(() => typeof window.__player === "object" && window.__player !== null)()`);
      if (!hasPlayer) {
        throw new Error(
          "HFランタイムが初期化されませんでした(window.__player が無い)。" +
            "この状態で撮ると時間窓外のclipが重なった別物の絵になるため中止します"
        );
      }
      await page.waitForFunction("window.__renderReady === true", undefined, {
        timeout: LOAD_TIMEOUT_MS,
        polling: 100,
      }).catch(() => undefined);
      /* ロード直後に一度、素材のデコードを済ませておく(1枚目の待ちを償却する) */
      await settleImages(page);

      for (const sec of opts.times) {
        // hyperframes CLI 自身のレンダー経路と同じ手順:
        // ランタイムの renderSeek(clipの表示制御つき)＋ 各タイムラインの totalTime 往復。
        await page.evaluate(`(() => {
          var w = window, tt = ${sec};
          var call = function (f) { try { f(); } catch (e) {} };
          call(function () {
            if (w.__player && typeof w.__player.renderSeek === "function") w.__player.renderSeek(tt);
            else if (w.__player && typeof w.__player.seek === "function") w.__player.seek(tt);
          });
          Object.keys(w.__timelines || {}).forEach(function (k) {
            var tl = w.__timelines[k];
            call(function () {
              if (tl.pause) tl.pause();
              if (typeof tl.totalTime === "function") {
                tl.totalTime(tt + 0.001, true);
                tl.totalTime(tt, false);
              } else if (typeof tl.time === "function") {
                tl.time(tt, false);
              }
            });
          });
          if (w.gsap && w.gsap.ticker) { w.gsap.ticker.tick(); w.gsap.ticker.sleep(); }
        })()`);
        await page.waitForFunction("window.__renderReady !== false", undefined, {
          timeout: SEEK_TIMEOUT_MS,
          polling: 50,
        }).catch(() => undefined);
        await settleImages(page);
        const file = path.join(opts.outDir, frameFileName(sec));
        await page.screenshot({ path: file, animations: "disabled", timeout: SEEK_TIMEOUT_MS });
        files.push(file);
      }
    } finally {
      await browser.close();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  return { ...meta, files };
}

/**
 * 撮ったフレームを機械判定する(輝度の標準偏差 — qa-flat-frames と同じ指標)。
 * 合格なら画像を1枚もReadせずに済ませられるようにするための出力。
 * 画像1枚は約1,600tok がコンテキストに残り続けるので、これが実コストに効く。
 */
export async function analyzeFrames(files: string[]): Promise<FrameReport[]> {
  const out: FrameReport[] = [];
  for (const file of files) {
    const meta = await sharp(file).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    /* 字幕帯は常に同じ見た目なので測定から外す(qa-flat-frames と同じ) */
    const usable = Math.max(1, Math.round(height * SUBTITLE_ZONE_TOP));
    const { data } = await sharp(file)
      .greyscale()
      .extract({ left: 0, top: 0, width, height: usable })
      .resize(128, null)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const lumaStd = lumaStdOfFrame(data);
    out.push({ file, lumaStd, blank: lumaStd < BLANK_STD_THRESHOLD });
  }
  return out;
}

/** 複数フレームを1枚のコンタクトシートへ連結する(Readを1回に減らすため) */
export async function buildContactSheet(
  files: string[],
  outFile: string,
  opts: { columns?: number; cellWidth?: number } = {}
): Promise<string> {
  if (files.length === 0) throw new Error("コンタクトシートに載せるフレームがありません");
  const columns = Math.max(1, opts.columns ?? Math.min(3, files.length));
  const cellWidth = opts.cellWidth ?? 640;
  const first = await sharp(files[0]).metadata();
  const ratio = (first.height ?? 1) / (first.width ?? 1);
  const cellHeight = Math.round(cellWidth * ratio);
  const rows = Math.ceil(files.length / columns);

  const cells = await Promise.all(
    files.map(async (f, i) => ({
      input: await sharp(f).resize(cellWidth, cellHeight, { fit: "fill" }).png().toBuffer(),
      left: (i % columns) * cellWidth,
      top: Math.floor(i / columns) * cellHeight,
    }))
  );

  await sharp({
    create: {
      width: columns * cellWidth,
      height: rows * cellHeight,
      channels: 3,
      background: "#1b1b1b",
    },
  })
    .composite(cells)
    .jpeg({ quality: 82 })
    .toFile(outFile);
  return outFile;
}

/** composition.html のルート要素から composition-id と総尺を読む */
export function readCompositionMeta(html: string): CompositionMeta {
  // 総尺は「composition-id を持つ要素そのもの」から読む。
  // 実物の composition.html は <audio> など data-duration を持つ別要素を含むため、
  // 文書内の最初の data-duration を拾うと誤った尺になる。
  const rootTag = html.match(/<[^<>]*\bdata-composition-id="([^"]+)"[^<>]*>/);
  if (!rootTag) {
    throw new Error("composition.html に data-composition-id を持つ要素が見つかりません");
  }
  const durationMatch = rootTag[0].match(/\bdata-duration="([^"]+)"/);
  if (!durationMatch) {
    throw new Error("composition のルート要素に data-duration がありません");
  }
  return { compositionId: rootTag[1], durationSec: Number(durationMatch[1]) };
}

// ---- CLI ----
// npx tsx src/pipeline/probe-frames.ts episodes/<epId> --at 100,300,500 -o <出力先>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const episodeDir = args[0];
  const atIndex = args.indexOf("--at");
  const outIndex = args.indexOf("-o");
  if (!episodeDir || atIndex === -1 || outIndex === -1) {
    console.error(
      "使い方: npx tsx src/pipeline/probe-frames.ts episodes/<epId> --at <秒,...> -o <出力先>"
    );
    process.exit(2);
  }
  const compositionPath = episodeDir.endsWith(".html")
    ? episodeDir
    : path.join(episodeDir, "composition.html");
  const meta = readCompositionMeta(readFileSync(compositionPath, "utf8"));
  const times = parseTimesArg(args[atIndex + 1], meta.durationSec);
  const outDir = args[outIndex + 1];
  const started = Date.now();
  const result = await captureFrames({
    compositionPath,
    projectRoot: process.cwd(),
    times,
    outDir,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `${result.compositionId}(尺 ${result.durationSec}秒)から ${result.files.length} 枚を ${elapsed}秒で取得`
  );

  /* 機械判定を先に出す。合格しているフレームは画像をReadしなくてよい */
  const report = await analyzeFrames(result.files);
  for (const r of report) {
    console.log(
      `  ${r.blank ? "空の疑い" : "OK      "} 輝度std ${r.lumaStd.toFixed(1).padStart(5)}  ${r.file}`
    );
  }
  const blanks = report.filter((r) => r.blank);
  if (result.files.length > 1) {
    const sheet = await buildContactSheet(result.files, path.join(outDir, "contact.jpg"));
    console.log(`  コンタクトシート(この1枚だけReadすれば全時刻を見られる): ${sheet}`);
  }
  if (blanks.length > 0) {
    console.error(
      `\n${blanks.length} 枚が「何も描かれていない」判定です(輝度std < ${BLANK_STD_THRESHOLD})。` +
        `clip内の生成順・素材の読み込み失敗・z-index を疑ってください`
    );
    process.exit(1);
  }
}
