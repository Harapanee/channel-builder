import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAudio, parseLegacyAudioTags, parseMasterAudio, type AudioFacts } from "./check-audio";
import { buildMixArgs, gainForLufs, type AudioCues } from "./audio-mix";

/** 正常な ep(ep012 修正後の実測値に合わせた) */
const OK: AudioFacts = {
  hasCues: true,
  hasMaster: true,
  audioSrc: "episodes/ep012-octopus/narration/master.mp3",
  audioDurationSec: 707.689,
  masterDurationSec: 707.689,
  masterFresherThanCues: true,
  p10WindowDb: -44.8,
  medianWindowDb: -19.4,
  peakDb: -1.8,
};

test("evaluateAudio: 正しく配線されていれば指摘なし", () => {
  assert.deepEqual(evaluateAudio(OK), []);
});

test("evaluateAudio: ep012 の事故そのもの(cues無し + src が narration.wav)を捕まえる", () => {
  const broken: AudioFacts = {
    ...OK,
    hasCues: false,
    hasMaster: false,
    audioSrc: "episodes/ep012-octopus/narration/narration.wav",
    masterDurationSec: NaN,
    p10WindowDb: NaN,
  };
  const codes = evaluateAudio(broken).map((f) => f.code);
  assert.ok(codes.includes("no_audio_cues"));
  assert.ok(codes.includes("no_master"));
  assert.ok(codes.includes("audio_src_not_master"));
});

test("evaluateAudio: ナレーション素のまま(BGM/SEなし)を no_bed で捕まえる", () => {
  // ep012 narration.wav の実測 p10 = -77.2dB
  const codes = evaluateAudio({ ...OK, p10WindowDb: -77.2 }).map((f) => f.code);
  assert.deepEqual(codes, ["no_bed"]);
});

test("evaluateAudio: 中央値では判定できない(ナレーション素でも -15dB 前後になる)", () => {
  // 指標を中央値に戻すとこの入力が緑になってしまう = ep012 の事故を見逃す
  assert.deepEqual(evaluateAudio({ ...OK, p10WindowDb: -77.2, medianWindowDb: -15.5 }).map((f) => f.code), [
    "no_bed",
  ]);
});

test("evaluateAudio: BGMを意図的に完全停止する区間があっても p10 なら誤爆しない", () => {
  // ep012 は cL160〜cL184 が完全無音(最小 -216dB)だが p10 は -44.8dB
  assert.deepEqual(evaluateAudio({ ...OK, p10WindowDb: -44.8 }), []);
});

test("evaluateAudio: cues を直して焼き直し忘れると master_stale", () => {
  const codes = evaluateAudio({ ...OK, masterFresherThanCues: false }).map((f) => f.code);
  assert.deepEqual(codes, ["master_stale"]);
});

test("evaluateAudio: 尺の食い違いを捕まえる(許容 0.5秒)", () => {
  assert.deepEqual(evaluateAudio({ ...OK, masterDurationSec: 707.9 }), []);
  assert.deepEqual(
    evaluateAudio({ ...OK, masterDurationSec: 700.0 }).map((f) => f.code),
    ["duration_mismatch"]
  );
});

test("evaluateAudio: <audio> が無ければそこで打ち切る", () => {
  const codes = evaluateAudio({ ...OK, audioSrc: null }).map((f) => f.code);
  assert.deepEqual(codes, ["no_audio_tag"]);
});

test("parseMasterAudio: src と data-duration を読む", () => {
  const html =
    '<audio data-hf-id="hf-qruz" id="master" src="episodes/ep012-octopus/narration/master.mp3" ' +
    'data-start="0" data-duration="707.689" data-track-index="10" data-volume="1"></audio>';
  assert.deepEqual(parseMasterAudio(html), {
    src: "episodes/ep012-octopus/narration/master.mp3",
    durationSec: 707.689,
  });
  assert.equal(parseMasterAudio("<div></div>"), null);
});

test("gainForLufs: 目標より大きい素材は絞り、小さい素材は 1.0 で頭打ち", () => {
  assert.equal(gainForLufs(-13.0), 0.355); // tsukkomi(実測)
  assert.equal(gainForLufs(-25.2), 1.0); // chin(実測・持ち上げは頭打ち)
  assert.equal(gainForLufs(-22), 1.0);
});

test("buildMixArgs: ナレーションを先頭に、全キューを amix でひとつに畳む", () => {
  const spec: AudioCues = {
    total: 10,
    narration: "ep/narration/narration.wav",
    bgm: [{ id: "b0", src: "bgm.mp3", start: 0, volume: 0.18, duration: 10, mediaStart: 2 }],
    se: [{ id: "s0", src: "se.mp3", start: 1.5, volume: 0.7 }],
  };
  const args = buildMixArgs(spec, "out.mp3");
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.ok(filter.includes("amix=inputs=3:normalize=0"), "ナレーション+BGM+SE の3入力");
  assert.ok(filter.includes("adelay=1500|1500"), "SE の開始位置がミリ秒で入る");
  assert.ok(filter.includes("volume=0.18"), "BGM の音量が入る");
  assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 6), [
    "-ss", "2", "-t", "10", "-i", "bgm.mp3",
  ]);
  assert.equal(args[args.length - 1], "out.mp3");
  assert.equal(args[args.indexOf("-t", args.indexOf("-map")) + 1], "10.000");
});

test("evaluateAudio: master のピークが天井を超えていたら焼き直させる", () => {
  // 実測: ep011 の完成mp4は +0.2 dBFS(デジタルクリップ)。ラウドネス(-14 LUFS)は
  // 基準内だったため、レンダー後QAは緑のまま通していた。
  const codes = evaluateAudio({ ...OK, peakDb: -0.2 }).map((f) => f.code);
  assert.deepEqual(codes, ["master_peak_hot"]);
});

test("evaluateAudio: ピークに余裕があれば指摘しない", () => {
  assert.deepEqual(evaluateAudio({ ...OK, peakDb: -1.3 }), []);
});

test("evaluateAudio: ミックス後に実装のSE台帳が変わったら焼き直しを要求する", () => {
  /* cues の mtime しか見ていなかったため、ミックス後に scene-implementer が
     SEを足す/時刻を動かすと**全部緑のまま**だった(SEが鳴らない・ずれる)。
     SEの正本は composition の __G<n>_SE_CUES なので、そこから直接突合する。 */
  const codes = evaluateAudio({ ...OK, seLedgerMatches: false }).map((f) => f.code);
  assert.deepEqual(codes, ["se_ledger_stale"]);
});

test("evaluateAudio: 台帳ハッシュを持たない古い cues では突合しない(後方互換)", () => {
  assert.deepEqual(evaluateAudio({ ...OK, seLedgerMatches: null }), []);
});

/*
 * 移行前エピソード(旧方式 = <audio> 直載せ)の検査。
 * プリミックス移行は「適用は次エピソードから」と決めたのに、ゲートは無条件に配線された。
 * 結果、旧方式で正しく音が鳴っている ep001(narration + BGM19 + SE15、実測 -14.7 LUFS)が
 * レンダー前に落ちた。ゲートを緩めるのではなく、旧方式でも判定できる不変条件
 * =「ナレーション以外の音源が配線されているか」を見る。ep012 の事故は
 * narration 1本だけの状態だったので、この条件で引き続き捕まる。
 * 黙って旧経路に落ちないよう episode.json の明示宣言を要件にする
 * (無警告フォールバックが ep012 の入口だったため)。
 */
const LEGACY: AudioFacts = {
  ...OK,
  scheme: "legacy-tags",
  hasCues: false,
  hasMaster: false,
  audioSrc: null,
  masterDurationSec: NaN,
  p10WindowDb: NaN,
  medianWindowDb: NaN,
  peakDb: NaN,
  legacyAudioIds: ["narration", "bgm-01", "se-don-1"],
  legacyMissingSrc: [],
};

test("evaluateAudio: 旧方式を宣言した ep は master 一式を要求しない", () => {
  assert.deepEqual(evaluateAudio(LEGACY), []);
});

test("evaluateAudio: 旧方式でもナレーション1本だけなら捕まえる(ep012 の事故形)", () => {
  const codes = evaluateAudio({ ...LEGACY, legacyAudioIds: ["narration"] }).map((f) => f.code);
  assert.deepEqual(codes, ["legacy_no_bed_tracks"]);
});

test("evaluateAudio: 旧方式で音源ファイルが欠けていたら捕まえる", () => {
  const codes = evaluateAudio({
    ...LEGACY,
    legacyMissingSrc: ["assets/audio/bgm/blue-eyed-birds.wav"],
  }).map((f) => f.code);
  assert.deepEqual(codes, ["legacy_missing_source"]);
});

test("parseLegacyAudioTags: id と src を全部読む", () => {
  const html = `
    <audio id="narration" src="episodes/ep001/narration/narration.wav" data-start="0" data-duration="10"></audio>
    <audio id="bgm-01" src="assets/audio/bgm/a.wav" data-start="0" data-duration="5"></audio>`;
  assert.deepEqual(parseLegacyAudioTags(html), [
    { id: "narration", src: "episodes/ep001/narration/narration.wav" },
    { id: "bgm-01", src: "assets/audio/bgm/a.wav" },
  ]);
});
