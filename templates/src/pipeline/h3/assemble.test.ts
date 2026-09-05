import assert from "node:assert/strict";
import test from "node:test";
import {
  ambientPath, assertUniformFps, buildSegments, checkAmbient, checkMasterAudio, holdSlowShortfalls, overlayWindows, parseFrameRate,
  partCacheSpec, speedFilter, subsByLine, targetFrames, videoFilter,
} from "./assemble";
import type { AmbientAudioFacts } from "./assemble";
import type { Cut } from "./types";
import type { TimingLine } from "./plan";

/** 行間に無音がある実データの形(ep015 は302箇所すべてに 0.35〜0.70秒ある) */
const LINES: TimingLine[] = [
  { lineId: "L01", text: "a", startSec: 0, endSec: 1.6 },
  { lineId: "L02", text: "b", startSec: 2.0, endSec: 4.6 },
  { lineId: "L03", text: "c", startSec: 5.0, endSec: 10.6 },
];
const TOTAL = 11.0;
const FPS = 24;
const cut = (lineIds: string[]): Cut => ({ lineIds, seconds: 0, place: "", subject: "", role: "" });

test("目標フレーム数はタイムライン区間。発話区間ではない", () => {
  // L01 の発話は 1.6秒 だが、次の行が始まるまでの 2.0秒 を受け持つ
  assert.equal(targetFrames(cut(["L01"]), LINES, TOTAL, FPS), 48);
  assert.notEqual(targetFrames(cut(["L01"]), LINES, TOTAL, FPS), Math.round(1.6 * FPS));
});

test("最終行は総尺まで受け持つ", () => {
  assert.equal(targetFrames(cut(["L03"]), LINES, TOTAL, FPS), Math.round(11.0 * FPS) - Math.round(5.0 * FPS));
});

test("束ねたカットは先頭行の開始から最終行の次の行の開始まで", () => {
  assert.equal(targetFrames(cut(["L01", "L02"]), LINES, TOTAL, FPS), Math.round(5.0 * FPS));
});

test("全カットのフレーム合計が総尺と一致する(取りこぼしゼロ)", () => {
  const cuts = { cL01: cut(["L01", "L02"]), cL03: cut(["L03"]) };
  const total = Object.values(cuts).reduce((s, c) => s + targetFrames(c, LINES, TOTAL, FPS), 0);
  assert.equal(total, Math.round(TOTAL * FPS));
});

test("timing に無い行を指したら例外(台帳の食い違いを黙って通さない)", () => {
  assert.throws(() => targetFrames(cut(["L99"]), LINES, TOTAL, FPS), /L99/);
});

test("区間の先頭フレームは累積で、絶対時刻と一致する(字幕窓の恒等式)", () => {
  const segs = buildSegments({ cL01: cut(["L01", "L02"]), cL03: cut(["L03"]) }, LINES, TOTAL, FPS);
  for (const s of segs) {
    assert.equal(s.offsetFrames, Math.round(s.startSec * FPS), s.clipId + " で恒等式が崩れている");
  }
});

test("早回しのフィルタは setpts で倍率を掛ける", () => {
  assert.equal(speedFilter(248, 124), "setpts=0.500000*PTS");
  assert.equal(speedFilter(124, 124), "setpts=1.000000*PTS");
});

test("目標が元より長ければスローになる(生成尺が足りないので警告対象)", () => {
  assert.equal(speedFilter(124, 248), "setpts=2.000000*PTS");
});

// ───── ここから fix round 1 で追加 ─────
// ブリーフの8件は逐語で固定。恒等式のアサートは実装が何を代入しても真になるため、
// 「崩れる形」を入れたときに止まることを別に押さえる。

test("どのカットも持たない行があれば例外(区間に隙間ができ、以降の字幕が全部ずれる)", () => {
  // L02 を誰も持っていない。cL03 の絶対時刻 120F に対し積み上げは 48F しかない
  assert.throws(
    () => buildSegments({ cL01: cut(["L01"]), cL03: cut(["L03"]) }, LINES, TOTAL, FPS),
    /cL03/,
  );
});

test("同じ行を2つのカットが持てば例外(区間が重なる)", () => {
  assert.throws(
    () => buildSegments({ cA: cut(["L01", "L02"]), cB: cut(["L02"]), cC: cut(["L03"]) }, LINES, TOTAL, FPS),
    /cB/,
  );
});

test("隙間なく覆うカット割りなら通り、offsetFrames が積み上げになる", () => {
  const segs = buildSegments({ cL01: cut(["L01"]), cL02: cut(["L02"]), cL03: cut(["L03"]) }, LINES, TOTAL, FPS);
  assert.deepEqual(segs.map((s) => s.clipId), ["cL01", "cL02", "cL03"]);
  assert.deepEqual(segs.map((s) => s.offsetFrames), [0, 48, 120]);
  assert.deepEqual(segs.map((s) => s.frames), [48, 72, 144]);
  assert.equal(segs.reduce((a, s) => a + s.frames, 0), Math.round(TOTAL * FPS));
});

test("24fps 以外の素材があれば止まる(倍率はフレーム比なので fps が違うと結果だけが狂う)", () => {
  assert.throws(
    () => assertUniformFps([{ clipId: "cL01", fps: 24 }, { clipId: "cL07", fps: 30 }], FPS),
    /cL07=30fps/,
  );
});

test("素材が全部 24fps なら通る", () => {
  assert.doesNotThrow(() => assertUniformFps([{ clipId: "cL01", fps: 24 }, { clipId: "cL02", fps: 24 }], FPS));
});

test("r_frame_rate を数値にする。読めなければ例外", () => {
  assert.equal(parseFrameRate("24/1"), 24);
  assert.equal(parseFrameRate("30000/1001"), 30000 / 1001);
  assert.throws(() => parseFrameRate("0/0"), /fps/);
  assert.throws(() => parseFrameRate(undefined), /fps/);
});

/* ---- 組み立て前の master.mp3 の検査(HF経路の check:audio の no_bed / master_stale 相当) ---- */

/** ミックス済みの実測値: ep012 = -44.8dB / ep011 = -31.3dB。ナレーション素は -77.2dB */
const HEALTHY = { p10WindowDb: -44.8, masterMtimeMs: 2000, cuesMtimeMs: 1000 };

test("音の床が -60dB を下回ったら止める(BGMが乗っていない)", () => {
  const found = checkMasterAudio({ ...HEALTHY, p10WindowDb: -77.2 });
  assert.equal(found.length, 1);
  assert.match(found[0], /^no_bed:/);
});

test("master.mp3 が audio-cues.json より古かったら止める(焼き直し漏れ)", () => {
  const found = checkMasterAudio({ ...HEALTHY, masterMtimeMs: 1000, cuesMtimeMs: 2000 });
  assert.equal(found.length, 1);
  assert.match(found[0], /^master_stale:/);
});

test("正常なら何も出ない", () => {
  assert.deepEqual(checkMasterAudio(HEALTHY), []);
});

test("同時刻(焼いた直後)は古いとみなさない", () => {
  assert.deepEqual(checkMasterAudio({ ...HEALTHY, masterMtimeMs: 1000, cuesMtimeMs: 1000 }), []);
});

test("audio-cues.json が無ければ焼き直し漏れは判定しない", () => {
  assert.deepEqual(checkMasterAudio({ ...HEALTHY, masterMtimeMs: 1, cuesMtimeMs: 0 }), []);
});

test("2つとも壊れていれば2件とも出る", () => {
  assert.equal(checkMasterAudio({ p10WindowDb: -200, masterMtimeMs: 1, cuesMtimeMs: 2 }).length, 2);
});

/* ---- holdSlow(等速切り出し) ---- */

test("既定は従来どおり setpts で目標フレーム数へ詰める", () => {
  assert.equal(videoFilter(124, 62), "setpts=0.500000*PTS");
  assert.equal(videoFilter(124, 62), speedFilter(124, 62));
});

test("holdSlow は時間を伸縮しない(あとの trim が頭から必要ぶんだけ切る)", () => {
  assert.equal(videoFilter(124, 48, true), "null");
});

test("buildSegments は cuts.json の holdSlow を Segment へ写す", () => {
  const cuts = {
    cL01: { lineIds: ["L01"], seconds: 5.167, place: "", subject: "", role: "", holdSlow: true },
    cL02: { lineIds: ["L02"], seconds: 5.167, place: "", subject: "", role: "" },
    cL03: { lineIds: ["L03"], seconds: 5.167, place: "", subject: "", role: "" },
  };
  const segs = buildSegments(cuts, LINES, TOTAL, 24);
  assert.equal(segs[0].holdSlow, true);
  assert.equal(segs[1].holdSlow, false);
});

test("buildSegments は cuts.json の noSub を Segment へ写す", () => {
  const cuts = {
    cL01: { lineIds: ["L01"], seconds: 5.167, place: "", subject: "", role: "", noSub: true },
    cL02: { lineIds: ["L02"], seconds: 5.167, place: "", subject: "", role: "" },
    cL03: { lineIds: ["L03"], seconds: 5.167, place: "", subject: "", role: "" },
  };
  const segs = buildSegments(cuts, LINES, TOTAL, 24);
  assert.equal(segs[0].noSub, true);
  assert.equal(segs[1].noSub, false);
});

test("noSub のカットは字幕の表示窓を1枚も返さない(画面内文字との二重読みを避ける)", () => {
  const lineById = new Map(LINES.map((l) => [l.lineId, l]));
  const on = { clipId: "cL01", lineIds: ["L01", "L02"], startSec: 0, frames: 120, offsetFrames: 0, holdSlow: false, noSub: false };
  const off = { ...on, noSub: true };
  assert.equal(overlayWindows(on, lineById, 0, 24).length, 2);
  assert.deepEqual(overlayWindows(off, lineById, 0, 24), []);
});

/* ---- part キャッシュ鍵に holdSlow を含める ---- */
// 焼き済み part の再利用判定はこの鍵の文字列一致で決まる。holdSlow を鍵から漏らすと、
// 「cuts.json で holdSlow を立てて焼き直しても、まだ holdSlow が無かった頃の
// 早回し版 part がそのまま再利用される」という、検査を素通りする事故になる。

test("part キャッシュ鍵は同じ入力なら同じ文字列になる(決定性)", () => {
  const clips = [{ id: "cL01", frames: 48, src: 96, holdSlow: false, mtimeMs: 1000 }];
  assert.equal(partCacheSpec(0, clips, []), partCacheSpec(0, clips, []));
});

test("part キャッシュ鍵は holdSlow だけ変わっても変わる(でなければ古い part を拾ってしまう)", () => {
  const a = partCacheSpec(0, [{ id: "cL01", frames: 48, src: 96, holdSlow: false, mtimeMs: 1000 }], []);
  const b = partCacheSpec(0, [{ id: "cL01", frames: 48, src: 96, holdSlow: true, mtimeMs: 1000 }], []);
  assert.notEqual(a, b);
});

// Ruling 12: クリップを作り直しても frames と src(素材フレーム数)は変わらないことがある
// (同じ尺で作り直す)。id/frames/src/holdSlow だけの鍵だと、ffmpeg が途中で落ちた実行の
// あとに残った古い part がそのまま再利用され、人間が旧素材を見て合格させてしまう。
test("part キャッシュ鍵は clip の mtimeMs だけ変わっても変わる(作り直した素材を拾わない)", () => {
  const a = partCacheSpec(0, [{ id: "cL01", frames: 48, src: 96, holdSlow: false, mtimeMs: 1000 }], []);
  const b = partCacheSpec(0, [{ id: "cL01", frames: 48, src: 96, holdSlow: false, mtimeMs: 2000 }], []);
  assert.notEqual(a, b);
});

/* ---- holdSlow の素材フレーム不足を焼く前に止める(指摘1) ---- */

test("holdSlow でなければ素材が足りなくても対象外(setpts が伸縮で吸収する)", () => {
  const clips = [{ id: "cL01", frames: 72, src: 48, holdSlow: false, mtimeMs: 0 }];
  assert.deepEqual(holdSlowShortfalls(clips), []);
});

test("holdSlow で素材フレームが目標未満なら検出する(trim は超過分を黙って無視するだけでエラーにならない)", () => {
  const clips = [{ id: "cL01", frames: 72, src: 48, holdSlow: true, mtimeMs: 0 }];
  const found = holdSlowShortfalls(clips);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "cL01");
});

test("holdSlow でも素材が目標以上なら通る", () => {
  const clips = [{ id: "cL01", frames: 48, src: 72, holdSlow: true, mtimeMs: 0 }];
  assert.deepEqual(holdSlowShortfalls(clips), []);
});

test("複数本のうち holdSlow で不足しているものだけを返す", () => {
  const clips = [
    { id: "cL01", frames: 72, src: 48, holdSlow: true, mtimeMs: 0 }, // 不足
    { id: "cL02", frames: 72, src: 48, holdSlow: false, mtimeMs: 0 }, // holdSlow でないので対象外
    { id: "cL03", frames: 48, src: 72, holdSlow: true, mtimeMs: 0 }, // 足りている
  ];
  assert.deepEqual(holdSlowShortfalls(clips).map((c) => c.id), ["cL01"]);
});

/* ---- ambient.wav の鮮度・尺の検査(指摘2。checkMasterAudio と対称にする) ---- */

const AMBIENT_HEALTHY: AmbientAudioFacts = {
  ambientDurationSec: 100, totalDurationSec: 100, ambientMtimeMs: 3000, timingMtimeMs: 1000, cutsMtimeMs: 1000,
};

test("尺の差が 0.05秒 以内なら通る", () => {
  assert.deepEqual(checkAmbient({ ...AMBIENT_HEALTHY, ambientDurationSec: 100.04 }), []);
});

test("尺の差が 0.05秒 を超えたら止める(amix=duration=first は食い違いを隠すため)", () => {
  const found = checkAmbient({ ...AMBIENT_HEALTHY, ambientDurationSec: 90 });
  assert.equal(found.length, 1);
  assert.match(found[0], /^ambient_duration_mismatch:/);
});

test("timing.json が ambient.wav より新しければ止める(台本修正の焼き直し漏れ)", () => {
  const found = checkAmbient({ ...AMBIENT_HEALTHY, timingMtimeMs: 4000 });
  assert.equal(found.length, 1);
  assert.match(found[0], /^ambient_stale:/);
});

test("cuts.json が ambient.wav より新しければ止める(不合格クリップの作り直しの焼き直し漏れ)", () => {
  const found = checkAmbient({ ...AMBIENT_HEALTHY, cutsMtimeMs: 4000 });
  assert.equal(found.length, 1);
  assert.match(found[0], /^ambient_stale:/);
});

test("正常なら何も出ない", () => {
  assert.deepEqual(checkAmbient(AMBIENT_HEALTHY), []);
});

test("尺のずれと焼き直し漏れが同時に起きていれば2件とも出る", () => {
  const found = checkAmbient({ ...AMBIENT_HEALTHY, ambientDurationSec: 50, timingMtimeMs: 4000 });
  assert.equal(found.length, 2);
});

/* ---- ambient.wav の共有パス(指摘2。assemble/preview で組み立てを重複させない) ---- */

test("ambientPath は episodes/<epId>/narration/ambient.wav を指す", () => {
  assert.match(ambientPath("ep016-honeybee"), /episodes[\\/]ep016-honeybee[\\/]narration[\\/]ambient\.wav$/);
});

test("字幕台帳(1回の表示=1文)があれば、行を文ごとの窓に分けて重ねる", () => {
  const seg = { clipId: "cL03", lineIds: ["L03"], startSec: 5.0, frames: 144, offsetFrames: 120, holdSlow: false, noSub: false };
  const lineById = new Map(LINES.map((l) => [l.lineId, l]));
  const ledger = subsByLine([
    { id: "L03", png: "/s/sub_L03_1.png", start: 7.5, end: 10.6 },
    { id: "L03", png: "/s/sub_L03_0.png", start: 5.0, end: 7.5 },
  ]);
  const w = overlayWindows(seg, lineById, 120, FPS, ledger);
  assert.equal(w.length, 2);
  assert.equal(w[0].png, "/s/sub_L03_0.png");
  assert.equal(w[0].from, "0.000");
  assert.equal(w[0].to, "2.500");
  assert.equal(w[1].from, "2.500");
  // 台帳に無い行は従来どおり行全体を1枚(png 無し)
  const w2 = overlayWindows(seg, lineById, 120, FPS, subsByLine([]));
  assert.equal(w2.length, 1);
  assert.equal(w2[0].png, undefined);
});
