import assert from "node:assert/strict";
import test from "node:test";
import { resolveEpisodeArg } from "./use-episode";

const present = new Set([
  "episodes/ep013-worker-ant/composition.html",
  "shorts/sh011-cheetah-top3/composition.html",
]);
const exists = (p: string) => present.has(p);

test("epId だけでも episodes/ 配下を解決する", () => {
  assert.equal(resolveEpisodeArg("ep013-worker-ant", exists), "episodes/ep013-worker-ant");
  assert.equal(resolveEpisodeArg("episodes/ep013-worker-ant", exists), "episodes/ep013-worker-ant");
});

test("shorts/ も同じ書き方で解決する", () => {
  assert.equal(resolveEpisodeArg("sh011-cheetah-top3", exists), "shorts/sh011-cheetah-top3");
});

test("composition.html を持たない指定は止める(別のepを検査して緑を出さないため)", () => {
  assert.throws(() => resolveEpisodeArg("ep999-nope", exists), /見つかりません/);
});
