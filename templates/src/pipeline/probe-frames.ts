/**
 * composition.html を1回だけロードし、複数時刻のフレームをまとめて撮る高速プローブ。
 *
 * `npm run snapshot`(hyperframes CLI)は完成尺の composition では
 * Navigation timeout / protocolTimeout で失敗し、成功する規模でも1回7〜10分ブロックする。
 * 実装エージェントがその待ちでプロンプトキャッシュ(TTL5分)を失効させ、
 * コンテキスト全体の再書き込みを繰り返していたため、専用の軽量プローブを用意する。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { injectBase, resolveChromePath } from "./composition-dom";

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

/**
 * composition を1回だけロードし、指定時刻のフレームをまとめて撮る。
 *
 * 実測(ep012・215clip・490KB): ロード17秒 + 1枚あたり約35秒。
 * ロードは1回で償却されるので、時刻は必ずまとめて渡すこと。
 */
export async function captureFrames(opts: CaptureOptions): Promise<CaptureResult> {
  const meta = readCompositionMeta(readFileSync(opts.compositionPath, "utf8"));
  mkdirSync(opts.outDir, { recursive: true });

  const chromePath = resolveChromePath(opts.projectRoot);
  const rootUrl = pathToFileURL(opts.projectRoot).href.replace(/\/?$/, "/");
  const html = injectBase(readFileSync(opts.compositionPath, "utf8"), rootUrl);

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
      await page.goto(pathToFileURL(tmpHtml).href, { waitUntil: "load" });

      // NOTE: page.evaluate() には「文字列」を渡す(composition-dom.ts と同じ理由)。
      // tsx(esbuild)の keepNames が関数を __name() でラップするため、
      // アロー関数を渡すとブラウザ側で ReferenceError: __name になる。
      await page.waitForFunction(
        `(() => {
          var tl = window.__timelines && window.__timelines[${JSON.stringify(meta.compositionId)}];
          return !!tl;
        })()`,
        undefined,
        { timeout: 180000, polling: 100 }
      );

      for (const sec of opts.times) {
        // シーク後に ticker を止める。GSAP の rAF が回り続けると
        // ページが安定せず page.screenshot がタイムアウトする(実測)。
        await page.evaluate(`(() => {
          var tl = window.__timelines[${JSON.stringify(meta.compositionId)}];
          tl.pause();
          tl.time(${sec}, false);
          if (window.gsap) { window.gsap.ticker.tick(); window.gsap.ticker.sleep(); }
        })()`);
        const file = path.join(opts.outDir, frameFileName(sec));
        await page.screenshot({ path: file, animations: "disabled", timeout: 180000 });
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
  const started = Date.now();
  const result = await captureFrames({
    compositionPath,
    projectRoot: process.cwd(),
    times,
    outDir: args[outIndex + 1],
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `${result.compositionId}(尺 ${result.durationSec}秒)から ${result.files.length} 枚を ${elapsed}秒で取得`
  );
  for (const f of result.files) console.log("  " + f);
}
