/**
 * セッション記録(~/.claude/projects/<slug>/*.jsonl)からトークン・コスト・並列度を集計する。
 *
 * なぜツールにするか:
 *   2026-08-01 の2回の是正(直列起動の発見・snapshot待ちによるキャッシュ失効の発見)は、
 *   どちらも**手作業でjsonlを集計して**初めて見えた。測るたびに手で書くのでは次の是正が高くつく。
 *   加えて「並列で起動する」という規約は SKILL.md に書いてあっても守られなかった実績がある
 *   (ep012: 素材7本+実装3本の全10本が1メッセージ1呼び出し)。**規約は測れないと守られない**ので、
 *   遵守を機械が数えられるようにする。
 *
 * 使い方:
 *   npm run usage                      # このチャンネルの全セッション
 *   npm run usage -- --since 2026-07-30
 *   npm run usage -- --session <sessionId>
 *   npm run usage -- --json            # 機械可読(metricsへの記録用)
 *
 * exit: 0 = OK / 2 = 実行エラー
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * 100万トークンあたりの単価(USD)。2026-08-01 時点の ep012 コスト分解で使った値。
 * キャッシュ書き込みは 5分TTL=1.25倍 / 1時間TTL=2倍、キャッシュ読み出しは 0.1倍。
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
  fable: { input: 5, output: 25 },
};

export type Usage = {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
};

export type ModelTotals = Record<string, Usage>;

export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
});

/** モデルIDから単価表のキーを引く(未知のモデルは opus 相当として扱い、その旨を出す) */
export function priceKeyOf(model: string): string {
  return Object.keys(PRICES).find((k) => model.includes(k)) ?? "opus";
}

/** 1モデルぶんの費用(USD) */
export function costOf(model: string, u: Usage): number {
  const p = PRICES[priceKeyOf(model)];
  return (
    (u.input * p.input +
      u.cacheWrite5m * p.input * 1.25 +
      u.cacheWrite1h * p.input * 2 +
      u.cacheRead * p.input * 0.1 +
      u.output * p.output) /
    1_000_000
  );
}

type Entry = {
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    model?: string;
    usage?: Record<string, unknown>;
    content?: Array<Record<string, unknown>>;
  };
};

/** assistantメッセージの usage をモデル別に足し上げる */
export function accumulateUsage(entries: Entry[]): ModelTotals {
  const totals: ModelTotals = {};
  for (const e of entries) {
    const u = e.message?.usage;
    if (!u) continue;
    const model = e.message?.model ?? "unknown";
    const t = (totals[model] ??= emptyUsage());
    const creation = (u.cache_creation ?? {}) as Record<string, number>;
    t.input += Number(u.input_tokens ?? 0);
    t.output += Number(u.output_tokens ?? 0);
    t.cacheRead += Number(u.cache_read_input_tokens ?? 0);
    /* 内訳(5m/1h)が取れないバージョンでは 5m 扱いにする(従来の単価計算と同じ) */
    const w5 = Number(creation.ephemeral_5m_input_tokens ?? 0);
    const w1 = Number(creation.ephemeral_1h_input_tokens ?? 0);
    const total = Number(u.cache_creation_input_tokens ?? 0);
    t.cacheWrite5m += w5 + w1 === 0 ? total : w5;
    t.cacheWrite1h += w1;
  }
  return totals;
}

export type AgentLaunch = { id: string; label: string; startedAt: number; endedAt: number | null };

/**
 * サブエージェント(Agent/Task tool_use)の起動を数える。
 * `perMessage` は「1メッセージ内に何本並べたか」の分布 — **これが並列起動の実行形そのもの**。
 * 1本ずつのメッセージが並ぶのは直列であり、SKILL.md が禁じている形。
 */
export function agentLaunches(entries: Entry[]): {
  launches: AgentLaunch[];
  perMessage: number[];
} {
  const launches: AgentLaunch[] = [];
  const perMessage: number[] = [];
  const endById = new Map<string, number>();

  for (const e of entries) {
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
    let inThisMessage = 0;
    for (const c of content) {
      if (c.type === "tool_use" && (c.name === "Agent" || c.name === "Task")) {
        inThisMessage++;
        const input = (c.input ?? {}) as Record<string, string>;
        launches.push({
          id: String(c.id),
          label: input.description ?? input.subagent_type ?? "agent",
          startedAt: ts,
          endedAt: null,
        });
      }
      if (c.type === "tool_result" && typeof c.tool_use_id === "string" && Number.isFinite(ts)) {
        endById.set(c.tool_use_id, ts);
      }
    }
    if (inThisMessage > 0) perMessage.push(inThisMessage);
  }
  for (const l of launches) l.endedAt = endById.get(l.id) ?? null;
  return { launches, perMessage };
}

/**
 * 起動区間から「実際に並列だったか」を測る。
 * serialMs = 各エージェントの所要時間の総和 / spanMs = 最初の起動から最後の完了まで。
 * 完全直列なら serial ≈ span、真に並列なら span は最長の1本に近づく。
 */
export function overlapStats(launches: AgentLaunch[]): {
  maxConcurrent: number;
  serialMs: number;
  spanMs: number;
} {
  const done = launches.filter((l) => Number.isFinite(l.startedAt) && l.endedAt !== null) as Array<
    AgentLaunch & { endedAt: number }
  >;
  if (done.length === 0) return { maxConcurrent: 0, serialMs: 0, spanMs: 0 };

  const events = done
    .flatMap((l) => [
      { t: l.startedAt, d: 1 },
      { t: l.endedAt, d: -1 },
    ])
    /* 同時刻は終了を先に処理する(終わって始まったものを同時と数えない) */
    .sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0;
  let maxConcurrent = 0;
  for (const ev of events) {
    cur += ev.d;
    if (cur > maxConcurrent) maxConcurrent = cur;
  }
  const serialMs = done.reduce((s, l) => s + (l.endedAt - l.startedAt), 0);
  const spanMs = Math.max(...done.map((l) => l.endedAt)) - Math.min(...done.map((l) => l.startedAt));
  return { maxConcurrent, serialMs, spanMs };
}

/* ----------------------------- 以下 CLI(I/O) ----------------------------- */

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

/** Claude Code はプロジェクトの絶対パスの非英数字を "-" に置き換えて記録ディレクトリ名にする */
export function transcriptDirFor(cwd: string): string {
  return path.join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

const fmtTok = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : `${Math.round(n / 1000)}k`;

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = flag("dir") ?? transcriptDirFor(process.cwd());
  if (!existsSync(dir)) fail(`セッション記録が見つかりません: ${dir}`);

  const since = flag("since") ? Date.parse(flag("since")!) : null;
  const session = flag("session");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .filter((f) => !session || f.startsWith(session))
    .map((f) => path.join(dir, f))
    .filter((f) => (since === null ? true : statSync(f).mtimeMs >= since));
  if (files.length === 0) fail("対象のセッション記録がありません(--since / --session の指定を確認)");

  /* セッション単位で読む。並列度(総和/経過)はセッションを跨いで足すと無意味になる
     — 別々の日に走った2本を「重なっていない」と数えてしまうため */
  const bySession: { name: string; entries: Entry[] }[] = [];
  for (const f of files) {
    const rows: Entry[] = [];
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as Entry;
        if (since !== null && e.timestamp && Date.parse(e.timestamp) < since) continue;
        rows.push(e);
      } catch {
        /* 壊れた行は無視する(記録は追記式で、末尾が途中の場合がある) */
      }
    }
    if (rows.length > 0) bySession.push({ name: path.basename(f, ".jsonl"), entries: rows });
  }
  const entries = bySession.flatMap((s) => s.entries);

  const totals = Object.fromEntries(
    Object.entries(accumulateUsage(entries)).filter(
      ([, u]) => u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h > 0
    )
  );
  const { launches, perMessage } = agentLaunches(entries);
  const sessionStats = bySession
    .map((s) => {
      const a = agentLaunches(s.entries);
      return { name: s.name, ...overlapStats(a.launches), launched: a.launches.length, perMessage: a.perMessage };
    })
    .filter((s) => s.launched > 0);
  const overlap = {
    maxConcurrent: Math.max(0, ...sessionStats.map((s) => s.maxConcurrent)),
    serialMs: sessionStats.reduce((s, x) => s + x.serialMs, 0),
    spanMs: sessionStats.reduce((s, x) => s + x.spanMs, 0),
  };
  const totalCost = Object.entries(totals).reduce((s, [m, u]) => s + costOf(m, u), 0);
  const serialLaunches = perMessage.filter((n) => n === 1).length;

  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          files: files.length,
          costUsd: Number(totalCost.toFixed(2)),
          models: totals,
          agents: {
            launched: launches.length,
            messagesWithLaunches: perMessage.length,
            singleLaunchMessages: serialLaunches,
            maxConcurrent: overlap.maxConcurrent,
            serialMinutes: Number((overlap.serialMs / 60000).toFixed(1)),
            spanMinutes: Number((overlap.spanMs / 60000).toFixed(1)),
          },
        },
        null,
        1
      )
    );
    return;
  }

  console.log(`セッション記録: ${files.length}ファイル / ${entries.length}行  (${dir})`);
  console.log("");
  for (const [model, u] of Object.entries(totals).sort((a, b) => costOf(b[0], b[1]) - costOf(a[0], a[1]))) {
    console.log(
      `  ${model.padEnd(24)} $${costOf(model, u).toFixed(2).padStart(8)}  ` +
        `出力 ${fmtTok(u.output)} / cache write ${fmtTok(u.cacheWrite5m + u.cacheWrite1h)}` +
        `(5m ${fmtTok(u.cacheWrite5m)} / 1h ${fmtTok(u.cacheWrite1h)}) / cache read ${fmtTok(u.cacheRead)}`
    );
  }
  console.log(`  ${"合計".padEnd(24)} $${totalCost.toFixed(2).padStart(8)}`);
  console.log("");
  console.log("サブエージェントの起動(並列の実行形):");
  console.log(`  起動 ${launches.length}本 / 起動を含むメッセージ ${perMessage.length}件`);
  console.log(
    `  うち「1メッセージ1本」= ${serialLaunches}件` +
      (perMessage.length > 0 && serialLaunches === perMessage.length
        ? "  ← 全部が直列。SKILL.md の並列起動が守られていません"
        : "")
  );
  console.log(`  同時に走った最大本数: ${overlap.maxConcurrent}`);
  console.log(
    `  所要の総和 ${(overlap.serialMs / 60000).toFixed(0)}分 / 起動〜完了の経過 ${(overlap.spanMs / 60000).toFixed(0)}分` +
      (overlap.spanMs > 0 ? `(並列度 ${(overlap.serialMs / overlap.spanMs).toFixed(2)}倍。1.0以下=重なりなし)` : "")
  );
  for (const s of sessionStats.sort((a, b) => b.serialMs - a.serialMs).slice(0, 5)) {
    const par = s.spanMs > 0 ? (s.serialMs / s.spanMs).toFixed(2) : "-";
    console.log(
      `    ${s.name.slice(0, 8)}  起動${String(s.launched).padStart(3)}本 / 同時最大 ${s.maxConcurrent} / ` +
        `総和 ${(s.serialMs / 60000).toFixed(0)}分 → 経過 ${(s.spanMs / 60000).toFixed(0)}分(並列度 ${par}倍)`
    );
  }
}

/* テストから import したときは走らせない */
if (process.argv[1] && path.basename(process.argv[1]) === "usage-report.ts") main();
