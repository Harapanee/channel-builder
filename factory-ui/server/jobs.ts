import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JobDetail, JobSummary, GateRequest, RateLimitInfo, JobMode } from '../shared/types';
import {
  OPERATIONS,
  buildJobPrompt,
  buildResumePrompt,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  ALLOWED_MODELS,
  ALLOWED_EFFORTS,
} from './operations';
import { parseLine, extractGate, extractStage, hasDone, stripMarkers } from './streamparse';
import { findEpisodeProgress, videoCreateDoneCount, advanceStages } from './progress';

// claude プロセスの最小インターフェース(テストで Fake を注入する)
export type SpawnClaude = (
  args: string[],
  opts: { cwd: string },
) => { stdout: Readable; onExit(cb: (code: number) => void): void; kill(): void };

const defaultSpawn: SpawnClaude = (args, opts) => {
  const p = spawn('claude', args, { cwd: opts.cwd, env: process.env });
  return {
    stdout: p.stdout,
    onExit: (cb) => p.on('close', (code) => cb(code ?? 0)),
    kill: () => p.kill(),
  };
};

/** 外部システムとの連携フック。enqueueRender は夜間レンダーキューへの登録(成功/登録済み=true) */
export type JobHooks = {
  enqueueRender?: (dir: string, epId: string) => boolean;
};

export type CreateJobOpts = {
  dir: string;
  operation: string;
  arg: string;
  mode?: JobMode;
  model?: string;
  effort?: string;
  durationSec?: number;
  episodeId?: string;
};

type Internal = {
  detail: JobDetail;
  proc?: ReturnType<SpawnClaude>;
  buf: string;
  lastOptionId?: string;
  gen: number; // startProcのたびに増える。旧プロセスの遅延コールバックを無効化する
  sawDone: boolean; // 完了マーカー <done> を観測したか。exit 0 でもこれが無ければ途中終了扱い
  autoResponds: number; // モード由来の自動ゲート応答回数(暴走ループ対策の上限判定)
};

const STREAM_ARGS = ['--output-format=stream-json', '--verbose'];
const MAX_AUTO_RESPONDS = 20;

/**
 * ヘッドレス claude ジョブを起動・監視・ゲート応答するマネージャ。
 * ジョブ状態は jobs/<id>/state.json、生ログは jobs/<id>/log.jsonl に永続化する。
 * emit: 'update'(JobDetail) / 'log'(id, line) / 'gate'(id, GateRequest) / 'rate-limit'(RateLimitInfo)
 */
export class JobManager extends EventEmitter {
  private readonly root: string;
  private readonly jobsDir: string;
  private jobs = new Map<string, Internal>();

  constructor(
    root: string,
    private readonly spawnFn: SpawnClaude = defaultSpawn,
    private readonly hooks: JobHooks = {},
  ) {
    super();
    this.root = path.resolve(root);
    this.jobsDir = path.join(this.root, 'factory-ui', 'jobs');
    // factory-ui/jobs は .gitignore 済み。無ければ後で mkdir する
  }

  create(opts: CreateJobOpts): JobSummary {
    const op = OPERATIONS[opts.operation];
    if (!op) throw new Error(`unknown operation: ${opts.operation}`);
    this.resolveCwd(opts.dir); // 存在確認とパス封じ込め検証(実際の起動はstartJobで再解決)
    const mode = opts.mode ?? 'manual';
    if (mode !== 'manual' && mode !== 'semi' && mode !== 'auto') {
      throw new Error(`invalid mode: ${String(mode)}`);
    }
    const model = opts.model ?? DEFAULT_MODEL;
    if (!(ALLOWED_MODELS as readonly string[]).includes(model)) throw new Error(`invalid model: ${model}`);
    const effort = opts.effort ?? DEFAULT_EFFORT;
    if (!(ALLOWED_EFFORTS as readonly string[]).includes(effort)) throw new Error(`invalid effort: ${effort}`);
    if (
      opts.durationSec !== undefined &&
      (!Number.isFinite(opts.durationSec) || opts.durationSec < 10 || opts.durationSec > 3600)
    ) {
      throw new Error(`invalid durationSec: ${String(opts.durationSec)}`);
    }
    if (op.needsArg && !op.argOptional && opts.arg.trim() === '') {
      throw new Error(`arg is required for operation ${op.key}`);
    }
    const id = randomUUID();
    const now = Date.now();
    const detail: JobDetail = {
      id,
      dir: opts.dir,
      operation: opts.operation,
      title: op.needsArg ? (opts.arg.trim() === '' ? 'おまかせ(ネタ帳から自動選定)' : truncateTitle(opts.arg)) : op.label,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      mode,
      model,
      effort,
      request: { arg: opts.arg, durationSec: opts.durationSec, episodeId: opts.episodeId },
      // 制作ラインのステージレール(最初を active、残りを pending)。ゲート到達ごとに前進する
      stages: op.stages.map((label, i) => ({
        key: `s${i}`,
        label,
        state: i === 0 ? 'active' : 'pending',
      })),
      artifacts: [],
    };
    const internal: Internal = { detail, buf: '', gen: 0, sawDone: false, autoResponds: 0 };
    this.jobs.set(id, internal);
    if (this.conflictsWithActive(detail)) {
      detail.status = 'queued';
    } else {
      this.startJob(internal);
    }
    this.persist(internal);
    this.emitUpdate(internal);
    return { ...this.summary(detail) };
  }

  list(): JobSummary[] {
    return [...this.jobs.values()].map((j) => this.summary(j.detail));
  }

  get(id: string): JobDetail | undefined {
    const j = this.jobs.get(id);
    return j ? this.reconciled(j.detail) : undefined;
  }

  cancel(id: string): void {
    const j = this.mustGet(id);
    const st = j.detail.status;
    if (st === 'queued') {
      j.detail.status = 'cancelled';
      this.touch(j);
      return;
    }
    if (st === 'running' || st === 'awaiting_gate') {
      j.gen++; // 旧プロセスの遅延コールバック(残留ゲート行含む)を無効化し復活を防ぐ
      j.detail.status = 'cancelled';
      j.detail.gate = undefined; // キャンセル済みジョブにGateCardを残さない
      this.removeGate(j);
      this.touch(j);
      try {
        j.proc?.kill();
      } catch {
        /* already dead */
      }
      this.startNext(j.detail.dir); // チャンネルが空いたので待機列を進める
    }
  }

  respondGate(id: string, optionId: string, feedback?: string): void {
    const j = this.mustGet(id);
    if (j.detail.status !== 'awaiting_gate' || !j.detail.gate) {
      throw new Error(`job ${id} is not awaiting a gate`);
    }
    const gate = j.detail.gate;
    const opt = gate.options.find((o) => o.id === optionId);
    if (!opt) throw new Error(`invalid optionId: ${optionId}`);
    const sid = j.detail.sessionId;
    if (!sid) throw new Error(`job ${id} has no sessionId to resume`);
    // render-check を revise 以外で応答したら、レンダー突入を許可する(バックストップ解除)。
    // あわせて夜間レンダーキューへ登録し、登録できたら決定文を「レンダーせず完了処理」に変える
    // (エピソード未解決・フック未接続なら従来の「レンダー実行」にフォールバック=旧スキルを壊さない)
    let queuedForRender = false;
    if (gate.kind === 'render-check' && optionId !== 'revise') {
      j.detail.renderApproved = true;
      queuedForRender = this.tryEnqueueRender(j);
    }
    const oldProc = j.proc;
    j.detail.gate = undefined;
    j.detail.status = 'running';
    j.lastOptionId = optionId;
    this.removeGate(j); // 応答済みゲートの gate.json を消す(古い gate を UI が誤読しない)
    this.touch(j);
    const decision = buildDecision(gate, opt, optionId, feedback, queuedForRender);
    const absCwd = this.resolveCwd(j.detail.dir);
    // 先に startProc で世代を上げる → 旧プロセスの遅延/kill由来のexitは世代不一致で無害化される
    this.startProc(j, ['-p', '--resume', sid, decision, ...this.modelArgs(j), ...STREAM_ARGS], absCwd);
    try {
      oldProc?.kill();
    } catch {
      /* already dead */
    }
  }

  /**
   * 中断(interrupted)・失敗(failed)・キャンセル(cancelled)済みジョブを
   * claude --resume <sessionId> で途中から再開する。
   * sessionId が無い場合・チャンネル使用中はthrow(API層で409/400に振り分ける)。
   */
  resume(id: string): JobDetail {
    const j = this.mustGet(id);
    const st = j.detail.status;
    if (st !== 'interrupted' && st !== 'failed' && st !== 'cancelled') {
      throw new Error(`job ${id} is not resumable (status: ${st})`);
    }
    const sid = j.detail.sessionId;
    if (!sid) throw new Error(`job ${id} has no sessionId to resume`);
    if (this.conflictsWithActive(j.detail)) {
      throw new Error(`channel ${j.detail.dir} has a conflicting active job`);
    }
    const op = OPERATIONS[j.detail.operation];
    if (!op) throw new Error(`unknown operation: ${j.detail.operation}`);
    j.sawDone = false;
    j.autoResponds = 0; // 人間による再開=暴走保護ウィンドウのリセット(restore()の0復元と挙動を揃える)
    j.detail.status = 'running';
    j.detail.error = undefined;
    j.detail.exitCode = undefined;
    j.detail.gate = undefined;
    this.removeGate(j);
    const prompt = buildResumePrompt(op, j.detail.mode);
    this.startProc(
      j,
      ['-p', '--resume', sid, prompt, ...this.modelArgs(j), ...STREAM_ARGS],
      this.resolveCwd(j.detail.dir),
    );
    this.touch(j);
    return { ...j.detail };
  }

  /** 起動時に永続化状態を復元する。稼働中だったジョブ(running)は interrupted にする */
  restore(): void {
    if (!fs.existsSync(this.jobsDir)) return;
    for (const id of fs.readdirSync(this.jobsDir)) {
      const statePath = path.join(this.jobsDir, id, 'state.json');
      if (!fs.existsSync(statePath)) continue;
      if (this.jobs.has(id)) continue;
      try {
        const detail = JSON.parse(fs.readFileSync(statePath, 'utf8')) as JobDetail;
        if (detail.status === 'running') detail.status = 'interrupted';
        detail.mode ??= 'manual';
        detail.model ??= DEFAULT_MODEL;
        detail.effort ??= DEFAULT_EFFORT;
        detail.request ??= { arg: '' };
        this.jobs.set(id, { detail, buf: '', gen: 0, sawDone: false, autoResponds: 0 });
      } catch {
        /* skip corrupt state */
      }
    }
    // 復元後、queued が残っているチャンネルは空きがあれば起動する
    const dirs = new Set([...this.jobs.values()].filter((j) => j.detail.status === 'queued').map((j) => j.detail.dir));
    for (const dir of dirs) this.startNext(dir);
  }

  // ---- internals ----

  /** ジョブに紐づく --model/--effort 引数(初回・--resume再開の全spawnに付ける)。
   * readOnly オペ(ask等)は書き込み系ツールを --disallowedTools で禁止し、
   * ゲート応答で --resume 再開したプロセスにも同じ制限を引き継ぐ */
  private modelArgs(internal: Internal): string[] {
    const args = ['--model', internal.detail.model, '--effort', internal.detail.effort];
    const op = OPERATIONS[internal.detail.operation];
    if (op?.readOnly) {
      args.push('--disallowedTools', 'Write,Edit,NotebookEdit,Bash');
    }
    return args;
  }

  /**
   * 候補ジョブが稼働中(running/awaiting_gate)のジョブと干渉するか。
   * video-create同士は並列可(episodes/<epId>/配下しか触らないため)。ただし
   * 同一episodeIdを対象とする組は排他(同一エピソードの二重制作を防ぐ)。
   * それ以外の操作(channel-refine等)は共有ファイルを触るため従来どおりチャンネル排他。
   */
  private conflictsWithActive(cand: JobDetail): boolean {
    return [...this.jobs.values()].some((j) => {
      const a = j.detail;
      if (a.id === cand.id || a.dir !== cand.dir) return false;
      if (a.status !== 'running' && a.status !== 'awaiting_gate') return false;
      if (a.operation === 'video-create' && cand.operation === 'video-create') {
        const aEp = a.request?.episodeId;
        const cEp = cand.request?.episodeId;
        return !!aEp && aEp === cEp;
      }
      return true;
    });
  }

  /** queued(または作成直後)のジョブのプロンプトを組み立てて起動する */
  private startJob(internal: Internal): void {
    const d = internal.detail;
    const op = OPERATIONS[d.operation];
    if (!op) throw new Error(`unknown operation: ${d.operation}`);
    const prompt = buildJobPrompt(op, d.request.arg, {
      mode: d.mode,
      durationSec: d.request.durationSec,
      episodeId: d.request.episodeId,
    });
    d.status = 'running';
    internal.sawDone = false;
    this.startProc(internal, ['-p', prompt, ...this.modelArgs(internal), ...STREAM_ARGS], this.resolveCwd(d.dir));
  }

  /** チャンネルに空きができたら、同dirのqueuedを作成順に走査し、干渉しないものをすべて起動する */
  private startNext(dir: string): void {
    const queued = [...this.jobs.values()]
      .filter((j) => j.detail.dir === dir && j.detail.status === 'queued')
      .sort((a, b) => a.detail.createdAt - b.detail.createdAt);
    for (const next of queued) {
      if (this.conflictsWithActive(next.detail)) continue;
      try {
        this.startJob(next);
        this.touch(next);
      } catch (e) {
        next.detail.status = 'failed';
        next.detail.error = String(e instanceof Error ? e.message : e);
        this.touch(next);
      }
    }
  }

  private startProc(internal: Internal, args: string[], cwd: string): void {
    const gen = ++internal.gen; // この世代のコールバックだけを有効にする
    internal.sawDone = false; // 完了マーカーは世代ごとに取り直す(旧世代の<done>を引きずらない)
    const proc = this.spawnFn(args, { cwd });
    internal.proc = proc;
    internal.buf = '';
    proc.stdout.on('data', (d: Buffer | string) => {
      if (internal.gen === gen) this.onData(internal, d.toString());
    });
    proc.onExit((code) => {
      if (internal.gen === gen) this.onExit(internal, code);
    });
  }

  private onData(internal: Internal, chunk: string): void {
    internal.buf += chunk;
    let nl: number;
    while ((nl = internal.buf.indexOf('\n')) >= 0) {
      const line = internal.buf.slice(0, nl);
      internal.buf = internal.buf.slice(nl + 1);
      this.onLine(internal, line);
    }
  }

  private onLine(internal: Internal, line: string): void {
    if (line.trim() === '') return;
    this.appendLog(internal, line);
    this.emit('log', internal.detail.id, line);
    const ev = parseLine(line);
    if (!ev) return;
    const d = internal.detail;
    switch (ev.kind) {
      case 'init':
        if (ev.sessionId) d.sessionId = ev.sessionId;
        this.touch(internal);
        break;
      case 'rate-limit':
        d.rateLimit = ev.info as RateLimitInfo;
        this.emit('rate-limit', ev.info);
        this.touch(internal);
        break;
      case 'gate':
        // パーサが assistant text 内のゲートを検出済み。同一メッセージに<stage>が
        // 同居しているケースがあるため、openGate(内部でadvanceStageする)より前に
        // 元textを maybeStage に通して工程前進を取りこぼさない
        this.maybeStage(internal, ev.text);
        this.openGate(internal, ev.gate);
        break;
      case 'text':
        if (hasDone(ev.text)) internal.sawDone = true;
        this.maybeStage(internal, ev.text);
        this.maybeGate(internal, ev.text);
        break;
      case 'result':
        if (ev.sessionId) d.sessionId = ev.sessionId;
        if (ev.result) d.resultText = stripMarkers(ev.result);
        if (hasDone(ev.result)) internal.sawDone = true;
        this.maybeStage(internal, ev.result);
        // result.result にゲートが出る場合のフォールバック検出
        this.maybeGate(internal, ev.result);
        break;
      default:
        break;
    }
  }

  // <stage>ラベル</stage> マーカーで進捗バーを該当工程まで前進させる。
  // 未知ラベル・後退(現activeより前の工程)は無視して現状維持。
  private maybeStage(internal: Internal, text: string): void {
    const label = extractStage(text);
    if (!label || internal.detail.status !== 'running') return;
    const d = internal.detail;
    const target = d.stages.findIndex((s) => s.label === label);
    if (target < 0) return;
    // 後退ガード: activeが無い(最終工程のゲート後など)場合でも、pendingでない
    // 最大index(frontier)より前には戻らせない
    const frontier = d.stages.reduce((max, s, i) => (s.state !== 'pending' ? i : max), -1);
    if (target <= frontier) return;
    // レンダー前バックストップ: 目視確認(render-check)未承認のままレンダー工程へ
    // 入ろうとしたら、前進させずにプロセスを止めて合成ゲートを開く(8.5スキップ事故の再発防止)
    if (label === 'レンダー' && d.operation === 'video-create' && d.mode !== 'auto' && !d.renderApproved) {
      this.renderBackstop(internal, target);
      return;
    }
    d.stages.forEach((s, i) => {
      s.state = i < target ? 'done' : i === target ? 'active' : 'pending';
    });
    this.touch(internal);
    this.emit('stage', d.id, label);
  }

  /** レンダー工程への無断突入を強制停止し、合成の目視確認ゲート(render-check)を開く */
  private renderBackstop(internal: Internal, targetIndex: number): void {
    const d = internal.detail;
    // レンダー直前まで進んだ状態を工程に反映(レンダーをactiveで停止)
    d.stages.forEach((s, i) => {
      s.state = i < targetIndex ? 'done' : i === targetIndex ? 'active' : 'pending';
    });
    const gate: GateRequest = {
      gateId: `render-backstop-${randomUUID()}`,
      kind: 'render-check',
      question: 'レンダー前の目視確認が済んでいません。Remotion Studio でプレビューを確認してください。',
      options: [
        { id: 'approve', label: '確認した、レンダー再開', description: 'レンダーを開始します' },
        { id: 'revise', label: '修正を依頼', description: 'フィードバックを記入して修正させます' },
      ],
      context:
        'エージェントが目視確認ゲートを発行せずにレンダー工程へ進もうとしたため、強制停止しました。',
    };
    d.gate = gate;
    d.status = 'awaiting_gate';
    this.writeGate(internal, gate);
    internal.gen++; // 旧プロセスの残り出力・exitを無効化
    try {
      internal.proc?.kill();
    } catch {
      /* already dead */
    }
    this.touch(internal);
    this.emit('gate', d.id, gate);
  }

  private maybeGate(internal: Internal, text: string): void {
    const gate = extractGate(text);
    if (gate) this.openGate(internal, gate);
  }

  private openGate(internal: Internal, gate: GateRequest): void {
    // running 以外(awaiting_gate/cancelled/succeeded/failed)ではゲートを開かない
    if (internal.detail.status !== 'running') return;
    const d = internal.detail;
    d.gate = gate;
    d.status = 'awaiting_gate';
    this.advanceStage(d); // ゲート到達=1工程進んだ目印
    this.writeGate(internal, gate);
    this.touch(internal);
    this.emit('gate', d.id, gate);
    this.maybeAutoRespond(internal);
  }

  /**
   * モード由来のゲート自動応答。auto=全ゲート / semi=render-check以外
   * (ただしsemiで工程が「レンダー」直前に達した場合は人間の確認に委ねる)。
   * 応答は respondGate と同経路(--resume 再spawn)。無限ループ対策で上限あり。
   */
  private maybeAutoRespond(internal: Internal): void {
    const d = internal.detail;
    const gate = d.gate;
    if (!gate || d.status !== 'awaiting_gate') return;
    const semiOk =
      d.mode === 'semi' && gate.kind !== 'render-check' && !this.atRenderBrink(d);
    if (!(d.mode === 'auto' || semiOk)) return;
    if (!d.sessionId) return; // 再開不能。人間の応答に委ねる
    if (internal.autoResponds >= MAX_AUTO_RESPONDS) {
      d.status = 'interrupted';
      d.gate = undefined;
      d.error = `自動ゲート応答が上限(${MAX_AUTO_RESPONDS}回)に達したため停止しました。ログを確認してください。`;
      this.removeGate(internal);
      internal.gen++;
      try {
        internal.proc?.kill();
      } catch {
        /* already dead */
      }
      this.touch(internal);
      this.startNext(d.dir);
      return;
    }
    const opt = gate.options[0];
    if (!opt) return;
    internal.autoResponds++;
    const note = `[factory-ui] ゲート「${gate.question}」を自動応答: ${opt.label}(mode=${d.mode})`;
    this.appendLog(internal, note);
    this.emit('log', d.id, note);
    // 現在処理中のstdout行の巻き込みを避けるため、次のtickで応答する
    const gid = gate.gateId;
    setImmediate(() => {
      if (this.jobs.get(d.id)?.detail.gate?.gateId !== gid) return; // 別ゲートに差し替わっていたら何もしない
      try {
        this.respondGate(d.id, opt.id);
      } catch {
        /* キャンセル等で状態が変わっていたら何もしない */
      }
    });
  }

  /** semi用: ゲート前進の結果、工程が「レンダー」activeに達した=レンダー直前(人間の確認に委ねる) */
  private atRenderBrink(d: JobDetail): boolean {
    return (
      d.operation === 'video-create' &&
      !d.renderApproved &&
      d.stages.find((s) => s.state === 'active')?.label === 'レンダー'
    );
  }

  // active な工程を done にし、次の pending を active にする(制作ラインの前進)
  private advanceStage(d: JobDetail): void {
    const i = d.stages.findIndex((s) => s.state === 'active');
    if (i < 0) return;
    d.stages[i]!.state = 'done';
    if (i + 1 < d.stages.length) d.stages[i + 1]!.state = 'active';
  }

  private completeStages(d: JobDetail): void {
    for (const s of d.stages) s.state = 'done';
  }

  private onExit(internal: Internal, code: number): void {
    const d = internal.detail;
    // ゲート待ちで止まった / 応答で再spawnした場合の旧プロセス終了は状態を変えない
    if (d.status === 'awaiting_gate' || d.status === 'cancelled') return;
    if (d.status !== 'running') return;
    d.exitCode = code;
    if (code !== 0) {
      d.status = 'failed';
      d.error = `claude exited with code ${code}`;
    } else if (internal.sawDone) {
      d.status = 'succeeded';
      this.completeStages(d); // 完了報告つきの成功時のみ全工程を完了に
      this.maybeQueueOnSuccess(internal);
    } else {
      // exit 0 でも <done> が無い=agentが途中でターンを終えた(例: サブエージェントの
      // 完了通知待ちで停止)。全工程doneに塗りつぶさず、途中終了として可視化する
      d.status = 'interrupted';
      d.error = '完了報告(<done>)が無いままプロセスが正常終了しました。工程の途中で停止した可能性があります。再試行で作り直せます。';
    }
    this.touch(internal);
    this.startNext(d.dir);
  }

  /**
   * render-check承認時のキュー登録。ジョブに対応するエピソードを解決できたときだけ登録する。
   * video-create以外(channel-refine経由の再開など)は episodeId 明示時のみ対象
   * (タイトルからの推定解決は誤登録し得るため video-create に限る)。
   */
  private tryEnqueueRender(internal: Internal): boolean {
    const d = internal.detail;
    if (!this.hooks.enqueueRender) return false;
    if (d.operation !== 'video-create' && !d.request.episodeId) return false;
    try {
      const ep = findEpisodeProgress(this.root, d.dir, d.request, d.title);
      if (!ep) return false;
      return this.hooks.enqueueRender(d.dir, ep.episodeId);
    } catch {
      return false;
    }
  }

  /**
   * ゲートを介さず承認済みに達したジョブ(autoモード等)の成功時キュー登録。
   * episode.json が render_ready(承認済み・未レンダー)のときだけ登録する。二重登録はキュー側が吸収。
   */
  private maybeQueueOnSuccess(internal: Internal): void {
    const d = internal.detail;
    if (!this.hooks.enqueueRender) return;
    if (d.operation !== 'video-create' && !d.request.episodeId) return;
    try {
      const ep = findEpisodeProgress(this.root, d.dir, d.request, d.title);
      if (ep && ep.status === 'render_ready' && !ep.hasFinal) {
        this.hooks.enqueueRender(d.dir, ep.episodeId);
      }
    } catch {
      /* キュー登録の失敗はジョブの成否に影響させない */
    }
  }

  private resolveCwd(dir: string): string {
    if (dir === '') return this.root;
    if (dir.includes('/') || dir.includes(path.sep) || dir === '.' || dir === '..' || path.isAbsolute(dir)) {
      throw new Error(`invalid job dir: ${dir}`);
    }
    const abs = path.resolve(this.root, dir);
    if (path.dirname(abs) !== this.root) throw new Error(`invalid job dir: ${dir}`);
    if (!fs.existsSync(path.join(abs, '.channel-system.json'))) {
      throw new Error(`not a channel dir: ${dir}`);
    }
    // シンボリックリンク経由で root 外のディレクトリを cwd にしない(realpath で封じ込め再確認)
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(this.root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new Error(`invalid job dir: ${dir}`);
    }
    return abs;
  }

  private mustGet(id: string): Internal {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`unknown job: ${id}`);
    return j;
  }

  private summary(d: JobDetail): JobSummary {
    const { stages, artifacts, sessionId, gate, rateLimit, request, resultText, renderApproved, ...s } = d;
    return { ...s, episodeId: this.episodeIdOf(d) };
  }

  /** ジョブに関連するエピソードID。refine等はrequest指定、video-createは題材(タイトル)から解決する */
  private episodeIdOf(d: JobDetail): string | undefined {
    if (d.request?.episodeId) return d.request.episodeId;
    if (d.operation !== 'video-create') return undefined;
    try {
      return findEpisodeProgress(this.root, d.dir, d.request, d.title)?.episodeId;
    } catch {
      return undefined;
    }
  }

  private jobDir(id: string): string {
    const dir = path.join(this.jobsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private persist(internal: Internal): void {
    const dir = this.jobDir(internal.detail.id);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(internal.detail, null, 2));
  }

  private appendLog(internal: Internal, line: string): void {
    const dir = this.jobDir(internal.detail.id);
    fs.appendFileSync(path.join(dir, 'log.jsonl'), line + '\n');
  }

  private writeGate(internal: Internal, gate: GateRequest): void {
    const dir = this.jobDir(internal.detail.id);
    fs.writeFileSync(path.join(dir, 'gate.json'), JSON.stringify(gate, null, 2));
  }

  private removeGate(internal: Internal): void {
    const p = path.join(this.jobsDir, internal.detail.id, 'gate.json');
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* nothing to remove */
    }
  }

  private touch(internal: Internal): void {
    internal.detail.updatedAt = Date.now();
    this.persist(internal);
    this.emitUpdate(internal);
  }

  private emitUpdate(internal: Internal): void {
    this.emit('update', this.reconciled(internal.detail));
  }

  /**
   * 表示用の工程突き合わせ(前進のみ・非破壊)。
   * <stage>マーカーはエージェントが出力しないことがあり、キャンセル/再開を跨ぐと
   * 進捗バーが実態より手前で止まる。video-create ではエピソードの episode.json の
   * status(スキルが各工程完了時に更新する再開用の正)を読み、そこまで工程を前進させた
   * 複製を返す。内部状態(frontierガード・レンダーバックストップ判定)は変更しない。
   */
  private reconciled(d: JobDetail): JobDetail {
    if (d.operation !== 'video-create' || d.status === 'succeeded') {
      return { ...d, episodeId: this.episodeIdOf(d) };
    }
    try {
      const ep = findEpisodeProgress(this.root, d.dir, d.request, d.title);
      if (!ep) return { ...d, episodeId: d.request?.episodeId };
      return { ...d, episodeId: ep.episodeId, stages: advanceStages(d.stages, videoCreateDoneCount(ep)) };
    } catch {
      return { ...d, episodeId: d.request?.episodeId };
    }
  }
}

/** 長い引数(フィードバック文等)をタイトル用に60字へ丸める */
function truncateTitle(arg: string): string {
  return arg.length > 60 ? arg.slice(0, 60) + '…' : arg;
}

/** ゲート応答をclaudeへ渡す決定文にする。render-checkは承認/修正依頼/キュー登録済みで文面を分ける */
function buildDecision(
  gate: GateRequest,
  opt: { id: string; label: string },
  optionId: string,
  feedback?: string,
  queuedForRender = false,
): string {
  const fb = feedback?.trim();
  if (gate.kind === 'render-check') {
    if (optionId === 'revise') {
      return `レンダー前の目視確認で修正依頼がありました。次のフィードバックを反映し、修正が終わったら再度 kind:"render-check" のゲートを発行して確認を求めてください: ${fb || '(記載なし)'}`;
    }
    if (queuedForRender) {
      let d =
        `レンダー前の一括確認を承認しました(${opt.label})。エピソードは夜間レンダーキューに登録済みです。` +
        `レンダーは実行せず、工程12の完了処理 — episode.json の status を "render_ready" へ更新、` +
        `.channel-system.json の metrics へエントリ追加(wallClockHours / imageGenCount を記入、renderMinutes は null)、` +
        `channel/backlog.md に該当行があれば状態を「済(<epId>)」へ更新、git commit — を行って <done> で終了してください。`;
      if (fb) d += ` あわせて次のフィードバックを反映してください: ${fb}`;
      return d;
    }
    let d = `レンダー前の目視確認を承認しました(${opt.label})。レンダーを実行し、完了まで進めてください。`;
    if (fb) d += ` あわせて次のフィードバックを反映してください: ${fb}`;
    return d;
  }
  let d = `ゲート ${gate.gateId} の決定: ${opt.label}。この決定で作業を続けてください。`;
  if (fb) d += ` あわせて次のフィードバックを反映してください: ${fb}`;
  return d;
}
