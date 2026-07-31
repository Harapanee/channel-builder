import assert from "node:assert/strict";
import test from "node:test";
import {
  accumulateUsage,
  agentLaunches,
  costOf,
  emptyUsage,
  overlapStats,
  priceKeyOf,
  transcriptDirFor,
} from "./usage-report";

test("モデルIDから単価表を引く(未知は最上位モデル相当で見積もる)", () => {
  assert.equal(priceKeyOf("claude-opus-5[1m]"), "opus");
  assert.equal(priceKeyOf("claude-sonnet-5"), "sonnet");
  assert.equal(priceKeyOf("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(priceKeyOf("unknown-model"), "opus");
});

test("費用: cache write は 5分TTL=1.25倍・1時間TTL=2倍、cache read は 0.1倍", () => {
  const u = { ...emptyUsage(), cacheWrite5m: 1_000_000 };
  assert.equal(costOf("claude-opus-5", u).toFixed(2), "6.25");

  const u1h = { ...emptyUsage(), cacheWrite1h: 1_000_000 };
  assert.equal(costOf("claude-opus-5", u1h).toFixed(2), "10.00");

  const ur = { ...emptyUsage(), cacheRead: 1_000_000 };
  assert.equal(costOf("claude-opus-5", ur).toFixed(2), "0.50");

  const uo = { ...emptyUsage(), output: 1_000_000 };
  assert.equal(costOf("claude-opus-5", uo).toFixed(2), "25.00");
});

test("usage をモデル別に足し上げる(5m/1h の内訳つき)", () => {
  const totals = accumulateUsage([
    {
      message: {
        model: "claude-opus-5",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 300,
          cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
        },
      },
    },
    { message: { model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 2 } } },
    { message: { content: [] } },
  ]);

  assert.deepEqual(totals["claude-opus-5"], {
    input: 101,
    output: 22,
    cacheWrite5m: 100,
    cacheWrite1h: 200,
    cacheRead: 5000,
  });
});

test("内訳が無い記録では cache_creation_input_tokens を 5分TTL 扱いにする", () => {
  const totals = accumulateUsage([
    { message: { model: "m", usage: { cache_creation_input_tokens: 500 } } },
  ]);
  assert.equal(totals["m"].cacheWrite5m, 500);
  assert.equal(totals["m"].cacheWrite1h, 0);
});

test("1メッセージに並べたAgent数を数える(直列起動の検出)", () => {
  const { launches, perMessage } = agentLaunches([
    {
      timestamp: "2026-08-01T00:00:00.000Z",
      message: {
        content: [
          { type: "tool_use", id: "a1", name: "Agent", input: { description: "G1" } },
          { type: "tool_use", id: "a2", name: "Agent", input: { description: "G2" } },
        ],
      },
    },
    {
      timestamp: "2026-08-01T00:10:00.000Z",
      message: { content: [{ type: "tool_use", id: "a3", name: "Task", input: { description: "G3" } }] },
    },
  ]);

  assert.deepEqual(perMessage, [2, 1]);
  assert.deepEqual(launches.map((l) => l.label), ["G1", "G2", "G3"]);
});

test("並列度: 重なりの最大本数と 総和/経過 を出す", () => {
  const entries = [
    {
      timestamp: "2026-08-01T00:00:00.000Z",
      message: {
        content: [
          { type: "tool_use", id: "a1", name: "Agent", input: { description: "G1" } },
          { type: "tool_use", id: "a2", name: "Agent", input: { description: "G2" } },
        ],
      },
    },
    {
      timestamp: "2026-08-01T00:10:00.000Z",
      message: { content: [{ type: "tool_result", tool_use_id: "a1" }] },
    },
    {
      timestamp: "2026-08-01T00:20:00.000Z",
      message: { content: [{ type: "tool_result", tool_use_id: "a2" }] },
    },
  ];
  const { launches } = agentLaunches(entries);
  const stats = overlapStats(launches);

  assert.equal(stats.maxConcurrent, 2);
  assert.equal(stats.serialMs / 60000, 30, "所要の総和は10分+20分");
  assert.equal(stats.spanMs / 60000, 20, "実際の経過は20分(並列なので総和より短い)");
});

test("直列に回した場合は 総和 ≒ 経過 になる", () => {
  const entries = [
    { timestamp: "2026-08-01T00:00:00.000Z", message: { content: [{ type: "tool_use", id: "a1", name: "Agent", input: {} }] } },
    { timestamp: "2026-08-01T00:10:00.000Z", message: { content: [{ type: "tool_result", tool_use_id: "a1" }] } },
    { timestamp: "2026-08-01T00:10:00.000Z", message: { content: [{ type: "tool_use", id: "a2", name: "Agent", input: {} }] } },
    { timestamp: "2026-08-01T00:30:00.000Z", message: { content: [{ type: "tool_result", tool_use_id: "a2" }] } },
  ];
  const stats = overlapStats(agentLaunches(entries).launches);

  assert.equal(stats.maxConcurrent, 1);
  assert.equal(stats.serialMs, stats.spanMs);
});

test("記録ディレクトリ名は絶対パスの非英数字を - に置き換えたもの", () => {
  assert.match(
    transcriptDirFor("/Users/x/Desktop/ClaudeCode/youtube/動物転生"),
    /\.claude\/projects\/-Users-x-Desktop-ClaudeCode-youtube-----$/
  );
});
