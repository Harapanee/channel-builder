import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JobDetail, JobStage, JobSummary, GateRequest, RateLimitInfo, JobMode } from '../shared/types';
import {
  OPERATIONS,
  buildJobPrompt,
  buildResumePrompt,
  videoCreatePhaseForStatus,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  ALLOWED_MODELS,
  ALLOWED_EFFORTS,
} from './operations';
import { parseLine, extractGate, extractStage, hasDone, stripMarkers } from './streamparse';
import { stampLogLine } from './logstamp';
import {
  findEpisodeProgress,
  findShortIdForJob,
  videoCreateDoneCount,
  advanceStages,
  collectArtifacts,
  _clearProgressCache,
} from './progress';

// claude プロセスの最小インターフェース(テストで Fake を注入する)
export type SpawnClaude = (
  args: string[],
  opts: { cwd: string },
) => { stdout: Readable; onExit(cb: (code: number) => void): void; kill(): void };

/**
 * claude CLI のspawnラッパー。起動失敗('error'イベント: ENOENT/EBADF等)も
 * onExit(-1) として通知する — closeが来ないまま座礁させない(binはテスト用に差し替え可)。
 */
export const makeClaudeSpawn =
  (bin: string): SpawnClaude =>
  (args, opts) => {
    const p = spawn(bin, args, { cwd: opts.cwd, env: process.env });
    return {
      stdout: p.stdout,
      onExit: (cb) => {
        let fired = false;
        const fire = (code: number) => {
          if (!fired) {
            fired = true;
            cb(code);
          }
        };
        p.on('close', (code) => fire(code ?? 0));
        p.on('error', () => fire(-1));
      },
      kill: () => p.kill(),
    };
  };

const defaultSpawn: SpawnClaude = makeClaudeSpawn('claude');

/** 外部システムとの連携フック。enqueueRender は夜間レンダーキューへの登録(成功/登録済み=true) */
export type JobHooks = {
  enqueueRender?: (dir: string, epId: string, kind?: 'episode' | 'short') => boolean;
};

export type CreateJobOpts = {
  dir: string;
  operation: string;
  arg: string;
  mode?: JobMode;
  model?: string;
  effort?: string;
  durationSec?: number;
  durationSecMax?: number;
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
  logStream?: fs.WriteStream; // log.jsonl への遅延生成された追記ストリーム(appendFileSyncの同期I/Oを避ける)
  logTail?: string[]; // このプロセスでappendLogした行のメモリ上の末尾(上限MAX_LOG_READ_LINES)。restore直後は undefined
};

const STREAM_ARGS = ['--output-format=stream-json', '--verbose'];
const MAX_AUTO_RESPONDS = 20;
// readLog が返す過去ログの上限行数(ファイル自体は全量を保持し、返却時だけ末尾を切る)
const MAX_LOG_READ_LINES = 2000;
// restore復元ジョブ(メモリ上のlogTailが無い)のreadLogでファイルから読む末尾バイト数
const TAIL_READ_BYTES = 512 * 1024;

/**
 * ヘッドレス claude ジョブを起動・監視・ゲート応答するマネージャ。
 * ジョブ状態は jobs/<id>/state.json、生ログは jobs/<id>/log.jsonl に永続化する。
 * emit: 'update'(JobDetail) / 'log'(id, line) / 'gate'(id, GateRequest) / 'rate-limit'(RateLimitInfo) / 'removed'(id: string)
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
    // rootLevel操作はファクトリールート(dir='')専用。逆に通常操作のdir=''も拒否する
    // (resolveCwd('')はルートを返すため、ガード無しだとチャンネル操作がルートで走ってしまう)
    if (op.rootLevel && opts.dir !== '') {
      throw new Error(`operation ${op.key} はファクトリールート(dir='')でのみ実行できます`);
    }
    if (!op.rootLevel && opts.dir === '') {
      throw new Error(`operation ${op.key} には対象チャンネル(dir)が必要です`);
    }
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
    if (
      opts.durationSecMax !== undefined &&
      (!Number.isFinite(opts.durationSecMax) ||
        opts.durationSecMax < 10 ||
        opts.durationSecMax > 3600 ||
        opts.durationSec === undefined ||
        opts.durationSecMax <= opts.durationSec)
    ) {
      throw new Error(`invalid durationSecMax: ${String(opts.durationSecMax)}(durationSec より大きい 10〜3600 の数値で、durationSec と併せて指定する)`);
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
      request: { arg: opts.arg, durationSec: opts.durationSec, durationSecMax: opts.durationSecMax, episodeId: opts.episodeId },
      // 制作ラインのステージレール(最初を active、残りを pending)。ゲート到達ごとに前進する
      stages: op.stages.map((label, i) => ({
        key: `s${i}`,
        label,
        state: i === 0 ? 'active' : 'pending',
        ...(i === 0 ? { startedAt: now } : {}),
      })),
      artifacts: [],
      ...(op.phases ? { phaseIndex: this.initialPhaseIndex(op, opts) } : {}),
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

  /**
   * ジョブの永続ログ(jobs/<id>/log.jsonl)の末尾 limit 行を返す。
   * UI がジョブ詳細を開き直したとき、WS購読前の過去分を復元するために使う。
   * 不明idは undefined(API層で404)、ログ未作成(起動直後)は空配列。
   * このプロセスでappendLog済み(logTailがある)ならメモリから即返す。
   * restore復元直後などメモリが無いジョブは、ファイル末尾だけをtail読みする(readLogTailFromFile)。
   */
  readLog(id: string, limit = MAX_LOG_READ_LINES): string[] | undefined {
    const j = this.jobs.get(id);
    if (!j) return undefined;
    if (j.logTail) {
      return j.logTail.length > limit ? j.logTail.slice(-limit) : j.logTail.slice();
    }
    return this.readLogTailFromFile(id, limit);
  }

  /** ファイル末尾 TAIL_READ_BYTES だけを読んで行分割する(全量readFileSyncによるメモリ圧を避ける)。
   * 読み始めが行の途中になり得るため、最初の改行より前(壊れた先頭行)は捨てる。 */
  private readLogTailFromFile(id: string, limit: number): string[] {
    const p = path.join(this.jobsDir, id, 'log.jsonl');
    let fd: number;
    try {
      fd = fs.openSync(p, 'r');
    } catch {
      return [];
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size === 0) return [];
      const start = Math.max(0, size - TAIL_READ_BYTES);
      const len = size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      let text = buf.toString('utf8');
      if (start > 0) {
        // 途中から読んでいるので、先頭の(壊れているかもしれない)部分行を捨てる
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
      }
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      return lines.length > limit ? lines.slice(-limit) : lines;
    } finally {
      fs.closeSync(fd);
    }
  }

  cancel(id: string): void {
    const j = this.mustGet(id);
    const st = j.detail.status;
    if (st === 'queued') {
      j.detail.status = 'cancelled';
      this.closeLogStream(j);
      this.touch(j);
      return;
    }
    if (st === 'running' || st === 'awaiting_gate') {
      j.gen++; // 旧プロセスの遅延コールバック(残留ゲート行含む)を無効化し復活を防ぐ
      j.detail.status = 'cancelled';
      j.detail.gate = undefined; // キャンセル済みジョブにGateCardを残さない
      this.removeGate(j);
      this.closeLogStream(j);
      this.touch(j);
      try {
        j.proc?.kill();
      } catch {
        /* already dead */
      }
      this.startNext(j.detail.dir); // チャンネルが空いたので待機列を進める
    }
  }

  /**
   * サーバー終了時に全稼働ジョブの子プロセスを道連れにする(SIGINT/SIGTERMハンドラ用)。
   * 放置すると子が孤児化し、stdoutの読み手を失ってパイプ詰まりで無音凍結する(2026-07-17の実障害)。
   * awaiting_gate はゲート発行時点で proc が kill 済みのため対象外。
   * interrupted を state.json へ即時永続化するので、次回起動の restore() に頼らずディスクも正しくなる。
   */
  killAll(): void {
    for (const j of this.jobs.values()) {
      if (j.detail.status !== 'running') continue;
      j.gen++; // kill由来の遅延exit・残出力を世代不一致で無害化(cancelと同じ手法)
      j.detail.status = 'interrupted';
      this.closeLogStream(j);
      this.touch(j);
      try {
        j.proc?.kill();
      } catch {
        /* already dead */
      }
    }
  }

  /** 終了状態の集合。remove / clearFinished の削除可否判定に使う */
  private static readonly FINISHED: ReadonlySet<string> = new Set([
    'succeeded',
    'failed',
    'cancelled',
    'interrupted',
  ]);

  /**
   * 終了状態(succeeded/failed/cancelled/interrupted)のジョブを削除する。
   * メモリと jobs/<id>/ ディレクトリの両方を消し 'removed' を発火する。
   * 稼働中・待機中は conflict、不明idは unknown を throw(API層で409/404)。
   */
  remove(id: string): void {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`unknown: job ${id}`);
    if (!JobManager.FINISHED.has(j.detail.status)) {
      throw new Error(`conflict: job ${id} is ${j.detail.status}`);
    }
    this.closeLogStream(j); // ファイル削除前にストリームを閉じる
    this.jobs.delete(id);
    try {
      fs.rmSync(path.join(this.jobsDir, id), { recursive: true, force: true });
    } catch {
      /* ディスク側が消せなくてもメモリからは除去済み */
    }
    this.emit('removed', id);
  }

  /** 終了状態のジョブを全チャンネル横断で一括削除し件数を返す(冪等) */
  clearFinished(): number {
    const targets = [...this.jobs.values()]
      .filter((j) => JobManager.FINISHED.has(j.detail.status))
      .map((j) => j.detail.id);
    for (const id of targets) this.remove(id);
    return targets.length;
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
      if (queuedForRender) j.detail.renderQueued = true;
    }
    const oldProc = j.proc;
    j.detail.gate = undefined;
    j.detail.status = 'running';
    j.lastOptionId = optionId;
    this.removeGate(j); // 応答済みゲートの gate.json を消す(古い gate を UI が誤読しない)
    this.touch(j);
    const decision = buildDecision(gate, opt, optionId, feedback, queuedForRender, j.detail.operation === 'short-create');
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
    const prompt = buildResumePrompt(op, j.detail.mode, j.detail.phaseIndex);
    this.startProc(
      j,
      ['-p', '--resume', sid, prompt, ...this.modelArgs(j), ...STREAM_ARGS],
      this.resolveCwd(j.detail.dir),
    );
    this.touch(j);
    return { ...j.detail };
  }

  /**
   * 実行モードを走行中に切り替える(manual ⇄ semi ⇄ auto)。
   * 終了状態のジョブは throw(API層で409)。ゲート停止中に auto/semi へ切り替えた場合は
   * その場で自動応答を再評価する(切替後の次ゲートからではなく、いま止まっているゲートに効かせる)。
   * 人間による明示操作なので暴走保護カウンタはリセットする(resumeと同じ扱い)。
   */
  setMode(id: string, mode: JobMode): JobDetail {
    const j = this.mustGet(id);
    if (mode !== 'manual' && mode !== 'semi' && mode !== 'auto') {
      throw new Error(`invalid mode: ${String(mode)}`);
    }
    if (JobManager.FINISHED.has(j.detail.status)) {
      throw new Error(`conflict: job ${id} is ${j.detail.status}`);
    }
    if (j.detail.mode !== mode) {
      const prev = j.detail.mode;
      j.detail.mode = mode;
      j.autoResponds = 0;
      const note = `[factory-ui] 実行モードを変更: ${prev} → ${mode}`;
      this.appendLog(j, note);
      this.emit('log', j.detail.id, note);
      this.touch(j);
      this.maybeAutoRespond(j);
    }
    return this.reconciled(j.detail);
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
        // 旧state.json互換: video-createの工程ラベル「レビュー」→「最終レビュー」改名の移行
        // (改名後の<stage>最終レビュー</stage>マーカーが旧ラベルの復元ジョブでも一致するように)
        if (detail.operation === 'video-create') {
          for (const s of detail.stages ?? []) {
            if (s.label === 'レビュー') s.label = '最終レビュー';
          }
        }
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
   * short-create同士も並列可(shorts/<対象>/配下しか触らないため)。同一対象
   * (arg = 元エピソードID+フォーマットID)の組のみ排他。
   * short-publish同士も並列可(shorts/<shortId>/publish/配下しか触らないため)。
   * 同一shortId(arg)の組のみ排他。
   * short-create × short-publish は同一ショートが対象の場合のみ排他
   * (short-create側のshortIdはargから解決。未解決なら保守的に排他)。
   * video-create × short-create は、ショートの元エピソードを制作中の場合のみ排他
   * (制作途中のepisodes/<epId>/をショートが読むのを防ぐ)。
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
      if (a.operation === 'short-create' && cand.operation === 'short-create') {
        const aArg = a.request?.arg?.trim();
        const cArg = cand.request?.arg?.trim();
        return !aArg || !cArg || aArg === cArg;
      }
      if (a.operation === 'short-publish' && cand.operation === 'short-publish') {
        const aArg = a.request?.arg?.trim();
        const cArg = cand.request?.arg?.trim();
        return !aArg || !cArg || aArg === cArg;
      }
      const pair = [a, cand];
      const video = pair.find((d) => d.operation === 'video-create');
      const short = pair.find((d) => d.operation === 'short-create');
      const publish = pair.find((d) => d.operation === 'short-publish');
      if (short && publish) {
        const pubShort = publish.request?.arg?.trim();
        let scShort: string | undefined;
        try {
          scShort = findShortIdForJob(this.root, short.dir, short.request?.arg);
        } catch {
          scShort = undefined;
        }
        return !pubShort || !scShort || pubShort === scShort;
      }
      if (video && short) {
        const srcEp = short.request?.arg?.trim().split(/\s+/)[0];
        // 題材名で起動したvideo-createはrequest.episodeIdが無いので、ディスク上の
        // エピソード(episode.jsonのsubject突き合わせ)から解決する(episodeIdOfと同経路)
        const vEp = this.episodeIdOf(video);
        return !srcEp || !vEp || srcEp === vEp;
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
      durationSecMax: d.request.durationSecMax,
      episodeId: d.request.episodeId,
      phaseIndex: d.phaseIndex,
    });
    d.status = 'running';
    internal.sawDone = false;
    this.startProc(internal, ['-p', prompt, ...this.modelArgs(internal), ...STREAM_ARGS], this.resolveCwd(d.dir));
  }

  /** フェーズ分割オペの開始フェーズ。episodeId指定の作り直しジョブは episode.json の
   * status から途中フェーズを引く(完了済みフェーズの空回りセッションを避ける)。 */
  private initialPhaseIndex(op: { phases?: string[] }, opts: CreateJobOpts): number {
    if (!opts.episodeId) return 0;
    try {
      const ep = findEpisodeProgress(this.root, opts.dir, { arg: opts.arg, episodeId: opts.episodeId }, '', undefined);
      return videoCreatePhaseForStatus(ep?.status);
    } catch {
      return 0;
    }
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
    let proc: ReturnType<SpawnClaude>;
    try {
      proc = this.spawnFn(args, { cwd });
    } catch (e) {
      // spawnの同期失敗(fd枯渇のEBADF等)。throwで呼び出し元に漏らすと
      // running×プロセスなしで座礁する(2026-07-15の実障害)ため、failedへ落として可視化する
      const d = internal.detail;
      d.status = 'failed';
      d.error = `プロセス起動に失敗: ${e instanceof Error ? e.message : String(e)}`;
      this.closeLogStream(internal);
      this.touch(internal);
      // startNext中の再入(queuedスナップショットの二重起動)を避けて次tickで後続を起動する
      setImmediate(() => this.startNext(d.dir));
      return;
    }
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
    // appendLogが返すスタンプ済み行をWS配信にも使う。tail/ファイル/live配信の3経路で
    // 文字列を完全一致させないと、クライアントのmergeLogLines(完全一致で重複排除)が
    // 同一行を別物と見なし二重表示になる
    const stamped = this.appendLog(internal, line);
    this.emit('log', internal.detail.id, stamped);
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
        // 同居しているケースがあるため、元textを maybeStage に通して工程前進を取りこぼさない
        // (openGate はゲートで工程を動かさないので、工程前進の経路はここだけ)
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

  // stageのstate遷移を一元化し、工程別所要時間の計測用タイムスタンプを刻む。
  // pending→active で startedAt、→done で endedAt を(未設定の場合のみ)記録する。
  // jobs.ts内でstateを書き換える全経路(create以外)はこのヘルパーを経由すること。
  private setStageState(s: JobStage, next: JobStage['state'], now: number): void {
    if (s.state !== next) {
      if (next === 'active' && s.startedAt === undefined) s.startedAt = now;
      if (next === 'done' && s.endedAt === undefined) s.endedAt = now;
    }
    s.state = next;
  }

  // <stage>ラベル</stage> マーカーで進捗バーを該当工程まで前進させる。
  // 未知ラベル・後退(現activeより前の工程)は無視して現状維持。
  private maybeStage(internal: Internal, text: string): void {
    const label = extractStage(text);
    if (!label || internal.detail.status !== 'running') return;
    const d = internal.detail;
    const target = d.stages.findIndex((s) => s.label === label);
    if (target < 0) return;
    // レンダー前バックストップ: 目視確認(render-check)未承認のままレンダー工程へ
    // 入ろうとしたら、前進させずにプロセスを止めて合成ゲートを開く(8.5スキップ事故の再発防止)。
    // 後退ガードより前に判定すること。工程が既にレンダーまで進んだ状態(修正依頼後の再開、
    // 壊れたstate.jsonからのrestore等)では target <= frontier となり、後退ガードの内側だと
    // バックストップが素通りしてしまうため。
    if (label === 'レンダー' && d.operation === 'video-create' && d.mode !== 'auto' && !d.renderApproved) {
      this.renderBackstop(internal, target);
      return;
    }
    // フェーズ外ガード: セッションはフェーズ末尾の監査などで担当範囲外の工程ラベルを
    // 誤発行することがある(実測 ep001-shoyu: フェーズ2(工程4〜6)が<stage>実装</stage>
    // <stage>検査</stage>を発行し、後続の素材生成・シーン実装の実作業が「検査」枠に
    // 計上された)。他フェーズの担当工程(phaseStages)のマーカーは前進に使わない。
    // どのフェーズにも属さないラベル(レンダー等)は対象外。
    // renderBackstop の判定はこのガードより前(レンダー突入検知を弱めない)。
    const phaseStages = OPERATIONS[d.operation]?.phaseStages;
    const phaseAllowed = d.phaseIndex !== undefined ? phaseStages?.[d.phaseIndex] : undefined;
    if (
      phaseAllowed &&
      !phaseAllowed.includes(label) &&
      phaseStages!.some((list) => list.includes(label))
    ) {
      return;
    }
    // 後退ガード: activeが無い(最終工程のゲート後など)場合でも、pendingでない
    // 最大index(frontier)より前には戻らせない
    const frontier = d.stages.reduce((max, s, i) => (s.state !== 'pending' ? i : max), -1);
    if (target <= frontier) return;
    const now = Date.now();
    d.stages.forEach((s, i) => {
      this.setStageState(s, i < target ? 'done' : i === target ? 'active' : 'pending', now);
    });
    this.touch(internal);
    this.emit('stage', d.id, label);
    // 工程前進=エピソードフォルダ等が出揃った可能性がある。episodeId未解決で保守的に
    // 待機させたジョブ(video-create稼働中のshort-create等)を再評価して起動する
    this.startNext(d.dir);
  }

  /** レンダー工程への無断突入を強制停止し、合成の目視確認ゲート(render-check)を開く */
  private renderBackstop(internal: Internal, targetIndex: number): void {
    const d = internal.detail;
    // レンダー直前まで進んだ状態を工程に反映(レンダーをactiveで停止)
    const now = Date.now();
    d.stages.forEach((s, i) => {
      this.setStageState(s, i < targetIndex ? 'done' : i === targetIndex ? 'active' : 'pending', now);
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
    // ここで工程を前進させてはならない。ゲートは工程の境界ではなく、同一工程の中で
    // 何度でも開く(例: 素材工程での画像生成クレジット枯渇の確認が5回連続)。ゲート数だけ
    // バーを進めると実態と無関係にレンダーまで暴走し、後退ガードのせいで復帰もできなくなる。
    // 進捗の正は <stage>マーカー と episode.json の status(reconciled)のみ。
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
      this.closeLogStream(internal); // ここも終了状態(interrupted)への遷移
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

  private completeStages(d: JobDetail): void {
    const doneAt = Date.now();
    for (const s of d.stages) {
      // 夜間キューへ委譲したレンダー工程はまだ実行されていない。done に塗らず
      // 「queued(夜間キュー待ち)」で止める(キュー成功時に markRenderDone が done へ進める)
      if (d.renderQueued && s.label === 'レンダー') {
        this.setStageState(s, 'queued', doneAt);
        continue;
      }
      this.setStageState(s, 'done', doneAt);
    }
  }

  /**
   * 夜間レンダーキューの成功通知を受け、該当ジョブの「レンダー」工程を done に進める。
   * 対象: 同一チャンネル・同一エピソード(またはショート)で renderQueued のまま成功終了したジョブ。
   */
  markRenderDone(dir: string, epId: string): void {
    const now = Date.now();
    for (const j of this.jobs.values()) {
      const d = j.detail;
      if (!d.renderQueued || d.dir !== dir) continue;
      const targetId = this.episodeIdOf(d) ?? this.shortIdOf(d);
      if (targetId !== epId) continue;
      const stage = d.stages.find((s) => s.label === 'レンダー');
      if (stage) this.setStageState(stage, 'done', now);
      d.renderQueued = undefined;
      this.touch(j);
    }
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
      const op = OPERATIONS[d.operation];
      if (op?.phases && d.phaseIndex !== undefined && d.phaseIndex < op.phases.length - 1) {
        this.advancePhase(internal, op.phases.length);
      } else {
        d.status = 'succeeded';
        this.completeStages(d); // 完了報告つきの成功時のみ全工程を完了に
        try {
          d.artifacts = collectArtifacts(this.root, d.dir, { episodeId: this.episodeIdOf(d), shortId: this.shortIdOf(d) });
        } catch {
          /* 表示用のため失敗は無視 */
        }
        this.maybeQueueOnSuccess(internal);
      }
    } else {
      // exit 0 でも <done> が無い=agentが途中でターンを終えた(例: サブエージェントの
      // 完了通知待ちで停止)。全工程doneに塗りつぶさず、途中終了として可視化する
      d.status = 'interrupted';
      d.error = '完了報告(<done>)が無いままプロセスが正常終了しました。工程の途中で停止した可能性があります。再試行で作り直せます。';
    }
    this.closeLogStream(internal); // failed/succeeded/interrupted のいずれも終了状態
    this.touch(internal);
    this.startNext(d.dir);
  }

  /** フェーズ末尾の<done>を受けて次フェーズを新規セッションで起動する。
   * 引き継ぎ先エピソードを特定できなければfailed(人間が「途中再開」で正す)。 */
  private advancePhase(internal: Internal, totalPhases: number): void {
    const d = internal.detail;
    _clearProgressCache(); // episode.jsonはこの直前に更新されている。古いキャッシュで解決しない
    const epId = this.episodeIdOf(d);
    if (!epId) {
      d.status = 'failed';
      d.error =
        'フェーズ完了を検知しましたが、引き継ぎ先のエピソードを特定できませんでした。エピソード詳細の「途中再開」で続行してください。';
      return;
    }
    d.request.episodeId = epId; // 以降のフェーズ・競合判定はこのIDで確定
    d.phaseIndex = (d.phaseIndex ?? 0) + 1;
    const note = `[factory-ui] フェーズ${d.phaseIndex + 1}/${totalPhases} を新規セッションで開始(エピソード: ${epId})`;
    this.appendLog(internal, note);
    this.emit('log', d.id, note);
    this.startJob(internal);
  }

  /**
   * render-check承認時のキュー登録。ジョブに対応するエピソードを解決できたときだけ登録する。
   * video-create以外(channel-refine経由の再開など)は episodeId 明示時のみ対象
   * (タイトルからの推定解決は誤登録し得るため video-create に限る)。
   */
  private tryEnqueueRender(internal: Internal): boolean {
    const d = internal.detail;
    if (!this.hooks.enqueueRender) return false;
    // short-create はショート(shorts/<shortId>)としてキュー登録する
    if (d.operation === 'short-create') {
      try {
        const shortId = findShortIdForJob(this.root, d.dir, d.request?.arg);
        if (!shortId) return false;
        return this.hooks.enqueueRender(d.dir, shortId, 'short');
      } catch {
        return false;
      }
    }
    if (d.operation !== 'video-create' && !d.request.episodeId) return false;
    try {
      const ep = findEpisodeProgress(this.root, d.dir, d.request, d.title, d.createdAt);
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
      // キュー登録は一発勝負の判定のため、キャッシュされた進捗(最大2秒古い。スキルが
      // episode.json を render_ready に更新した直後に <done> 終了するケース)で誤判定しない
      _clearProgressCache();
      const ep = findEpisodeProgress(this.root, d.dir, d.request, d.title, d.createdAt);
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
    return { ...s, episodeId: this.episodeIdOf(d), shortId: this.shortIdOf(d) };
  }

  /** ジョブに関連するショートID(short-createのみ。argのepId+formatIdからshort.jsonを突き合わせる) */
  private shortIdOf(d: JobDetail): string | undefined {
    if (d.operation !== 'short-create') return undefined;
    try {
      return findShortIdForJob(this.root, d.dir, d.request?.arg);
    } catch {
      return undefined;
    }
  }

  /** ジョブに関連するエピソードID。refine等はrequest指定、video-createは題材(タイトル)から解決する */
  private episodeIdOf(d: JobDetail): string | undefined {
    if (d.request?.episodeId) return d.request.episodeId;
    if (d.operation !== 'video-create') return undefined;
    try {
      return findEpisodeProgress(this.root, d.dir, d.request, d.title, d.createdAt)?.episodeId;
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

  /**
   * claude stdoutの1行ごとに呼ばれるホットパス。同期I/O(appendFileSync)はイベントループを
   * ブロックするため使わない: (a) メモリ上のlogTailへpush(上限MAX_LOG_READ_LINESで先頭を捨てる)、
   * (b) 遅延生成した非同期のWriteStreamへwrite。ストリームはジョブ終了(onExit/cancel)や
   * remove/clearFinishedでcloseLogStreamにより閉じる(resumeで再開したジョブは次のappendLogで
   * 遅延再生成される)。
   */
  /** @returns スタンプ済みの行(呼び出し側はlive配信にもこの戻り値を使い、全経路の文字列を一致させる) */
  private appendLog(internal: Internal, line: string): string {
    // claude CLIのstream-json行はtimestampがnullのまま出力されるため、永続化直前に
    // 壁時計時刻を注入する(工程別所要時間の計測用)。以降はスタンプ済みの行をメモリ上の
    // logTail・ファイルの両方へ同じ内容で反映する。
    const stamped = stampLogLine(line, Date.now());
    // 初回(このプロセスで最初のappendLog)は空配列ではなくファイルの既存末尾でシードする。
    // 空配列で始めるとreadLogが即メモリ経由に切り替わり、restore→resumeしたジョブの
    // resume前の履歴が返却窓から消えてしまう(新規ジョブはファイルが無いので空配列になる)
    const tail =
      internal.logTail ??
      (internal.logTail = this.readLogTailFromFile(internal.detail.id, MAX_LOG_READ_LINES));
    tail.push(stamped);
    if (tail.length > MAX_LOG_READ_LINES) tail.splice(0, tail.length - MAX_LOG_READ_LINES);
    if (!internal.logStream) {
      const dir = this.jobDir(internal.detail.id);
      internal.logStream = fs.createWriteStream(path.join(dir, 'log.jsonl'), { flags: 'a' });
      // ディスクフル等の書き込みエラーで未捕捉例外がプロセスを落とさないようにする
      // (ログ永続化は失われてもジョブ管理本体は継続する。メモリ上のlogTailは生きている)
      internal.logStream.on('error', (err) => {
        console.error(`[jobs] log write error (job ${internal.detail.id}):`, err);
      });
    }
    internal.logStream.write(stamped + '\n');
    return stamped;
  }

  /** ジョブの永続ログストリームを閉じ、参照を消す(resume等で同じジョブが再度appendLogすれば遅延再生成される) */
  private closeLogStream(internal: Internal): void {
    internal.logStream?.end();
    internal.logStream = undefined;
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
      return { ...d, episodeId: this.episodeIdOf(d), shortId: this.shortIdOf(d) };
    }
    try {
      const ep = findEpisodeProgress(this.root, d.dir, d.request, d.title, d.createdAt);
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
  isShort = false,
): string {
  const fb = feedback?.trim();
  if (gate.kind === 'render-check') {
    if (optionId === 'revise') {
      return `レンダー前の目視確認で修正依頼がありました。次のフィードバックを反映し、修正が終わったら再度 kind:"render-check" のゲートを発行して確認を求めてください: ${fb || '(記載なし)'}`;
    }
    if (queuedForRender && isShort) {
      let d =
        `Studio確認を承認しました(${opt.label})。ショートは夜間レンダーキューに登録済みです。` +
        `レンダーは実行せず、まず工程6「公開準備」— <stage>公開準備</stage> を出したうえで ` +
        `/short-publish の手順(.claude/skills/short-publish/SKILL.md)に従い shorts/<shortId>/publish/metadata.json を生成し、` +
        `npm run validate:metadata shorts/<shortId> がOKになるまで直してください。` +
        `そのうえで完了処理 — short.json の status を "queued" へ更新(studio_checked を経て)、` +
        `git commit — を行って <done> で終了してください。夜間レンダー成功時の status: "rendered" 更新はサーバーが行います。`;
      if (fb) d += ` あわせて次のフィードバックを反映してください: ${fb}`;
      return d;
    }
    if (queuedForRender) {
      let d =
        `レンダー前の一括確認を承認しました(${opt.label})。エピソードは夜間レンダーキューに登録済みです。` +
        `レンダーは実行せず、\`npm run finalize episodes/<epId> -- --hours <実測> --images <実測>\` を実行して完了処理` +
        `(status更新・metrics・backlog消し込み・git commit)を一括で行い、<done> で終了してください。`;
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
