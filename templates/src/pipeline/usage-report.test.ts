import assert from "node:assert/strict";
import test from "node:test";
import {
  accumulateUsage,
  agentLaunches,
  costOf,
  emptyUsage,
  overlapStats,
  priceKeyOf,
  activeSpanMs,
  subagentsDirFor,
  summarizeAgent,
  totalCostOf,
  transcriptDirFor,
  wallClockSpanMs,
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

test("同時発行は message.id でまとめる(記録は tool_use ごとに別行で書かれる)", () => {
  /* Claude Code の jsonl は1つのアシスタントメッセージを content ブロックごとに
     別行で書く。行単位で数えると**必ず「1メッセージ1本」**になり、
     並列起動できていても「全部が直列」と誤警告していた(ep013 は実際には6本同時)。 */
  const line = (id: string, toolId: string, desc: string, ts: string) => ({
    timestamp: ts,
    message: { id, content: [{ type: "tool_use", id: toolId, name: "Agent", input: { description: desc } }] },
  });
  const { launches, perMessage } = agentLaunches([
    line("msg_A", "t1", "G1", "2026-08-01T00:00:00.000Z"),
    line("msg_A", "t2", "G2", "2026-08-01T00:00:00.100Z"),
    line("msg_A", "t3", "G3", "2026-08-01T00:00:00.200Z"),
    line("msg_B", "t4", "G4", "2026-08-01T01:00:00.000Z"),
  ]);

  assert.deepEqual(perMessage, [3, 1], "3本同時発行 + 1本");
  assert.equal(launches.length, 4);
});

test("壁時計: 記録の最初から最後までの経過を返す", () => {
  const span = wallClockSpanMs([
    { timestamp: "2026-08-01T18:05:00.000Z" },
    { timestamp: "2026-08-01T21:40:00.000Z" },
    { timestamp: "2026-08-01T19:00:00.000Z" },
    { message: {} },
  ]);
  assert.equal(span / 3_600_000, 3.5833333333333335);
  assert.equal(wallClockSpanMs([]), 0);
});

test("実作業時間: 一定以上あいた区間(休止)は経過から除く", () => {
  const at = (h: number, m: number) => ({ timestamp: `2026-08-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z` });
  /* 18:00→18:30 作業 / 3時間半あく(休止)/ 22:00→22:30 作業 = 実作業1時間、全体4.5時間 */
  const entries = [at(18, 0), at(18, 30), at(22, 0), at(22, 30)];

  assert.equal(wallClockSpanMs(entries) / 3_600_000, 4.5);
  assert.equal(activeSpanMs(entries, 30 * 60_000) / 3_600_000, 1);
  /* 閾値を4時間にすれば休止も作業とみなす */
  assert.equal(activeSpanMs(entries, 4 * 3_600_000) / 3_600_000, 4.5);
});

test("サブエージェントの記録は <セッションID>/subagents/ にある", () => {
  assert.equal(
    subagentsDirFor("/p/-Users-x", "a22ca025-160a-4667-a6ba-b5762ad11365.jsonl"),
    "/p/-Users-x/a22ca025-160a-4667-a6ba-b5762ad11365/subagents"
  );
});

test("エージェント1本の要約: コスト・ターン数・ターン単価", () => {
  const turn = (out: number, cacheRead: number) => ({
    message: {
      model: "claude-opus-5",
      usage: { output_tokens: out, cache_read_input_tokens: cacheRead, input_tokens: 10 },
    },
  });
  const s = summarizeAgent("G5実装", [turn(1000, 100_000), turn(2000, 200_000), { message: {} }]);

  assert.equal(s.label, "G5実装");
  assert.equal(s.turns, 2);
  assert.equal(s.ctxMaxTokens, 200_010);
  /* 出力3000tok×$25 + cacheRead 300k×$0.5 + input 20×$5 = 0.075 + 0.15 + 0.0001 */
  assert.equal(s.costUsd.toFixed(4), "0.2251");
  assert.equal(s.costPerTurnUsd.toFixed(3), "0.113");
});

test("合計コストはモデル別の総和", () => {
  assert.equal(
    totalCostOf({
      "claude-opus-5": { ...emptyUsage(), output: 1_000_000 },
      "claude-haiku-4-5": { ...emptyUsage(), output: 1_000_000 },
    }),
    30
  );
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
