import test from "node:test";
import assert from "node:assert/strict";
import { needsGpuLock } from "./pod";

// --- 課金ロックの対象 ---------------------------------------------------------
// 課金が始まるのは Pod 起動の瞬間である。止める側・見る側をロックすると
// 「止められない」事故になるので、ロックするのは起動系だけに限る。

test("up は課金ロックの対象", () => {
  assert.equal(needsGpuLock("up"), true);
});

test("wait-up も課金ロックの対象(在庫待ちからそのまま起動する)", () => {
  assert.equal(needsGpuLock("wait-up"), true);
});

test("down は課金を増やさないのでロックしない(止められないと事故になる)", () => {
  assert.equal(needsGpuLock("down"), false);
});

test("status / stock / ssh / tunnel はロックしない", () => {
  for (const sub of ["status", "stock", "ssh", "tunnel"]) {
    assert.equal(needsGpuLock(sub), false, sub);
  }
});

test("引数なし(pod.mjs の既定は status)はロックしない", () => {
  assert.equal(needsGpuLock(undefined), false);
});

test("未知のサブコマンドはロックしない(pod.mjs 側が使い方を出して終わる)", () => {
  assert.equal(needsGpuLock("upgrade"), false);
});
