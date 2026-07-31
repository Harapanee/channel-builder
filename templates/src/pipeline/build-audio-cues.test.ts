import assert from "node:assert/strict";
import test from "node:test";
import { buildSeCues, indexAudioFiles, parseSeLedgers, readTotalDuration } from "./build-audio-cues";

const HTML = `<html><body>
  <div id="root" data-composition-id="animal-ep012" data-start="0" data-duration="707.689"></div>
  <script>
    window.__G1_SE_CUES = [
      { clip: "cL01", t: 0.15, se: "pop-3-nyu" }, { clip: "cL04", t: 12.40, se: "don" }
    ];
    window.__G2_SE_CUES = [
      { clip: "cL70", t: 210.5, se: "chin" }
    ];
  </script>
</body></html>`;

test("SE台帳を全グループぶん読み、時刻順に並べる", () => {
  assert.deepEqual(parseSeLedgers(HTML), [
    { clip: "cL01", t: 0.15, se: "pop-3-nyu" },
    { clip: "cL04", t: 12.4, se: "don" },
    { clip: "cL70", t: 210.5, se: "chin" },
  ]);
});

test("台帳が無い composition では空を返す(誤ってSEを捏造しない)", () => {
  assert.deepEqual(parseSeLedgers("<html><body></body></html>"), []);
});

test("素材名から実ファイルを引く(拡張子は問わない)", () => {
  const index = indexAudioFiles(["assets/audio/se/don.mp3", "assets/audio/bgm/bed-quiet.mp3"]);
  assert.equal(index.get("don"), "assets/audio/se/don.mp3");
  assert.equal(index.get("bed-quiet"), "assets/audio/bgm/bed-quiet.mp3");
});

test("SEキューを組む(volumeは1.0固定 — 実音量は audio-mix が実測から決める)", () => {
  const index = indexAudioFiles(["assets/audio/se/don.mp3", "assets/audio/se/chin.mp3", "assets/audio/se/pop-3-nyu.mp3"]);
  const { cues, missing } = buildSeCues(parseSeLedgers(HTML), index);

  assert.equal(missing.length, 0);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues[0], { id: "se-cL01-0", src: "assets/audio/se/pop-3-nyu.mp3", start: 0.15, volume: 1.0 });
  assert.ok(cues.every((c) => c.volume === 1.0));
  assert.equal(new Set(cues.map((c) => c.id)).size, 3, "idは一意");
});

test("素材が見つからないSEは missing として返す(黙って落とさない)", () => {
  const { cues, missing } = buildSeCues(parseSeLedgers(HTML), indexAudioFiles(["assets/audio/se/don.mp3"]));
  assert.deepEqual(missing, ["pop-3-nyu", "chin"]);
  assert.equal(cues.length, 1);
});

test("総尺は composition のルート要素から読む", () => {
  assert.equal(readTotalDuration(HTML), 707.689);
});
