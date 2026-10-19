import test from "node:test";
import assert from "node:assert/strict";
import { needsGpuLock, podEnv } from "./pod";

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

// --- GPU ロックの値の厳密さ(B3) -------------------------------------------------
// 「何か入っていれば通す」だと H3_ALLOW_GPU=0 や =false でも課金が始まる。
import { gpuAllowed } from "./config";

test("H3_ALLOW_GPU は '1' の完全一致だけ通す", () => {
  assert.equal(gpuAllowed({ H3_ALLOW_GPU: "1" }), true);
});

test("0 / false / 空 / 空白つき / 未設定は通さない", () => {
  for (const v of ["0", "false", "", " 1", "1 ", "true", "yes", "11"]) {
    assert.equal(gpuAllowed({ H3_ALLOW_GPU: v }), false, JSON.stringify(v));
  }
  assert.equal(gpuAllowed({}), false);
});

// --- 席(2026-10-17: down が同じ Volume の別チャンネルの Pod を止めた)-----------
test("podEnv: POD_OWNER も POD_SEAT も無ければ channelId を席にする", () => {
  assert.equal(podEnv({}, "animal-isekai-hell").POD_SEAT, "animal-isekai-hell");
});
test("podEnv: POD_OWNER(相乗り)のときは席を付けない", () => {
  assert.equal(podEnv({ POD_OWNER: "a" }, "x").POD_SEAT, undefined);
});
test("podEnv: 明示の POD_SEAT は上書きしない", () => {
  assert.equal(podEnv({ POD_SEAT: "y" }, "x").POD_SEAT, "y");
});
