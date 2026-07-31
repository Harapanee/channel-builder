import assert from "node:assert/strict";
import test from "node:test";
import {
  LIMITER_CEILING_LINEAR,
  buildMixArgs,
  gainForLufs,
  patchMasterSrc,
  type AudioCues,
} from "./audio-mix";

const CUES: AudioCues = {
  total: 12.5,
  narration: "episodes/ep001-x/narration/narration.wav",
  bgm: [{ id: "bgm1", src: "assets/audio/bed.mp3", start: 0, volume: 0.2, mediaStart: 1 }],
  se: [{ id: "se1", src: "assets/audio/pop.mp3", start: 3.25, volume: 0.5 }],
};

test("実測ラウドネスから目標へ合わせるゲイン(持ち上げは頭打ち)", () => {
  assert.equal(gainForLufs(-16, -22), 0.501);
  assert.equal(gainForLufs(-30, -22), 1.0, "小さすぎる素材はクリップ回避のため1.0で頭打ち");
});

test("ミックスの ffmpeg 引数: 各キューを遅延させて総和する", () => {
  const args = buildMixArgs(CUES, "out.mp3");
  const filter = args[args.indexOf("-filter_complex") + 1];

  assert.ok(filter.includes("adelay=0|0"), "ナレーションは遅延なし");
  assert.ok(filter.includes("adelay=3250|3250"), "SEは開始秒ぶん遅延する");
  assert.ok(filter.includes("amix=inputs=3:normalize=0"));
  assert.deepEqual(args.slice(-7), ["-ar", "48000", "-ac", "2", "-b:a", "192k", "out.mp3"]);
});

test("ミックスにリミッタを挟んでトゥルーピークの超過を防ぐ", () => {
  // amix は normalize=0 で総和するため、ナレーション+BGM+SEが重なった瞬間に
  // 0dBFS を超え得る。実測: ep011 の完成mp4は +0.2 dBFS(デジタルクリップ)。
  const filter = buildMixArgs(CUES, "out.mp3")[buildMixArgs(CUES, "out.mp3").indexOf("-filter_complex") + 1];

  assert.ok(filter.includes(`alimiter=limit=${LIMITER_CEILING_LINEAR}`), filter);
  assert.ok(filter.includes("level=disabled"), "自動レベル上げを止めないと音量が動く");
  assert.ok(filter.indexOf("amix") < filter.indexOf("alimiter"), "リミッタは総和の後ろ");
});

test("composition の <audio id=\"master\"> を master.mp3 へ差し替える", () => {
  const html =
    `<audio data-hf-id="x" id="master" src="episodes/ep001-x/narration/narration.wav" data-start="0" data-duration="12.5"></audio>\n` +
    `<audio id="other" src="assets/audio/keep.mp3"></audio>`;

  const out = patchMasterSrc(html, "episodes/ep001-x/narration/master.mp3");

  assert.ok(out.includes('id="master" src="episodes/ep001-x/narration/master.mp3"'));
  assert.ok(out.includes('id="other" src="assets/audio/keep.mp3"'), "他の<audio>は触らない");
  assert.ok(out.includes('data-duration="12.5"'), "他の属性は保つ");
});

test("差し替えは冪等(すでに master を指していれば何もしない)", () => {
  const html = `<audio id="master" src="episodes/ep001-x/narration/master.mp3"></audio>`;
  assert.equal(patchMasterSrc(html, "episodes/ep001-x/narration/master.mp3"), html);
});

test("master の <audio> が無ければ差し替えない(手書きcompositionを壊さない)", () => {
  const html = `<audio id="bgm" src="assets/audio/bed.mp3"></audio>`;
  assert.equal(patchMasterSrc(html, "episodes/ep001-x/narration/master.mp3"), html);
});
