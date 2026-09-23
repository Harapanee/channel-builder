/**
 * 区間(CHUNK 本ぶんのカット)を1本の part mp4 に焼く ffmpeg 引数の組み立て。
 *
 * **assemble.ts(本番)と preview-chapter.ts(章プレビュー)の両方がここを通る。**
 * 以前は preview が組み立てを複製しており、skipHeadFrames・章カードの紙色合成・図解の重ねが
 * プレビューにだけ欠けていた(2026-09-23 レビュー指摘 C5)。プレビューの存在理由は
 * 「本番と同じ見た目を章単位で見せる」ことなので、組み立ては一本にする。
 *
 * 紙色・解像度の定数もここに一箇所で置く(render-figures.ts もここから読む)。
 * render-subs.py(Python)は import できないので同じ値を自前で持つ。変えるなら両方。
 */
import { join } from "node:path";
import type { OverlayWindow, Segment } from "./assemble";
import { overlayEnableExpr, overlayPtsExpr } from "./figures";
import type { FigureChunkOverlay } from "./figures";

/** 完成品の解像度 */
export const OUT_W = 1920;
export const OUT_H = 1080;
/** 紙色(--animal-paper)。章カードの下地・図解の紙に使う */
export const PAPER_HEX = "F4F1E7";
export const PAPER_FFMPEG = "0x" + PAPER_HEX;

/** 元のフレーム数を目標フレーム数へ合わせる setpts フィルタ */
export function speedFilter(srcFrames: number, dstFrames: number): string {
  return "setpts=" + (dstFrames / srcFrames).toFixed(6) + "*PTS";
}

/**
 * クリップを区間へ収めるフィルタ。
 *
 * 既定は `setpts` で目標フレーム数へ詰める(早回し)。**holdSlow のときは伸縮しない** —
 * 後段の `trim=end_frame=<目標>` が頭から必要ぶんだけ切るので、等速のまま尺が合う。
 * 代わりにクリップ後半の絵は落ちるので、書き手は先頭で完結する構図にする必要がある。
 */
export function videoFilter(srcFrames: number, dstFrames: number, holdSlow = false): string {
  return holdSlow ? "null" : speedFilter(srcFrames, dstFrames);
}

/**
 * 先頭 k フレームを捨てるフィルタ(cuts.json の skipHeadFrames)。k=0 なら空文字。
 * videoFilter の**前**に置く(捨てたあとの残りフレーム数を目標へ詰める)。
 */
export function headTrimFilter(skipHeadFrames: number): string {
  const k = Math.max(0, Math.floor(skipHeadFrames || 0));
  return k > 0 ? "trim=start_frame=" + k + ",setpts=PTS-STARTPTS," : "";
}

/**
 * 章カードは生成クリップを使わず紙色で合成する(2026-09-09: 板の窓の外へ1コマ漏れたとき
 * H3 が描いた章カードがチカッと見えた。下地を紙色にしておけば、万一漏れても板と同色で見えない)
 */
export const isSynthCard = (s: Pick<Segment, "card">): boolean => Boolean(s.card);

/** 伸縮・不足判定に使う「使えるフレーム数」。skipHeadFrames ぶんは捨てる。合成カードは目標そのもの */
export function effectiveSourceFrames(s: Segment, rawFrames: number): number {
  return isSynthCard(s) ? s.frames : Math.max(1, rawFrames - s.skipHeadFrames);
}

export function clipInputArgs(s: Segment, clipPath: string, fps: number): string[] {
  return isSynthCard(s)
    ? ["-f", "lavfi", "-i", "color=c=" + PAPER_FFMPEG + ":s=" + OUT_W + "x" + OUT_H + ":r=" + fps + ":d=" + (s.frames / fps + 0.5).toFixed(3)]
    : ["-i", clipPath];
}

/**
 * 字幕の enable 式。**フレーム番号の半開区間 [from, to)**(2026-09-23 レビュー指摘 C7)。
 * 秒の `between(t,from,to)` は両端を含むので、前の文の終わりと次の文の始まりが同じ秒だと
 * 境界の1コマに2枚が重なり、3桁に丸めた秒が実フレーム時刻とずれると端の1コマが落ちる
 * (図解で 2026-09-09 に実測した型と同じ)。
 */
export function subtitleEnableExpr(fromFrame: number, toFrame: number): string {
  return "gte(n," + fromFrame + ")*lt(n," + toFrame + ")";
}

export interface ChunkArgsInput {
  chunk: Segment[];
  /** 区間先頭基準の字幕窓(overlayWindows の戻り) */
  overlays: OverlayWindow[];
  /** 区間に重なる図解(figureOverlaysForChunk の戻り) */
  figs: FigureChunkOverlay[];
  fps: number;
  clipPath: (s: Segment) => string;
  subPath: (o: OverlayWindow) => string;
  /** クリップの実フレーム数(skipHeadFrames を引く前)。合成カードでは呼ばない */
  rawSourceFrames: (s: Segment) => number;
  dest: string;
}

/** 1区間を焼く ffmpeg 引数(先頭の "-y" から出力先まで) */
export function buildChunkArgs(i: ChunkArgsInput): string[] {
  const { chunk, overlays, figs, fps } = i;
  const src = (s: Segment): number => (isSynthCard(s) ? s.frames : effectiveSourceFrames(s, i.rawSourceFrames(s)));
  const args = ["-y"];
  for (const s of chunk) args.push(...clipInputArgs(s, i.clipPath(s), fps));
  for (const o of overlays) args.push("-i", i.subPath(o));
  // 図解の連番は必要な範囲だけ読む(-start_number)。入力番号は字幕の後ろに続く
  for (const g of figs) args.push("-framerate", String(fps), "-start_number", String(g.startNumber), "-i", join(g.dir, "f%05d.png"));

  const f = chunk.map((s, k) =>
    "[" + k + ":v]" + (isSynthCard(s) ? "" : headTrimFilter(s.skipHeadFrames)) + videoFilter(src(s), s.frames, s.holdSlow)
    + ",fps=" + fps + ",trim=start_frame=0:end_frame=" + s.frames + ",setpts=PTS-STARTPTS"
    + ",scale=" + OUT_W + ":" + OUT_H + ":force_original_aspect_ratio=increase,crop=" + OUT_W + ":" + OUT_H
    + ",format=yuv420p[v" + k + "]");
  f.push(chunk.map((_, k) => "[v" + k + "]").join("") + "concat=n=" + chunk.length + ":v=1:a=0[cat]");

  let chain = "[cat]";
  // 図解は映像の上・字幕の下に重ねる(暗転は図解側に焼き込み済み)
  figs.forEach((g, k) => {
    const inIdx = chunk.length + overlays.length + k;
    // フレーム番号で閉じる(秒の丸めで窓の両端が1コマ落ち、下のクリップが見える事故の恒久修正。2026-09-09)
    f.push("[" + inIdx + ":v]trim=end_frame=" + g.frames + ",setpts=" + overlayPtsExpr(g.atFrame, fps) + "[fg" + k + "]");
    f.push(chain + "[fg" + k + "]overlay=0:0:eof_action=pass:enable='" + overlayEnableExpr(g.atFrame, g.frames) + "'[g" + k + "]");
    chain = "[g" + k + "]";
  });
  if (overlays.length === 0) {
    f.push(chain + "null[vout]");
  } else {
    overlays.forEach((o, k) => {
      const label = k === overlays.length - 1 ? "[vout]" : "[o" + k + "]";
      f.push(chain + "[" + (chunk.length + k) + ":v]overlay=0:0:enable='" + subtitleEnableExpr(o.fromFrame, o.toFrame) + "'" + label);
      chain = "[o" + k + "]";
    });
  }

  args.push("-filter_complex", f.join(";"), "-map", "[vout]",
    "-c:v", "h264_videotoolbox", "-b:v", "12M", "-pix_fmt", "yuv420p", i.dest);
  return args;
}
