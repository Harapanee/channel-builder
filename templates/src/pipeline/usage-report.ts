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
 *   npm run usage -- --since 2026-07-31T17:55Z --until 2026-07-31T22:00Z # 1本ぶんの窓で締める
 *     ※記録のタイムスタンプはUTC。時刻まで指定するときは末尾に Z を付ける
 *       (付けないとローカル時刻として解釈され、JSTなら9時間ぶんずれる)
 *   npm run usage -- --session <sessionId>
 *   npm run usage -- --json            # 機械可読(metricsへの記録用。finalize が読む)
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

/**
 * サブエージェント1ターンあたりのコストの実測目安(USD)。
 *
 * ep013 のシーン実装6本の実測は $0.138〜$0.172/ターンで、**担当clip数とは相関せず
 * ターン数にほぼ比例**した(57ターン$8.1 / 103ターン$14.2 / 157ターン$27.0)。
 * 毎ターン持ち回る固定分(システム+参照物)が累積分より大きいため、
 * コストは「グループの割り方」ではなく「総ターン数」で決まる。
 */
export const TURN_COST_BENCHMARK_USD = 0.15;
/**
 * サブエージェント1本のターン予算。超過は品質ではなく**進め方**の問題を示す
 * (ep013 実測: 同程度のclip数で 54ターンの本と 157ターンの本が同居していた)。
 */
export const TURN_BUDGET = 80;

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
    /** アシスタントメッセージのID。1メッセージが content ブロックごとに複数行へ分かれる */
    id?: string;
    model?: string;
    usage?: Record<string, unknown>;
    content?: Array<Record<string, unknown>>;
  };
};

/** モデル別の総和から合計コスト(USD)を出す */
export function totalCostOf(totals: ModelTotals): number {
  return Object.entries(totals).reduce((s, [m, u]) => s + costOf(m, u), 0);
}

/** 記録の最初から最後までの経過(ms)。制作の壁時計はこれで機械計測する */
export function wallClockSpanMs(entries: Entry[]): number {
  const ts = entries.map((e) => (e.timestamp ? Date.parse(e.timestamp) : NaN)).filter(Number.isFinite);
  if (ts.length === 0) return 0;
  return Math.max(...ts) - Math.min(...ts);
}

/** これ以上あいた区間は「作業していない」とみなす既定の閾値(ms) */
export const IDLE_GAP_MS = 30 * 60_000;

/**
 * 実作業時間(ms)。連続する記録の間隔のうち、閾値以下のものだけを足す。
 *
 * 単純な最初→最後の差だと、夜間レンダー待ちや翌日への持ち越しがそのまま
 * 制作時間として記録されてしまう(metrics の wallClockHours が実態より
 * 大きく出ていた原因)。工程の実所要はこちらで測る。
 */
export function activeSpanMs(entries: Entry[], idleGapMs: number = IDLE_GAP_MS): number {
  const ts = entries
    .map((e) => (e.timestamp ? Date.parse(e.timestamp) : NaN))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    if (gap <= idleGapMs) total += gap;
  }
  return total;
}

export type AgentSummary = {
  label: string;
  costUsd: number;
  turns: number;
  /** そのエージェントが1ターンで抱えた最大コンテキスト(tok) */
  ctxMaxTokens: number;
  /** ターン単価。コストはターン数にほぼ線形なので、これが実装規定の指標になる */
  costPerTurnUsd: number;
};

/**
 * サブエージェント1本ぶんの要約。
 *
 * ターン単価を出すのは、ep013 の実測でコストが**ターン数に線形**だったため
 * (6本の実装エージェントで $0.138〜$0.172/ターン、clip数とは相関しなかった)。
 * 「1体のコストはターン数の2乗」という当初の想定は、毎ターン持ち回る固定分
 * (システム+参照物)が累積分より大きいため成立していない。
 */
export function summarizeAgent(label: string, entries: Entry[]): AgentSummary {
  const totals = accumulateUsage(entries);
  const costUsd = totalCostOf(totals);
  let turns = 0;
  let ctxMaxTokens = 0;
  for (const e of entries) {
    const u = e.message?.usage;
    if (!u) continue;
    turns++;
    const ctx =
      Number(u.input_tokens ?? 0) +
      Number(u.cache_read_input_tokens ?? 0) +
      Number(u.cache_creation_input_tokens ?? 0);
    if (ctx > ctxMaxTokens) ctxMaxTokens = ctx;
  }
  return { label, costUsd, turns, ctxMaxTokens, costPerTurnUsd: turns > 0 ? costUsd / turns : 0 };
}

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
 *
 * ★2026-08-02 修正: 記録は1つのアシスタントメッセージを **content ブロックごとに別行**で
 * 書くため、行単位で数えると `perMessage` が必ず 1 になり、**並列起動できていても
 * 「全部が直列」と誤警告**していた(ep013 は実際には6本・4本・5本の同時発行で、
 * 同じ集計の `maxConcurrent: 6` と矛盾していた)。同一メッセージは `message.id` でまとめる。
 * `message.id` を持たない記録(古い形式・テストの合成データ)は従来どおり行単位で数える。
 */
export function agentLaunches(entries: Entry[]): {
  launches: AgentLaunch[];
  perMessage: number[];
} {
  const launches: AgentLaunch[] = [];
  const endById = new Map<string, number>();
  /** メッセージID → そのメッセージで起動した本数(挿入順を保つ) */
  const byMessage = new Map<string, number>();

  entries.forEach((e, i) => {
    const content = e.message?.content;
    if (!Array.isArray(content)) return;
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
    const key = e.message?.id ?? `#line-${i}`;
    for (const c of content) {
      if (c.type === "tool_use" && (c.name === "Agent" || c.name === "Task")) {
        const input = (c.input ?? {}) as Record<string, string>;
        launches.push({
          id: String(c.id),
          label: input.description ?? input.subagent_type ?? "agent",
          startedAt: ts,
          endedAt: null,
        });
        byMessage.set(key, (byMessage.get(key) ?? 0) + 1);
      }
      if (c.type === "tool_result" && typeof c.tool_use_id === "string" && Number.isFinite(ts)) {
        endById.set(c.tool_use_id, ts);
      }
    }
  });
  for (const l of launches) l.endedAt = endById.get(l.id) ?? null;
  return { launches, perMessage: [...byMessage.values()] };
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

/**
 * サブエージェントの記録が置かれるディレクトリ。
 *
 * ★2026-08-02 追加: 初版はトップレベルの `*.jsonl` だけを集計しており、
 * **サブエージェントのコストを1本も数えていなかった**。工程の実働はすべて
 * サブエージェントに委譲されている(SKILL.md の運用原則)ので、これは制作コストの
 * 本体が丸ごと欠落していたことを意味する。実測: ep013 前後の期間で
 * 報告 $285 に対し実際は $419(-45%)、うちサブエージェントが $138。
 */
export function subagentsDirFor(dir: string, sessionFile: string): string {
  return path.join(dir, sessionFile.replace(/\.jsonl$/, ""), "subagents");
}

const fmtTok = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : `${Math.round(n / 1000)}k`;

export type CollectOptions = {
  dir: string;
  /** 制作の窓(ms epoch)。until を切らないと後続の別作業まで同じエピソードに計上される */
  since?: number | null;
  until?: number | null;
  session?: string;
};

export type UsageReport = {
  files: number;
  costUsd: number;
  mainCostUsd: number;
  subagentCostUsd: number;
  /** 休止(30分以上の空き)を除いた実所要 */
  activeHours: number;
  wallClockHours: number;
  models: ModelTotals;
  agentSummaries: AgentSummary[];
  launches: AgentLaunch[];
  perMessage: number[];
  overlap: { maxConcurrent: number; serialMs: number; spanMs: number };
  sessionStats: Array<{
    name: string;
    launched: number;
    maxConcurrent: number;
    serialMs: number;
    spanMs: number;
  }>;
};

/**
 * セッション記録(メイン + サブエージェント)を集計する。
 * finalize-episode がそのまま metrics へ書けるよう、表示から独立させてある。
 */
export function collectUsage(opts: CollectOptions): UsageReport {
  const { dir } = opts;
  const since = opts.since ?? null;
  const until = opts.until ?? null;
  const session = opts.session;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .filter((f) => !session || f.startsWith(session))
    .map((f) => path.join(dir, f))
    .filter((f) => (since === null ? true : statSync(f).mtimeMs >= since));
  if (files.length === 0) {
    throw new Error("対象のセッション記録がありません(--since / --session の指定を確認)");
  }

  const readEntries = (file: string): Entry[] => {
    const rows: Entry[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as Entry;
        const t = e.timestamp ? Date.parse(e.timestamp) : null;
        if (t !== null && since !== null && t < since) continue;
        if (t !== null && until !== null && t > until) continue;
        rows.push(e);
      } catch {
        /* 壊れた行は無視する(記録は追記式で、末尾が途中の場合がある) */
      }
    }
    return rows;
  };

  /* セッション単位で読む。並列度(総和/経過)はセッションを跨いで足すと無意味になる
     — 別々の日に走った2本を「重なっていない」と数えてしまうため */
  const bySession: { name: string; entries: Entry[]; agents: { label: string; entries: Entry[] }[] }[] = [];
  for (const f of files) {
    const rows = readEntries(f);
    /* サブエージェントの記録は <セッションID>/subagents/agent-*.jsonl に別ファイルで置かれる。
       ここを読まないと制作コストの本体(実測でepisode費用の6割)が欠落する */
    const agents: { label: string; entries: Entry[] }[] = [];
    const subDir = subagentsDirFor(dir, path.basename(f));
    if (existsSync(subDir)) {
      for (const af of readdirSync(subDir).filter((x) => x.endsWith(".jsonl")).sort()) {
        const entries = readEntries(path.join(subDir, af));
        if (entries.length === 0) continue;
        let label = af.replace(/^agent-|\.jsonl$/g, "").slice(0, 10);
        try {
          const meta = JSON.parse(readFileSync(path.join(subDir, af.replace(/\.jsonl$/, ".meta.json")), "utf8"));
          label = meta.description ?? meta.subagentType ?? label;
        } catch {
          /* meta が無い記録もある。ファイル名を label にして続行する */
        }
        agents.push({ label, entries });
      }
    }
    if (rows.length > 0 || agents.length > 0) {
      bySession.push({ name: path.basename(f, ".jsonl"), entries: rows, agents });
    }
  }
  const mainEntries = bySession.flatMap((s) => s.entries);
  const agentEntries = bySession.flatMap((s) => s.agents.flatMap((a) => a.entries));
  const entries = [...mainEntries, ...agentEntries];

  const totals = Object.fromEntries(
    Object.entries(accumulateUsage(entries)).filter(
      ([, u]) => u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h > 0
    )
  );
  const mainCost = totalCostOf(accumulateUsage(mainEntries));
  const agentSummaries = bySession
    .flatMap((s) => s.agents.map((a) => summarizeAgent(a.label, a.entries)))
    .sort((a, b) => b.costUsd - a.costUsd);
  const agentCost = agentSummaries.reduce((s, a) => s + a.costUsd, 0);
  const wallClockMs = wallClockSpanMs(entries);
  const activeMs = activeSpanMs(entries);
  const { launches, perMessage } = agentLaunches(mainEntries);
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
  return {
    files: files.length,
    costUsd: Number(totalCostOf(totals).toFixed(2)),
    mainCostUsd: Number(mainCost.toFixed(2)),
    subagentCostUsd: Number(agentCost.toFixed(2)),
    activeHours: Number((activeMs / 3_600_000).toFixed(2)),
    wallClockHours: Number((wallClockMs / 3_600_000).toFixed(2)),
    models: totals,
    agentSummaries,
    launches,
    perMessage,
    overlap,
    sessionStats,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = flag("dir") ?? transcriptDirFor(process.cwd());
  if (!existsSync(dir)) fail(`セッション記録が見つかりません: ${dir}`);

  let report: UsageReport;
  try {
    report = collectUsage({
      dir,
      since: flag("since") ? Date.parse(flag("since")!) : null,
      until: flag("until") ? Date.parse(flag("until")!) : null,
      session: flag("session"),
    });
  } catch (e) {
    fail((e as Error).message);
  }
  const {
    files,
    models: totals,
    agentSummaries,
    launches,
    perMessage,
    overlap,
    sessionStats,
    activeHours,
    wallClockHours,
  } = report;
  const totalCost = report.costUsd;
  const mainCost = report.mainCostUsd;
  const agentCost = report.subagentCostUsd;
  const serialLaunches = perMessage.filter((n) => n === 1).length;

  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          files,
          costUsd: totalCost,
          mainCostUsd: mainCost,
          subagentCostUsd: agentCost,
          /* activeHours = 休止(30分以上の空き)を除いた実所要。finalize が metrics へ書く。
             wallClockHours = 最初の記録から最後の記録までの経過(参考) */
          activeHours,
          wallClockHours,
          models: totals,
          agents: {
            launched: launches.length,
            transcripts: agentSummaries.length,
            messagesWithLaunches: perMessage.length,
            singleLaunchMessages: serialLaunches,
            maxConcurrent: overlap.maxConcurrent,
            serialMinutes: Number((overlap.serialMs / 60000).toFixed(1)),
            spanMinutes: Number((overlap.spanMs / 60000).toFixed(1)),
            totalTurns: agentSummaries.reduce((s, a) => s + a.turns, 0),
            top: agentSummaries.slice(0, 10).map((a) => ({
              label: a.label,
              costUsd: Number(a.costUsd.toFixed(2)),
              turns: a.turns,
              costPerTurnUsd: Number(a.costPerTurnUsd.toFixed(3)),
              ctxMaxTokens: a.ctxMaxTokens,
            })),
          },
        },
        null,
        1
      )
    );
    return;
  }

  console.log(
    `セッション記録: ${files}ファイル + サブエージェント ${agentSummaries.length}本  (${dir})`
  );
  console.log("");
  for (const [model, u] of Object.entries(totals).sort((a, b) => costOf(b[0], b[1]) - costOf(a[0], a[1]))) {
    console.log(
      `  ${model.padEnd(24)} $${costOf(model, u).toFixed(2).padStart(8)}  ` +
        `出力 ${fmtTok(u.output)} / cache write ${fmtTok(u.cacheWrite5m + u.cacheWrite1h)}` +
        `(5m ${fmtTok(u.cacheWrite5m)} / 1h ${fmtTok(u.cacheWrite1h)}) / cache read ${fmtTok(u.cacheRead)}`
    );
  }
  console.log(`  ${"合計".padEnd(24)} $${totalCost.toFixed(2).padStart(8)}`);
  console.log(
    `  ${"うち メイン / サブ".padEnd(22)} $${mainCost.toFixed(2)} / $${agentCost.toFixed(2)}` +
      `(サブエージェント ${agentSummaries.length}本・${agentSummaries.reduce((s, a) => s + a.turns, 0)}ターン)`
  );
  console.log(
    `  ${"制作の実所要 / 経過".padEnd(22)} ${activeHours.toFixed(2)}時間 / ${wallClockHours.toFixed(2)}時間` +
      `(実所要は30分以上の空きを休止として除いたもの)`
  );
  console.log("");
  console.log("サブエージェントの起動(並列の実行形):");
  console.log(`  起動 ${launches.length}本 / 起動を含むメッセージ ${perMessage.length}件`);
  console.log(
    `  うち「1メッセージ1本」= ${serialLaunches}件` +
      (perMessage.length > 1 && serialLaunches === perMessage.length
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

  if (agentSummaries.length > 0) {
    console.log("");
    console.log(
      `コストの高いサブエージェント(コストはターン数に線形。実測の目安 $${TURN_COST_BENCHMARK_USD}/ターン):`
    );
    for (const a of agentSummaries.slice(0, 10)) {
      const over = a.turns > TURN_BUDGET ? `  ← ターン予算 ${TURN_BUDGET} 超過` : "";
      console.log(
        `  $${a.costUsd.toFixed(1).padStart(6)}  ${String(a.turns).padStart(3)}ターン  ` +
          `$${a.costPerTurnUsd.toFixed(3)}/ターン  ctx最大 ${fmtTok(a.ctxMaxTokens)}  ${a.label}${over}`
      );
    }
  }
}

/* テストから import したときは走らせない */
if (process.argv[1] && path.basename(process.argv[1]) === "usage-report.ts") main();
