import assert from "node:assert/strict";
import test from "node:test";
import { bedArgs, legacyBgmSegments, legacySeCues } from "./legacy-cues";

const T = [
  { file: "audio/bgm/a.mp3", startSec: 0, endSec: 25, gainDb: -21 },
  { file: "audio/bgm/a.mp3", startSec: 25, endSec: 40, gainDb: -15 }, // 同一曲・地続き → フェードなし
  { file: "audio/bgm/b.mp3", startSec: 40, endSec: 60, gainDb: -21 }, // 最終区間 → 末尾フェードのみ
];

test("BGM 区間: 地続きの同一曲はフェードなし、曲替わりは1.5秒フェード+3秒無音、最終はフェードのみ", () => {
  const s = legacyBgmSegments([T[0], T[2]]);
  assert.equal(s[0].audibleSec, 22); // 25 - 3秒の無音
  assert.equal(s[0].fadeSec, 1.5);
  const c = legacyBgmSegments(T);
  assert.equal(c[0].fadeSec, 0);
  assert.equal(c[0].audibleSec, 25);
  assert.equal(c[2].audibleSec, 20);
  assert.equal(c[2].fadeSec, 1.5);
  assert.ok(Math.abs(c[0].volume - 10 ** (-21 / 20)) < 1e-9);
  assert.equal(c[0].file, "assets/audio/bgm/a.mp3");
});

test("SE: ショットの開始秒+atSec、gainDb 未指定は -9dB", () => {
  const cues = legacySeCues([{ startSec: 10, sfx: [{ cue: "jaan.mp3", atSec: 0.15 }] }, { startSec: 20 }]);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].src, "assets/audio/se/jaan.mp3");
  assert.equal(cues[0].start, 10.15);
  assert.ok(Math.abs(cues[0].volume - 10 ** (-9 / 20)) < 1e-9);
});

test("ベッド: ループ入力・可聴尺で切ってフェード、区間尺まで無音で延ばす", () => {
  const a = bedArgs({ file: "x.mp3", startSec: 0, durSec: 25, audibleSec: 22, fadeSec: 1.5, volume: 0.1 }, "bed.wav").join(" ");
  assert.match(a, /-stream_loop -1 -i x\.mp3/);
  assert.match(a, /atrim=0:22/);
  assert.match(a, /afade=t=out:st=20\.5:d=1\.5/);
  assert.match(a, /apad=whole_dur=25/);
});
