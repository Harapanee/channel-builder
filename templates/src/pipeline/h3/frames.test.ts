import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FPS, MAX_FRAMES, TRAINED_MIN_FRAMES, framesForSeconds, isBelowTrainedRange, secondsForFrames } from "./frames";

/** 変数経由にして TS の静的解決を切る(型を持たない .mjs を読むため) */
const CLI_MODULE = "../../../../tools/comfy-runpod/lib/workflow-minimax.mjs";

test("17k+5 のグリッドへ切り上げる", () => {
  assert.equal(framesForSeconds(5.167), 124); // 124 = 17*7 + 5
  assert.equal(framesForSeconds(5.0), 124); // 120 → 124 へ切り上げ
  assert.equal(framesForSeconds(15.083), 362); // 362 = 17*21 + 5
});

test("フレーム数から秒へ戻す", () => {
  assert.equal(secondsForFrames(124), 124 / FPS);
  assert.equal(FPS, 24);
});

test("学習レンジ下限の判定", () => {
  assert.equal(TRAINED_MIN_FRAMES, 124);
  assert.equal(isBelowTrainedRange(123), true);
  assert.equal(isBelowTrainedRange(124), false);
});

test("上限を超える尺は例外", () => {
  assert.equal(MAX_FRAMES, 362);
  assert.throws(() => framesForSeconds(16), /レンジ外/);
  assert.throws(() => framesForSeconds(0), /レンジ外/);
});

test("生成CLIと同じ丸めになる(0.05秒刻みで全数照合)", async (t) => {
  const abs = fileURLToPath(new URL(CLI_MODULE, import.meta.url));
  if (!existsSync(abs)) return t.skip("生成CLIが見つからないので照合を飛ばす");
  const mod = (await import(CLI_MODULE)) as { framesForSeconds: (s: number) => number };
  for (let s = 0.05; s <= 15.05; s += 0.05) {
    const sec = Math.round(s * 100) / 100;
    let mine: number | string;
    let theirs: number | string;
    try { mine = framesForSeconds(sec); } catch { mine = "throw"; }
    try { theirs = mod.framesForSeconds(sec); } catch { theirs = "throw"; }
    assert.equal(mine, theirs, `${sec}秒で不一致`);
  }
});
