// node --test scripts/hooks/guard-gpu.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { blockReason } from "./guard-gpu.mjs";

const HOOK = fileURLToPath(new URL("./guard-gpu.mjs", import.meta.url));

test("pod.mjs up / wait-up の直叩きはブロック(課金ロックを通らない)", () => {
  for (const c of [
    "node pod.mjs up",
    "cd ../tools/comfy-runpod && node pod.mjs up --allow-others",
    "node /Users/x/youtube/tools/comfy-runpod/pod.mjs wait-up --interval 60",
    "./pod.mjs up",
    "H3_ALLOW_GPU=1 node pod.mjs up",
    "nohup node pod.mjs wait-up > log 2>&1 &",
    'bash -c "node pod.mjs up"',
  ]) assert.ok(blockReason(c), c);
});

test("batch.mjs の直叩きはブロック", () => {
  for (const c of [
    "node batch.mjs --jobs jobs.json --out ./out",
    "cd ../tools/comfy-runpod; node batch.mjs --jobs j.json",
    "node ../tools/comfy-runpod/batch.mjs --jobs j.json --url http://127.0.0.1:8188",
  ]) assert.ok(blockReason(c), c);
});

test("npm スクリプト経由は通す(課金ロックがかかる)", () => {
  for (const c of [
    "H3_ALLOW_GPU=1 npm run h3:pod -- up",
    "H3_ALLOW_GPU=1 npm run h3:pod -- wait-up",
    "H3_ALLOW_GPU=1 npm run h3:run -- ep045-giant-panda ch01 --url http://127.0.0.1:8188",
    "npm run h3:run -- ep045 ch01 --plan",
  ]) assert.equal(blockReason(c), null, c);
});

test("課金を増やさない操作は通す", () => {
  for (const c of [
    "node pod.mjs down",
    "node pod.mjs status",
    "node pod.mjs stock",
    "node pod.mjs heartbeat",
    "node pod.mjs",
    "node batch.mjs --jobs jobs.json --dry",
    "node --test __tests__/batch.test.mjs",
    "cat batch.mjs",
    "grep -n up pod.mjs",
    "git diff tools/comfy-runpod/pod.mjs",
  ]) assert.equal(blockReason(c), null, c);
});

test("区切りで繋いだ後段の直叩きも見る(前段の --dry で素通りさせない)", () => {
  assert.ok(blockReason("node batch.mjs --jobs j.json --dry && node batch.mjs --jobs j.json"));
  assert.ok(blockReason("node pod.mjs status; node pod.mjs up"));
});

test("heredoc の本文(文書の編集など)は実行されないので見ない", () => {
  const edit = "python3 - <<'EOF'\ns = '''\nnode pod.mjs up   # 起動\nnode batch.mjs --jobs j.json\n'''\nEOF\necho done";
  assert.equal(blockReason(edit), null);
  const edit2 = "cat > x.md <<EOF\nnode pod.mjs wait-up\nEOF";
  assert.equal(blockReason(edit2), null);
  // heredoc の後ろの実コマンドは見る
  assert.ok(blockReason("cat <<'X'\nhello\nX\nnode pod.mjs up"));
  // heredoc を bash に食わせるのは実行なので見る
  assert.ok(blockReason("bash <<'EOF'\nnode pod.mjs up\nEOF"));
});

function runHook(input) {
  return spawnSync(process.execPath, [HOOK], { input, encoding: "utf8" });
}

test("フック本体: ブロックは exit 2 + stderr", () => {
  const r = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "node pod.mjs up" } }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /h3:pod/);
});

test("フック本体: 通すものは exit 0", () => {
  const r = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "H3_ALLOW_GPU=1 npm run h3:pod -- up" } }));
  assert.equal(r.status, 0);
});

test("フック本体: 壊れた入力・command 無しは通す(フックの故障で作業を止めない)", () => {
  assert.equal(runHook("not json").status, 0);
  assert.equal(runHook(JSON.stringify({ tool_input: {} })).status, 0);
});
