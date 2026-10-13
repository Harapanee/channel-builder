import assert from "node:assert/strict";
import test from "node:test";
import { buildFinalArgs, buildPlacementArgs, mp3KbpsFor } from "./en-mix-args";

test("行の配置: 各行を開始秒ぶん遅らせて総和し、総尺で切る", () => {
  const a = buildPlacementArgs([{ file: "L01.wav", startSec: 0 }, { file: "L02.wav", startSec: 4.144 }], 20, "n.wav");
  const f = a[a.indexOf("-filter_complex") + 1];
  assert.ok(f.includes("adelay=0|0"));
  assert.ok(f.includes("adelay=4144|4144"));
  assert.ok(f.includes("amix=inputs=2:normalize=0"));
  assert.ok(f.includes("loudnorm=I="), "英語の声を日本語の声の大きさへ揃える");
  assert.deepEqual(a.slice(a.indexOf("-t"), a.indexOf("-t") + 2), ["-t", "20.000"]);
  assert.equal(a.at(-1), "n.wav");
});

test("最終: 環境音があれば master の下へ normalize=0 で敷く(assemble と同じ)", () => {
  const a = buildFinalArgs("m.wav", "amb.wav", 740.857, "o.wav");
  const f = a[a.indexOf("-filter_complex") + 1];
  assert.ok(f.startsWith("[0:a][1:a]amix=inputs=2:duration=first:normalize=0"));
  assert.ok(f.includes("apad"), "短ければ無音で延ばす");
  assert.deepEqual(a.slice(a.indexOf("-t"), a.indexOf("-t") + 2), ["-t", "740.857"]);
  assert.ok(a.includes("pcm_s16le"));
});

test("最終: 環境音が無ければ master だけを尺に合わせる", () => {
  const a = buildFinalArgs("m.wav", null, 12.5, "o.wav");
  assert.equal(a.filter((x) => x === "-i").length, 1);
  assert.ok(!a.join(" ").includes("amix"));
});

test("Studio 用 MP3 のビットレート: 9.5MB に収まる MP3 の有効値(切り下げ)・96k で頭打ち", () => {
  // libmp3lame は有効値以外を切り上げる(74k 指定 → 80k になり ep042 が 10.24MB で 10MB 上限を超えた)
  assert.equal(mp3KbpsFor(740.857), 96);
  assert.equal(mp3KbpsFor(877.666), 80); // 上限 86.6 → 80
  assert.equal(mp3KbpsFor(1024.18), 64); // 上限 74.2 → 64(ep042)
  assert.equal(mp3KbpsFor(1277.593), 56); // 上限 59.5 → 56(ep016)
  assert.equal(mp3KbpsFor(1500), 48); // 上限 50.6 → 48
});
