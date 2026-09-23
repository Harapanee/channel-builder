/**
 * keyframe カットの終点画像。H3 は文面では種固有の形を描けないので、画像モデル(gen-image.ts)に
 * 始点(鎖の最終コマ)を参照させて「変わる部位だけ」変えた1枚絵を作り、FL2VA の last_frame にする。
 * 設計: docs/superpowers/specs/2026-09-21-h3-keyframe-motion-cuts-design.md §4.2
 *
 * **CLAUDE.md の「AI画像生成は asset-generator 経由」の例外。** ここは固定テンプレをスクリプトが
 * 逐語で渡すので、規則の目的(テンプレ逐語使用)は機械的に満たされる。塗りの検査は検品(clip-inspector)で拾う。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, framesDir } from "./config";

export const END_FRAME_TEMPLATE =
  "Use the exact same character, art style, colors, and background as the reference image: the same animal, same flat colours with thick black hand-drawn marker outlines, no shading, same background and same framing. " +
  "Keep the animal's body position, size, facing direction, and camera framing IDENTICAL to the reference. " +
  "Change ONLY the following: <endState>. No text, no people, no other creatures.";

export function endFramePrompt(endState: string): string {
  return END_FRAME_TEMPLATE.replace("<endState>", endState.trim().replace(/\.$/, ""));
}

export function endFramePath(epId: string, cutId: string, outDir = framesDir(epId)): string {
  return join(outDir, cutId + "-end.png");
}

export type ImageGen = (args: { prompt: string; ref: string; out: string }) => void;

/** 既定の生成器: gen-image.ts を直接呼ぶ(codex → evolink フォールバックは gen-image 側) */
export const defaultImageGen: ImageGen = ({ prompt, ref, out }) => {
  execFileSync("npx", ["tsx", "src/pipeline/gen-image.ts", "--prompt", prompt, "--ref", ref, "--out", out, "--size", "16:9", "--n", "1", "--skip-paint-check"],
    { cwd: ROOT, stdio: "inherit" });
};

/** 非16:9 の生成物を引き伸ばさず、短辺を合わせて拡大してから中央で切り出す */
export function FFMPEG_FIT_FILTER(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
}

export function genEndFrame(opts: {
  epId: string; cutId: string; refPng: string; endState: string;
  size: { width: number; height: number };
  gen?: ImageGen; force?: boolean; outDir?: string;
  /**
   * 鎖の起点**クリップ**(mp4)。渡すと鮮度はこれの mtime で見る。
   * ff 画像(refPng)の mtime で見ると、ff を抽出し直しただけで終点が作り直される(画像生成の暴発。2026-09-23)。
   * 渡さなければ従来どおり refPng の mtime で見る。
   */
  sourceClip?: string;
}): string {
  const out = endFramePath(opts.epId, opts.cutId, opts.outDir);
  // 鎖の起点が作り直されていたら終点も作り直す(h3:reject は ff/ を触らないので mtime で見る)
  const source = opts.sourceClip ?? opts.refPng;
  const refNewer = existsSync(out) && existsSync(source) && statSync(source).mtimeMs > statSync(out).mtimeMs;
  if (existsSync(out) && !opts.force && !refNewer) return out;
  if (refNewer && !opts.force) console.log(opts.cutId + ": 始点が新しいので終点を作り直す(" + source + ")");
  mkdirSync(dirname(out), { recursive: true });
  rmSync(out, { force: true });
  const raw = out.replace(/\.png$/, "-raw.png");
  try {
    (opts.gen ?? defaultImageGen)({ prompt: endFramePrompt(opts.endState), ref: opts.refPng, out: raw });
  } catch (e) {
    const err = new Error(opts.cutId + ": 終点画像の生成に失敗(gen-image: codex/evolink)。Pod は動いたままなので、続けないなら `npm run h3:pod -- down`");
    (err as Error & { cause?: unknown }).cause = e; // tsconfig の lib が es2022 未満なので ErrorOptions を使わない
    throw err;
  }
  if (!existsSync(raw)) throw new Error(opts.cutId + ": 終点画像が生成されなかった(gen-image が出力を書いていない)。Pod は動いたままなので、続けないなら `npm run h3:pod -- down`");
  // FL2VA の last_frame は生成サイズと同じにする(ffmpeg で拡大+中央切り出し。非16:9 を引き伸ばさない。ffmpeg は鎖の最終コマ抽出でも使っている)
  execFileSync("ffmpeg", ["-v", "error", "-i", raw, "-vf", FFMPEG_FIT_FILTER(opts.size.width, opts.size.height), "-y", out]);
  rmSync(raw, { force: true });
  return out;
}
