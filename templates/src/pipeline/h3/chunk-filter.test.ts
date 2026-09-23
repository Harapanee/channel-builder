import assert from "node:assert/strict";
import test from "node:test";
import {
  OUT_H,
  OUT_W,
  PAPER_FFMPEG,
  PAPER_HEX,
  buildChunkArgs,
  clipInputArgs,
  effectiveSourceFrames,
  subtitleEnableExpr,
} from "./chunk-filter";
import type { OverlayWindow, Segment } from "./assemble";
import { headTrimFilter, videoFilter } from "./assemble";

const FPS = 24;
const seg = (over: Partial<Segment>): Segment => ({
  clipId: "cL01", lineIds: ["L01"], startSec: 0, frames: 48, offsetFrames: 0,
  holdSlow: false, skipHeadFrames: 0, noSub: false, ...over,
});

test("紙色と解像度の定数は一箇所(F4F1E7 / 1920x1080)", () => {
  assert.equal(PAPER_HEX, "F4F1E7");
  assert.equal(PAPER_FFMPEG, "0xF4F1E7");
  assert.equal(OUT_W, 1920);
  assert.equal(OUT_H, 1080);
});

test("assemble から headTrimFilter / videoFilter を従来どおり import できる(移設しても口は変えない)", () => {
  assert.equal(headTrimFilter(3), "trim=start_frame=3,setpts=PTS-STARTPTS,");
  assert.equal(videoFilter(48, 24), "setpts=0.500000*PTS");
});

test("字幕の enable はフレーム番号の半開区間 [from, to)", () => {
  assert.equal(subtitleEnableExpr(0, 60), "gte(n,0)*lt(n,60)");
});

test("effectiveSourceFrames: skipHeadFrames ぶん引く。章カードは目標フレーム数そのもの", () => {
  assert.equal(effectiveSourceFrames(seg({ skipHeadFrames: 5 }), 100), 95);
  assert.equal(effectiveSourceFrames(seg({ card: true, frames: 48 }), 100), 48);
  assert.equal(effectiveSourceFrames(seg({ skipHeadFrames: 500 }), 100), 1);
});

test("clipInputArgs: 章カードは紙色の lavfi、その他はクリップファイル", () => {
  assert.deepEqual(clipInputArgs(seg({}), "/c/cL01.mp4", FPS), ["-i", "/c/cL01.mp4"]);
  const card = clipInputArgs(seg({ card: true, frames: 48 }), "/c/cL01.mp4", FPS);
  assert.equal(card[0], "-f");
  assert.equal(card[1], "lavfi");
  assert.equal(card[3], "color=c=0xF4F1E7:s=1920x1080:r=24:d=2.500");
});

function build(over: Partial<Parameters<typeof buildChunkArgs>[0]> = {}): string[] {
  const chunk = [seg({ clipId: "cL01", skipHeadFrames: 3 }), seg({ clipId: "cL02", card: true, frames: 24, offsetFrames: 48 })];
  const overlays: OverlayWindow[] = [{ lineId: "L01", png: "/s/sub_L01.png", from: "0.000", to: "1.500", fromFrame: 0, toFrame: 36 }];
  return buildChunkArgs({
    chunk, overlays, figs: [], fps: FPS,
    clipPath: (s) => "/c/" + s.clipId + ".mp4",
    subPath: (o) => o.png ?? "",
    rawSourceFrames: () => 72,
    dest: "/p/part000.mp4",
    ...over,
  });
}

const filterOf = (args: string[]): string => args[args.indexOf("-filter_complex") + 1];

test("buildChunkArgs: skipHeadFrames を捨ててから早回しする", () => {
  const f = filterOf(build());
  // 72F から 3F 捨てた 69F を 48F へ
  assert.ok(f.includes("[0:v]trim=start_frame=3,setpts=PTS-STARTPTS,setpts=" + (48 / 69).toFixed(6) + "*PTS"), f);
});

test("buildChunkArgs: 章カードは紙色で合成し、クリップを読まない", () => {
  const args = build();
  assert.ok(!args.includes("/c/cL02.mp4"));
  assert.ok(args.some((a) => a.startsWith("color=c=0xF4F1E7")));
  // 合成カードは skipHeadFrames を当てず、等倍(目標フレーム数そのもの)で使う
  assert.ok(filterOf(args).includes("[1:v]setpts=1.000000*PTS,fps=24"), filterOf(args));
});

test("buildChunkArgs: 字幕はフレーム番号の半開区間で重ねる(秒の between を使わない)", () => {
  const f = filterOf(build());
  assert.ok(f.includes("overlay=0:0:enable='gte(n,0)*lt(n,36)'[vout]"), f);
  assert.ok(!f.includes("between(t,"));
});

test("buildChunkArgs: 図解は映像の上・字幕の下(字幕の前に重ねる)", () => {
  const args = build({ figs: [{ id: "fig1", dir: "/f/fig1", startNumber: 0, frames: 24, atSec: "0.500", atFrame: 12 }] });
  const f = filterOf(args);
  assert.ok(args.includes("/f/fig1/f%05d.png"));
  const fig = f.indexOf("[fg0]overlay");
  const sub = f.indexOf("enable='gte(n,0)*lt(n,36)'");
  assert.ok(fig >= 0 && sub > fig, f);
  assert.ok(f.includes("between(n,12,35)"), f);
});

test("buildChunkArgs: 解像度は定数から(scale と crop)", () => {
  assert.ok(filterOf(build()).includes("scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080"));
});

test("buildChunkArgs: 出力先は最後の引数", () => {
  const args = build();
  assert.equal(args[args.length - 1], "/p/part000.mp4");
});

test("buildChunkArgs: 字幕も図解も無ければ null で出す", () => {
  assert.ok(filterOf(build({ overlays: [] })).endsWith("[cat]null[vout]"));
});
