import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JobDetail } from '../../shared/types';
import { JobManager, type SpawnClaude } from '../jobs';

// FakeSpawn: テストが stdout に流す行を制御し、exitを手動発火する
class FakeProc {
  stdout = new Readable({ read() {} });
  private exitCbs: ((c: number) => void)[] = [];
  killed = false;
  args: string[];
  cwd: string;
  constructor(args: string[], cwd: string) {
    this.args = args;
    this.cwd = cwd;
  }
  onExit(cb: (c: number) => void) {
    this.exitCbs.push(cb);
  }
  kill() {
    this.killed = true;
    this.emitExit(143);
  }
  push(line: string) {
    this.stdout.push(line + '\n');
  }
  emitExit(code: number) {
    this.exitCbs.forEach((cb) => cb(code));
  }
}

function initLine(sid: string, cwd: string) {
  return JSON.stringify({ type: 'system', subtype: 'init', session_id: sid, cwd });
}
function textLine(t: string) {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
}
function resultLine(sid: string, result: string, subtype = 'success') {
  return JSON.stringify({ type: 'result', subtype, session_id: sid, result });
}
const GATE = '<gate>{"gateId":"g1","question":"素材を承認?","options":[{"id":"yes","label":"承認","description":""}],"context":"5枚生成"}</gate>';
const DONE = '<done>全工程完了</done>';

describe('JobManager', () => {
  let root: string;
  let procs: FakeProc[];
  let spawnFn: SpawnClaude;
  let m: JobManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-jobs-'));
    fs.mkdirSync(path.join(root, 'ch1'));
    fs.writeFileSync(path.join(root, 'ch1', '.channel-system.json'), JSON.stringify({ channelId: 'ch1' }));
    procs = [];
    spawnFn = (args, opts) => {
      const p = new FakeProc(args, opts.cwd);
      procs.push(p);
      return { stdout: p.stdout, onExit: (cb) => p.onExit(cb), kill: () => p.kill() };
    };
    m = new JobManager(root, spawnFn);
  });

  it('create は running ジョブを返し list に載る。claude -p が対象cwdでspawnされる', () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: '織田信長' });
    expect(j.status).toBe('running');
    expect(j.dir).toBe('ch1');
    expect(j.operation).toBe('video-create');
    expect(m.list().map((x) => x.id)).toContain(j.id);
    expect(procs[0].cwd).toBe(path.join(root, 'ch1'));
    expect(procs[0].args[0]).toBe('-p'); // claude -p ...
  });

  it('不正 operation / 不正 dir は throw', () => {
    expect(() => m.create({ dir: 'ch1', operation: 'nope', arg: 'x' })).toThrow();
    expect(() => m.create({ dir: '../etc', operation: 'theme-scout', arg: '' })).toThrow();
    expect(() => m.create({ dir: 'missing', operation: 'theme-scout', arg: '' })).toThrow();
  });

  it('init 行で sessionId を記録する', () => {
    const j = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    procs[0].push(initLine('sid-1', path.join(root, 'ch1')));
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(m.get(j.id)!.sessionId).toBe('sid-1');
        resolve();
      }, 20);
    });
  });

  it('gate 行で status=awaiting_gate + gate イベント + gate.json 生成', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    const gates: string[] = [];
    m.on('gate', (id: string) => gates.push(id));
    procs[0].push(initLine('sid-2', path.join(root, 'ch1')));
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 30));
    const d = m.get(j.id)!;
    expect(d.status).toBe('awaiting_gate');
    expect(d.gate?.gateId).toBe('g1');
    expect(gates).toContain(j.id);
    expect(fs.existsSync(path.join(root, 'factory-ui', 'jobs', j.id, 'gate.json'))).toBe(true);
  });

  it('respondGate は --resume <sessionId> 付きで再spawnし running に戻る', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sid-3', path.join(root, 'ch1')));
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 30));
    m.respondGate(j.id, 'yes');
    expect(procs.length).toBe(2);
    expect(procs[1].args).toContain('--resume');
    expect(procs[1].args).toContain('sid-3');
    expect(m.get(j.id)!.status).toBe('running');
  });

  it('result 成功(<done>つき)で succeeded、exit≠0 で failed', async () => {
    const j = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    procs[0].push(initLine('s', path.join(root, 'ch1')));
    procs[0].push(resultLine('s', `採点まで実施 ${DONE}`));
    await new Promise((r) => setTimeout(r, 20)); // 実プロセス同様、stdout処理後にclose
    procs[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get(j.id)!.status).toBe('succeeded');

    const j2 = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    procs[1].emitExit(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get(j2.id)!.status).toBe('failed');
  });

  it('cancel は kill して cancelled にする', async () => {
    const j = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    m.cancel(j.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(procs[0].killed).toBe(true);
    expect(m.get(j.id)!.status).toBe('cancelled');
  });

  it('restore は永続 running を interrupted にする', () => {
    const j = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    // state.json は create で書かれている前提。新しい JobManager で復元
    const m2 = new JobManager(root, spawnFn);
    m2.restore();
    expect(m2.get(j.id)!.status).toBe('interrupted');
  });

  it('rate_limit 行で rate-limit イベントを発火', async () => {
    const j = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    const seen: number[] = [];
    m.on('rate-limit', (info: { utilization: number }) => seen.push(info.utilization));
    procs[0].push(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { utilization: 0.91, rateLimitType: 'seven_day', resetsAt: 1, status: 'allowed_warning' } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toContain(0.91);
    expect(j).toBeTruthy();
  });

  it('存在しない id への get は undefined、cancel/respondGate は throw', () => {
    expect(m.get('zzz')).toBeUndefined();
    expect(() => m.cancel('zzz')).toThrow();
    expect(() => m.respondGate('zzz', 'yes')).toThrow();
  });

  // ---- Task 5: 多段ゲート・待ち中キャンセル・不正optionId・復元 ----

  it('多段ゲート: gate→respond→gate→respond→succeeded', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sA', path.join(root, 'ch1')));
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 20));
    expect(m.get(j.id)!.status).toBe('awaiting_gate');
    m.respondGate(j.id, 'yes'); // → procs[1]
    procs[1].push(initLine('sA', path.join(root, 'ch1')));
    procs[1].push(textLine(GATE.replace('g1', 'g2')));
    await new Promise((r) => setTimeout(r, 20));
    expect(m.get(j.id)!.status).toBe('awaiting_gate');
    expect(m.get(j.id)!.gate?.gateId).toBe('g2');
    m.respondGate(j.id, 'yes'); // → procs[2]
    procs[2].push(resultLine('sA', DONE));
    await new Promise((r) => setTimeout(r, 20));
    procs[2].emitExit(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(m.get(j.id)!.status).toBe('succeeded');
  });

  it('awaiting_gate 中の cancel は cancelled にする', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sB', path.join(root, 'ch1')));
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 20));
    expect(m.get(j.id)!.status).toBe('awaiting_gate');
    m.cancel(j.id);
    expect(m.get(j.id)!.status).toBe('cancelled');
  });

  it('respondGate は不正 optionId を拒否する', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sC', path.join(root, 'ch1')));
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 20));
    expect(() => m.respondGate(j.id, 'nonexistent')).toThrow();
    expect(m.get(j.id)!.status).toBe('awaiting_gate'); // 状態は保持
  });

  it('respondGate 後の旧プロセス遅延 exit は状態を壊さない(世代ガード)', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sE', path.join(root, 'ch1')));
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 20));
    m.respondGate(j.id, 'yes'); // procs[1] 開始、procs[0] は旧世代
    procs[0].emitExit(0); // 旧プロセスの遅延 exit
    await new Promise((r) => setTimeout(r, 20));
    expect(m.get(j.id)!.status).toBe('running'); // succeeded に化けない
  });

  it('respondGate は応答済みゲートの gate.json を消す', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sF', path.join(root, 'ch1')));
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 20));
    const gatePath = path.join(root, 'factory-ui', 'jobs', j.id, 'gate.json');
    expect(fs.existsSync(gatePath)).toBe(true);
    m.respondGate(j.id, 'yes');
    expect(fs.existsSync(gatePath)).toBe(false);
  });

  it('シンボリックリンクで root 外を指す dir は throw(realpath封じ込め)', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-out-'));
    fs.writeFileSync(path.join(outside, '.channel-system.json'), '{}');
    fs.symlinkSync(outside, path.join(root, 'evil'));
    expect(() => m.create({ dir: 'evil', operation: 'theme-scout', arg: '' })).toThrow();
  });

  it('同一チャンネルの同時実行は2本目が queued になる(throwしない)', () => {
    m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    const j2 = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    expect(j2.status).toBe('queued');
  });

  // ---- 並列実行: video-create同士は干渉しない ----

  it('video-create同士(episodeId違い)は同一チャンネルで並列実行できる', () => {
    m.create({ dir: 'ch1', operation: 'video-create', arg: '', episodeId: 'ep001-a' });
    const j2 = m.create({ dir: 'ch1', operation: 'video-create', arg: '', episodeId: 'ep002-b' });
    expect(m.get(j2.id)!.status).toBe('running');
    expect(procs.length).toBe(2);
  });

  it('video-create同士(episodeId未指定=新規制作)も並列実行できる', () => {
    m.create({ dir: 'ch1', operation: 'video-create', arg: '題材A' });
    const j2 = m.create({ dir: 'ch1', operation: 'video-create', arg: '題材B' });
    expect(m.get(j2.id)!.status).toBe('running');
    expect(procs.length).toBe(2);
  });

  it('同じepisodeIdを対象とするvideo-create同士は排他(2本目はqueued)', () => {
    m.create({ dir: 'ch1', operation: 'video-create', arg: '', episodeId: 'ep001-a' });
    const j2 = m.create({ dir: 'ch1', operation: 'video-create', arg: '', episodeId: 'ep001-a' });
    expect(m.get(j2.id)!.status).toBe('queued');
    expect(procs.length).toBe(1);
  });

  it('video-create稼働中の非video-create操作はqueuedになる', () => {
    m.create({ dir: 'ch1', operation: 'video-create', arg: '', episodeId: 'ep001-a' });
    const j2 = m.create({ dir: 'ch1', operation: 'ask', arg: '質問' });
    expect(m.get(j2.id)!.status).toBe('queued');
  });

  it('非video-create稼働中はvideo-createもqueuedになる', () => {
    m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    const j2 = m.create({ dir: 'ch1', operation: 'video-create', arg: '', episodeId: 'ep001-a' });
    expect(m.get(j2.id)!.status).toBe('queued');
  });

  it('先行ジョブ完了時、起動可能なqueuedがまとめて起動する(排他のものは残る)', async () => {
    const j1 = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    const q1 = m.create({ dir: 'ch1', operation: 'video-create', arg: '', episodeId: 'ep001-a' });
    const q2 = m.create({ dir: 'ch1', operation: 'video-create', arg: '', episodeId: 'ep002-b' });
    const q3 = m.create({ dir: 'ch1', operation: 'video-create', arg: '', episodeId: 'ep001-a' }); // q1と排他
    procs[0].push(initLine('sP', path.join(root, 'ch1')));
    procs[0].push(resultLine('sP', DONE));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get(j1.id)!.status).toBe('succeeded');
    expect(m.get(q1.id)!.status).toBe('running');
    expect(m.get(q2.id)!.status).toBe('running'); // ep違い=並列起動
    expect(m.get(q3.id)!.status).toBe('queued');  // ep001はq1が使用中
    expect(procs.length).toBe(3);
  });

  it('cancel 後に旧プロセスのゲート行が届いても cancelled のまま復活しない', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sH', path.join(root, 'ch1')));
    await new Promise((r) => setTimeout(r, 20));
    m.cancel(j.id);
    procs[0].push(textLine(GATE)); // 旧プロセスからの残留ゲート行
    await new Promise((r) => setTimeout(r, 20));
    const d = m.get(j.id)!;
    expect(d.status).toBe('cancelled');
    expect(d.gate).toBeUndefined();
  });

  it('ステージレール: 起動で先頭active、ゲートで前進、成功で全done', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    let d = m.get(j.id)!;
    expect(d.stages.length).toBeGreaterThan(1);
    expect(d.stages[0]!.state).toBe('active');
    expect(d.stages[1]!.state).toBe('pending');
    procs[0].push(initLine('sG', path.join(root, 'ch1')));
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 20));
    d = m.get(j.id)!;
    expect(d.stages[0]!.state).toBe('done');
    expect(d.stages[1]!.state).toBe('active');
    m.respondGate(j.id, 'yes');
    procs[1].push(resultLine('sG', DONE));
    await new Promise((r) => setTimeout(r, 20));
    procs[1].emitExit(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(m.get(j.id)!.stages.every((s) => s.state === 'done')).toBe(true);
  });

  // ---- 完了マーカー(<done>)プロトコル: exit 0 を鵜呑みにしない ----
  // 実バグ: メインagentがサブエージェントをバックグラウンド起動して「通知待ち」でターンを
  // 終了 → -p では正常終了扱い → 全ステージdone表示、という途中死の隠蔽が起きた。

  it('exit 0 でも <done> が無ければ interrupted(全ステージdoneに塗りつぶさない)', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'クレオパトラ' });
    procs[0].push(initLine('sI', path.join(root, 'ch1')));
    procs[0].push(textLine('fact-checkerに委譲しました。完了通知を待って次工程へ進めます。'));
    procs[0].push(resultLine('sI', '委譲しました。完了を待ちます。'));
    procs[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    const d = m.get(j.id)!;
    expect(d.status).toBe('interrupted');
    expect(d.error).toBeTruthy();
    expect(d.stages.every((s) => s.state === 'done')).toBe(false);
    expect(d.stages[0]!.state).toBe('active'); // ゲート未到達なので先頭のまま
  });

  it('assistant text 中の <done> でも succeeded になる(resultに出ない場合のフォールバック)', async () => {
    const j = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    procs[0].push(initLine('sJ', path.join(root, 'ch1')));
    procs[0].push(textLine(`ネタ帳を10件補充しました。${DONE}`));
    procs[0].push(resultLine('sJ', 'ネタ帳を10件補充しました。'));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get(j.id)!.status).toBe('succeeded');
  });

  it('ジョブのプロンプトに <done> 規約と同期実行の規律が含まれる', () => {
    m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    const prompt = procs[0].args[1]!; // ['-p', prompt, ...]
    expect(prompt).toContain('<done>');
    expect(prompt).toContain('run_in_background');
  });

  // ---- 工程マーカー(<stage>)プロトコル: ゲートが無くても進捗バーが前進する ----
  // 実バグ: 工程前進がゲート到達時のみだったため、ログ上は後工程まで進んでいるのに
  // 進捗バーが先頭工程のまま止まって見えた。

  it('<stage>マーカーで該当工程がactiveになり、前工程はdoneになる', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sS', path.join(root, 'ch1')));
    procs[0].push(textLine('調査が終わりました。<stage>絵コンテ</stage> 映像設計に入ります。'));
    await new Promise((r) => setTimeout(r, 20));
    const d = m.get(j.id)!;
    const labels = d.stages.map((s) => `${s.label}:${s.state}`);
    expect(labels).toContain('絵コンテ:active');
    expect(d.stages[0]!.state).toBe('done'); // 調査
    expect(d.stages[1]!.state).toBe('done'); // 台本
    expect(d.stages[4]!.state).toBe('pending'); // 素材
  });

  it('<stage>の未知ラベル・後退は無視する', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sS2', path.join(root, 'ch1')));
    procs[0].push(textLine('<stage>音声</stage>'));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].push(textLine('<stage>存在しない工程</stage>'));
    procs[0].push(textLine('<stage>調査</stage>')); // 後退
    await new Promise((r) => setTimeout(r, 20));
    const d = m.get(j.id)!;
    expect(d.stages[2]!.state).toBe('active'); // 音声のまま
    expect(d.stages[0]!.state).toBe('done');
  });

  it('ジョブのプロンプトに <stage> 規約と工程ラベル一覧が含まれる', () => {
    m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    const prompt = procs[0].args[1]!;
    expect(prompt).toContain('<stage>');
    expect(prompt).toContain('絵コンテ');
  });

  it('restore は awaiting_gate を保持する(interrupted にしない)', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sD', path.join(root, 'ch1')));
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 20));
    const m2 = new JobManager(root, spawnFn);
    m2.restore();
    expect(m2.get(j.id)!.status).toBe('awaiting_gate');
    expect(m2.get(j.id)!.gate?.gateId).toBe('g1');
  });

  // ---- コードレビュー指摘の回帰テスト(Important-1/2/3) ----

  it('Important-1: 同一メッセージの<stage>と<gate>が同居してもstageが無視されない', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sN', path.join(root, 'ch1')));
    procs[0].push(textLine('<stage>素材</stage> 確認お願いします ' + GATE));
    await new Promise((r) => setTimeout(r, 20));
    const d = m.get(j.id)!;
    expect(d.status).toBe('awaiting_gate'); // ゲートは開く
    const labels = Object.fromEntries(d.stages.map((s) => [s.label, s.state]));
    expect(labels['素材']).toBe('done'); // <stage>で素材まで前進し、openGateのadvanceStageでさらに1つ進む
    expect(labels['実装']).toBe('active');
  });

  it('Important-2: sawDoneはプロセス世代をまたいで残らない(旧世代の<done>で新世代が誤succeededにならない)', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sO', path.join(root, 'ch1')));
    procs[0].push(textLine('作業中です ' + DONE)); // 旧世代のtextに<done>が混入
    procs[0].push(textLine(GATE)); // ゲートで停止
    await new Promise((r) => setTimeout(r, 20));
    expect(m.get(j.id)!.status).toBe('awaiting_gate');

    m.respondGate(j.id, 'yes'); // procs[1] = 新世代
    procs[1].push(resultLine('sO', '続きの作業をしています。')); // <done>無し
    await new Promise((r) => setTimeout(r, 20));
    procs[1].emitExit(0); // exit 0 だが<done>無し
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get(j.id)!.status).toBe('interrupted'); // 旧世代のsawDoneに引きずられてsucceededにならない
  });

  it('Important-3: 最終工程のゲート後(active無し)でも<stage>の後退ガードが効く', async () => {
    const j = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    procs[0].push(initLine('sP', path.join(root, 'ch1')));
    procs[0].push(textLine('<stage>採点</stage>'));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].push(textLine(GATE)); // ゲート到達で採点がdoneになり、次工程が無いのでactiveが消える
    await new Promise((r) => setTimeout(r, 20));
    let d = m.get(j.id)!;
    expect(d.stages[0]!.state).toBe('done'); // 探索
    expect(d.stages[1]!.state).toBe('done'); // 採点

    m.respondGate(j.id, 'yes'); // procs[1]、statusはrunningに戻る
    procs[1].push(textLine('<stage>探索</stage>')); // 後退マーカー。無視されるべき
    await new Promise((r) => setTimeout(r, 20));
    d = m.get(j.id)!;
    expect(d.stages[0]!.state).toBe('done'); // 巻き戻らない
    expect(d.stages[1]!.state).toBe('done'); // 巻き戻らない
  });

  // ---- 型拡張: mode/model/effort/request の既定値と永続化互換 ----

  it('create は mode=manual, model=opus, effort=xhigh, request.arg を既定で持つ', () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: '織田信長' });
    const d = m.get(j.id)!;
    expect(d.mode).toBe('manual');
    expect(d.model).toBe('opus');
    expect(d.effort).toBe('xhigh');
    expect(d.request).toEqual({ arg: '織田信長', durationSec: undefined, episodeId: undefined });
  });

  it('restore は旧state.json(新フィールド欠落)を既定値で補完する', () => {
    const dir = path.join(root, 'factory-ui', 'jobs', 'old-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        id: 'old-1', dir: 'ch1', operation: 'video-create', title: 'x',
        status: 'interrupted', createdAt: 1, updatedAt: 1, stages: [], artifacts: [],
      }),
    );
    m.restore();
    const d = m.get('old-1')!;
    expect(d.mode).toBe('manual');
    expect(d.model).toBe('opus');
    expect(d.effort).toBe('xhigh');
    expect(d.request).toEqual({ arg: '' });
  });

  // ---- モデル/effort: spawn引数と検証 ----

  function argAfter(args: string[], flag: string): string | undefined {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  }

  it('既定で --model opus --effort xhigh が付く。指定時はその値', () => {
    m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    expect(argAfter(procs[0].args, '--model')).toBe('opus');
    expect(argAfter(procs[0].args, '--effort')).toBe('xhigh');
    fs.mkdirSync(path.join(root, 'ch2'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ch2', '.channel-system.json'), '{}');
    m.create({ dir: 'ch2', operation: 'theme-scout', arg: '', model: 'sonnet', effort: 'high' });
    expect(argAfter(procs[1].args, '--model')).toBe('sonnet');
    expect(argAfter(procs[1].args, '--effort')).toBe('high');
  });

  it('ゲート応答の再spawnにも同じ --model/--effort が引き継がれる', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', model: 'fable', effort: 'high' });
    procs[0].push(initLine('sM', path.join(root, 'ch1')));
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 30));
    m.respondGate(j.id, 'yes');
    expect(argAfter(procs[1].args, '--model')).toBe('fable');
    expect(argAfter(procs[1].args, '--effort')).toBe('high');
  });

  it('不正な model/effort/mode/durationSec は throw', () => {
    expect(() => m.create({ dir: 'ch1', operation: 'theme-scout', arg: '', model: 'gpt-5' })).toThrow(/model/);
    expect(() => m.create({ dir: 'ch1', operation: 'theme-scout', arg: '', effort: 'ultra' })).toThrow(/effort/);
    expect(() => m.create({ dir: 'ch1', operation: 'theme-scout', arg: '', mode: 'yolo' as never })).toThrow(/mode/);
    expect(() => m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', durationSec: 5 })).toThrow(/durationSec/);
    expect(() => m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', durationSec: 4000 })).toThrow(/durationSec/);
  });

  it('needsArg かつ argOptional でないオペは空引数を拒否する', () => {
    expect(() => m.create({ dir: 'ch1', operation: 'channel-refine', arg: '  ' })).toThrow(/arg/);
    // video-create は argOptional なので空でも起動できる
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: '' });
    expect(m.get(j.id)!.title).toBe('おまかせ(ネタ帳から自動選定)');
  });

  it('mode/durationSec/episodeId がプロンプトに反映される', () => {
    m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', mode: 'auto', durationSec: 180 });
    const prompt = procs[0].args[1]!;
    expect(prompt).toContain('オート');
    expect(prompt).toContain('180');
  });

  // ---- レビュー指摘: askの読み取り専用をツール制限で強制 ----

  it('ask ジョブは spawn引数に --disallowedTools でWrite/Edit/NotebookEdit/Bashを禁止する', () => {
    m.create({ dir: 'ch1', operation: 'ask', arg: '質問です' });
    expect(argAfter(procs[0].args, '--disallowedTools')).toBe('Write,Edit,NotebookEdit,Bash');
  });

  it('video-create には --disallowedTools が付かない', () => {
    m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    expect(procs[0].args).not.toContain('--disallowedTools');
  });

  it('askのゲート応答再spawnにも --disallowedTools が引き継がれる', async () => {
    // ask は stages=['回答'] の1工程なので、gateを直接流し込んで検証する
    const j = m.create({ dir: 'ch1', operation: 'ask', arg: '質問です' });
    procs[0].push(initLine('sAsk', path.join(root, 'ch1')));
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 30));
    m.respondGate(j.id, 'yes');
    expect(argAfter(procs[1].args, '--disallowedTools')).toBe('Write,Edit,NotebookEdit,Bash');
  });

  // ---- FIFOキュー: 1チャンネル1アクティブ+待機列 ----

  it('チャンネル使用中の create は queued になり、先行ジョブ完了で自動起動する', async () => {
    const j1 = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    const j2 = m.create({ dir: 'ch1', operation: 'video-create', arg: '次の動画' });
    expect(m.get(j2.id)!.status).toBe('queued');
    expect(procs.length).toBe(1); // queued はまだspawnされない
    procs[0].push(initLine('sQ', path.join(root, 'ch1')));
    procs[0].push(resultLine('sQ', DONE));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get(j1.id)!.status).toBe('succeeded');
    expect(m.get(j2.id)!.status).toBe('running');
    expect(procs.length).toBe(2);
    expect(procs[1].args[1]).toContain('/video-create 次の動画');
  });

  it('queued は作成順(FIFO)で起動される', async () => {
    m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    const q1 = m.create({ dir: 'ch1', operation: 'ask', arg: '先の質問' });
    const q2 = m.create({ dir: 'ch1', operation: 'ask', arg: '後の質問' });
    m.cancel([...(m.list())].find((j) => j.status === 'running')!.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(m.get(q1.id)!.status).toBe('running');
    expect(m.get(q2.id)!.status).toBe('queued');
  });

  it('queued の cancel はプロセス無しで cancelled になる', () => {
    m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    const q = m.create({ dir: 'ch1', operation: 'ask', arg: 'q' });
    m.cancel(q.id);
    expect(m.get(q.id)!.status).toBe('cancelled');
    expect(procs.length).toBe(1);
  });

  it('restore は queued を保持し、チャンネルが空いていれば起動する', () => {
    const dir = path.join(root, 'factory-ui', 'jobs', 'q-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        id: 'q-1', dir: 'ch1', operation: 'theme-scout', title: 'ネタ帳を補充',
        status: 'queued', createdAt: 1, updatedAt: 1, stages: [], artifacts: [],
        mode: 'manual', model: 'opus', effort: 'xhigh', request: { arg: '' },
      }),
    );
    m.restore();
    expect(m.get('q-1')!.status).toBe('running');
    expect(procs.length).toBe(1);
  });

  // ---- resume: 中断・失敗・キャンセル済みジョブの途中再開 ----

  async function makeInterrupted(): Promise<string> {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sR', path.join(root, 'ch1')));
    procs[0].push(resultLine('sR', '途中')); // <done>なし
    await new Promise((r) => setTimeout(r, 20));
    procs[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get(j.id)!.status).toBe('interrupted');
    return j.id;
  }

  it('interrupted を resume すると --resume <sid> + 再開プロンプト + model/effort で再spawnする', async () => {
    const id = await makeInterrupted();
    const d = m.resume(id);
    expect(d.status).toBe('running');
    expect(d.error).toBeUndefined();
    const args = procs[1].args;
    expect(args).toContain('--resume');
    expect(args).toContain('sR');
    expect(args[args.indexOf('sR') + 1]).toContain('中断したジョブの再開');
    expect(args).toContain('--model');
  });

  it('resume後に <done> 付きで終われば succeeded になる', async () => {
    const id = await makeInterrupted();
    m.resume(id);
    procs[1].push(resultLine('sR', DONE));
    await new Promise((r) => setTimeout(r, 20));
    procs[1].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get(id)!.status).toBe('succeeded');
  });

  it('sessionId の無いジョブの resume は sessionId を含むエラーで throw', () => {
    const j = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    m.cancel(j.id); // initを流していないので sessionId 無し
    expect(() => m.resume(j.id)).toThrow(/sessionId/);
  });

  it('running のジョブや使用中チャンネルへの resume は throw', async () => {
    const id = await makeInterrupted();
    const j2 = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    expect(() => m.resume(id)).toThrow(/active job/); // ch1 は j2 が使用中
    expect(() => m.resume(j2.id)).toThrow(/not resumable/);
  });

  // ---- ゲートフィードバック + render-check承認 + モード自動応答 ----

  const RENDER_GATE =
    '<gate>{"gateId":"rc1","kind":"render-check","question":"レンダー前の目視確認","options":[{"id":"approve","label":"承認してレンダー","description":""},{"id":"revise","label":"修正を依頼","description":""}],"context":"Studioで確認してください"}</gate>';

  it('feedback付きゲート応答は決定文にフィードバックが入る', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sF', path.join(root, 'ch1')));
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 30));
    m.respondGate(j.id, 'yes', '2枚目の画像を差し替えて');
    const decision = procs[1].args[procs[1].args.indexOf('sF') + 1]!;
    expect(decision).toContain('2枚目の画像を差し替えて');
  });

  it('render-checkをapproveすると renderApproved=true、決定文はレンダー実行指示', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sRC', path.join(root, 'ch1')));
    procs[0].push(textLine(RENDER_GATE));
    await new Promise((r) => setTimeout(r, 30));
    m.respondGate(j.id, 'approve');
    expect(m.get(j.id)!.renderApproved).toBe(true);
    const decision = procs[1].args[procs[1].args.indexOf('sRC') + 1]!;
    expect(decision).toContain('レンダーを実行');
  });

  it('render-checkをreviseすると renderApproved は立たず、決定文に再ゲート指示とフィードバックが入る', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sRV', path.join(root, 'ch1')));
    procs[0].push(textLine(RENDER_GATE));
    await new Promise((r) => setTimeout(r, 30));
    m.respondGate(j.id, 'revise', '字幕がはみ出している');
    expect(m.get(j.id)!.renderApproved).toBeFalsy();
    const decision = procs[1].args[procs[1].args.indexOf('sRV') + 1]!;
    expect(decision).toContain('字幕がはみ出している');
    expect(decision).toContain('render-check');
  });

  it('auto モードはゲートを先頭選択肢で自動応答する', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', mode: 'auto' });
    procs[0].push(initLine('sA', path.join(root, 'ch1')));
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 50)); // setImmediate分の余裕
    expect(m.get(j.id)!.status).toBe('running');
    expect(procs.length).toBe(2); // 自動応答で再spawn済み
  });

  it('semi モードは通常ゲートを自動応答し、render-check では停止する', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', mode: 'semi' });
    procs[0].push(initLine('sS3', path.join(root, 'ch1')));
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 50));
    expect(m.get(j.id)!.status).toBe('running'); // 通常ゲートは自動応答
    procs[1].push(textLine(RENDER_GATE));
    await new Promise((r) => setTimeout(r, 50));
    expect(m.get(j.id)!.status).toBe('awaiting_gate'); // render-checkは人間待ち
    expect(m.get(j.id)!.gate?.kind).toBe('render-check');
  });

  it('自動応答が上限(20回)に達したら interrupted にする', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', mode: 'auto' });
    procs[0].push(initLine('sL', path.join(root, 'ch1')));
    for (let i = 0; i < 21; i++) {
      procs[procs.length - 1].push(textLine(GATE));
      await new Promise((r) => setTimeout(r, 15));
      if (m.get(j.id)!.status !== 'running') break;
    }
    const d = m.get(j.id)!;
    expect(d.status).toBe('interrupted');
    expect(d.error).toContain('自動');
  });

  // ---- レビュー指摘(Task 7フォローアップ): resumeリセット/gateId再確認/reviseの空フィードバック ----

  it('Important-1: 自動応答上限で interrupted になったジョブを resume すると暴走保護カウンタがリセットされ、次のゲートも自動応答されて前進する', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', mode: 'auto' });
    procs[0].push(initLine('sL2', path.join(root, 'ch1')));
    for (let i = 0; i < 21; i++) {
      procs[procs.length - 1].push(textLine(GATE));
      await new Promise((r) => setTimeout(r, 15));
      if (m.get(j.id)!.status !== 'running') break;
    }
    expect(m.get(j.id)!.status).toBe('interrupted'); // 前提: 上限到達

    m.resume(j.id);
    const idx = procs.length - 1;
    procs[idx].push(textLine(GATE)); // resume直後の最初のゲート
    await new Promise((r) => setTimeout(r, 50));
    const d = m.get(j.id)!;
    expect(d.status).toBe('running'); // カウンタがリセットされ、即座にinterruptedへ戻らない
    expect(procs.length).toBe(idx + 2); // 自動応答で再spawnされている
  });

  it('Important-2a: autoモードでゲートが開いた直後(自動応答のsetImmediate発火前)にcancelすると、cancelledのまま新プロセスをspawnしない', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', mode: 'auto' });
    procs[0].push(initLine('sPC', path.join(root, 'ch1')));
    await new Promise((r) => setTimeout(r, 20)); // sessionId反映を待つ
    procs[0].push(textLine(GATE));
    // ストリームの 'data' ハンドラ(process.nextTick経由)だけを流し、
    // maybeAutoRespond が予約する setImmediate はまだ発火させない
    await Promise.resolve();
    await Promise.resolve();
    expect(m.get(j.id)!.status).toBe('awaiting_gate'); // ゲートは開いている(自動応答はまだ)
    m.cancel(j.id);
    await new Promise((r) => setTimeout(r, 50));
    const d = m.get(j.id)!;
    expect(d.status).toBe('cancelled');
    expect(procs.length).toBe(1); // 自動応答による再spawnは起きない
  });

  it('Important-2b: sessionId未取得のままゲートが来たら awaiting_gate のまま人間の応答を待ち、自動応答しない', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', mode: 'auto' });
    // init 行を流さない → sessionId 未設定のまま
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 50));
    const d = m.get(j.id)!;
    expect(d.status).toBe('awaiting_gate');
    expect(procs.length).toBe(1); // 自動応答の再spawnは起きない
  });

  it('Minor-2: render-checkのrevise応答をfeedback空白のみで送ると決定文に「(記載なし)」が入る', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sRV2', path.join(root, 'ch1')));
    procs[0].push(textLine(RENDER_GATE));
    await new Promise((r) => setTimeout(r, 30));
    m.respondGate(j.id, 'revise', '   '); // trimすると空文字になるフィードバック
    const decision = procs[1].args[procs[1].args.indexOf('sRV2') + 1]!;
    expect(decision).toContain('(記載なし)');
  });

  // ---- レンダーバックストップ: 目視確認なしのレンダー突入を強制停止 ----

  it('manual: renderApproved なしの <stage>レンダー</stage> でプロセスを止め合成render-checkゲートを開く', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sB', path.join(root, 'ch1')));
    procs[0].push(textLine('実装が終わりました。<stage>レンダー</stage> レンダリングを開始します。'));
    await new Promise((r) => setTimeout(r, 30));
    const d = m.get(j.id)!;
    expect(d.status).toBe('awaiting_gate');
    expect(d.gate?.kind).toBe('render-check');
    expect(d.gate?.gateId.startsWith('render-backstop-')).toBe(true);
    expect(d.gate?.options.map((o) => o.id)).toEqual(['approve', 'revise']);
    expect(procs[0].killed).toBe(true);
    // 工程は「レンダー」がactive(直前まで進んだ状態)で止まる
    expect(d.stages.find((s) => s.state === 'active')?.label).toBe('レンダー');
  });

  it('バックストップをapproveで応答すると再開し、以後レンダー突入を許す', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sB2', path.join(root, 'ch1')));
    procs[0].push(textLine('<stage>レンダー</stage>'));
    await new Promise((r) => setTimeout(r, 30));
    m.respondGate(j.id, 'approve');
    expect(m.get(j.id)!.renderApproved).toBe(true);
    procs[1].push(textLine('<stage>レンダー</stage>'));
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get(j.id)!.status).toBe('running'); // 2度目は素通り
  });

  it('auto モードではバックストップは発火しない', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', mode: 'auto' });
    procs[0].push(initLine('sB3', path.join(root, 'ch1')));
    procs[0].push(textLine('<stage>レンダー</stage>'));
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get(j.id)!.status).toBe('running');
    expect(m.get(j.id)!.stages.find((s) => s.state === 'active')?.label).toBe('レンダー');
  });

  it('semi: 承認工程からゲートでレンダーがactiveに達しても自動応答されず人間待ちになる(atRenderBrink)', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', mode: 'semi' });
    procs[0].push(initLine('sBrink', path.join(root, 'ch1')));
    procs[0].push(textLine('<stage>承認</stage>'));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].push(textLine(GATE)); // 通常ゲート(kind無し) → openGate内のadvanceStageでレンダーがactiveに
    await new Promise((r) => setTimeout(r, 30));
    const d = m.get(j.id)!;
    expect(d.status).toBe('awaiting_gate');
    expect(d.stages.find((s) => s.state === 'active')?.label).toBe('レンダー');
    expect(procs.length).toBe(1); // 自動応答による再spawnは起きない
  });

  // ---- resultText: 最終resultの本文を保存(質問オペの回答表示) ----

  it('result 行の本文がマーカー除去済みで resultText に入る', async () => {
    const j = m.create({ dir: 'ch1', operation: 'ask', arg: '進捗は?' });
    procs[0].push(initLine('sT', path.join(root, 'ch1')));
    procs[0].push(resultLine('sT', 'ep010はQA工程です。<done>回答済み</done>'));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    const d = m.get(j.id)!;
    expect(d.status).toBe('succeeded');
    expect(d.resultText).toBe('ep010はQA工程です。回答済み');
  });

  // ---- 工程の episode.json 突き合わせ(表示時・前進のみ) ----

  function writeEpisode(episodeId: string, subject: string, status: string) {
    const ep = path.join(root, 'ch1', 'episodes', episodeId);
    fs.mkdirSync(ep, { recursive: true });
    fs.writeFileSync(path.join(ep, 'episode.json'), JSON.stringify({ episodeId, subject, status }));
  }

  it('video-create: <stage>マーカーが無くても episode.json の status まで工程が前進して見える', () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'クレオパトラ' });
    writeEpisode('ep010-cleopatra', 'クレオパトラ', 'implemented');
    m.cancel(j.id); // キャンセル済みでも実進捗を映す(クレオパトラで起きた形)
    const d = m.get(j.id)!;
    expect(d.stages.filter((s) => s.state === 'done')).toHaveLength(6);
    expect(d.stages.find((s) => s.state === 'active')?.label).toBe('検査');
  });

  it('突き合わせは前進のみ: マーカーの方が先なら維持。永続stateは書き換えない', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'クレオパトラ' });
    procs[0].push(initLine('sRec', path.join(root, 'ch1')));
    procs[0].push(textLine('<stage>レビュー</stage>'));
    await new Promise((r) => setTimeout(r, 20));
    writeEpisode('ep010-cleopatra', 'クレオパトラ', 'scripted'); // 実進捗の方が手前
    const d = m.get(j.id)!;
    expect(d.stages.find((s) => s.state === 'active')?.label).toBe('レビュー');
    const persisted = JSON.parse(
      fs.readFileSync(path.join(root, 'factory-ui', 'jobs', j.id, 'state.json'), 'utf8'),
    ) as JobDetail;
    expect(persisted.stages.find((s) => s.state === 'active')?.label).toBe('レビュー');
  });

  it('対応エピソードが無い・video-create以外は工程をいじらない', () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: '該当なし' });
    const d = m.get(j.id)!;
    expect(d.stages.find((s) => s.state === 'active')?.label).toBe('調査');
    const j2 = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    expect(m.get(j2.id)!.stages.find((s) => s.state === 'active')?.label).toBe('探索');
  });

  // ---- 夜間レンダーキュー連携(render-check承認 → キュー登録 + 決定文変更) ----

  function hookedManager() {
    const calls: Array<[string, string]> = [];
    const mgr = new JobManager(root, spawnFn, {
      enqueueRender: (dir: string, epId: string) => {
        calls.push([dir, epId]);
        return true;
      },
    });
    return { mgr, calls };
  }

  it('render-check承認: エピソードが解決できればキュー登録フックが呼ばれ、決定文が完了処理指示に変わる', async () => {
    const { mgr, calls } = hookedManager();
    const j = mgr.create({ dir: 'ch1', operation: 'video-create', arg: 'クレオパトラ' });
    writeEpisode('ep010-cleopatra', 'クレオパトラ', 'packaged');
    procs[0].push(initLine('sQ1', path.join(root, 'ch1')));
    procs[0].push(textLine(RENDER_GATE));
    await new Promise((r) => setTimeout(r, 30));
    mgr.respondGate(j.id, 'approve');
    expect(calls).toEqual([['ch1', 'ep010-cleopatra']]);
    const decision = procs[1].args[procs[1].args.indexOf('sQ1') + 1]!;
    expect(decision).toContain('レンダーは実行せず');
    expect(decision).toContain('render_ready');
    expect(decision).not.toContain('レンダーを実行し');
  });

  it('render-check revise: キュー登録フックは呼ばれない', async () => {
    const { mgr, calls } = hookedManager();
    const j = mgr.create({ dir: 'ch1', operation: 'video-create', arg: 'クレオパトラ' });
    writeEpisode('ep010-cleopatra', 'クレオパトラ', 'packaged');
    procs[0].push(initLine('sQ2', path.join(root, 'ch1')));
    procs[0].push(textLine(RENDER_GATE));
    await new Promise((r) => setTimeout(r, 30));
    mgr.respondGate(j.id, 'revise', '字幕を直して');
    expect(calls).toEqual([]);
  });

  it('render-check承認でもエピソード未解決ならフックを呼ばず、従来のレンダー実行指示にフォールバック', async () => {
    const { mgr, calls } = hookedManager();
    const j = mgr.create({ dir: 'ch1', operation: 'video-create', arg: '該当なし' });
    procs[0].push(initLine('sQ3', path.join(root, 'ch1')));
    procs[0].push(textLine(RENDER_GATE));
    await new Promise((r) => setTimeout(r, 30));
    mgr.respondGate(j.id, 'approve');
    expect(calls).toEqual([]);
    const decision = procs[1].args[procs[1].args.indexOf('sQ3') + 1]!;
    expect(decision).toContain('レンダーを実行');
  });

  it('episodeId付きの非video-createジョブ(channel-refine)でもrender-check承認でキュー登録される', async () => {
    const { mgr, calls } = hookedManager();
    const j = mgr.create({
      dir: 'ch1',
      operation: 'channel-refine',
      arg: 'video-createを再開して',
      episodeId: 'ep009-columbus',
    });
    writeEpisode('ep009-columbus', 'コロンブス', 'packaged');
    procs[0].push(initLine('sQ6', path.join(root, 'ch1')));
    procs[0].push(textLine(RENDER_GATE));
    await new Promise((r) => setTimeout(r, 30));
    mgr.respondGate(j.id, 'approve');
    expect(calls).toEqual([['ch1', 'ep009-columbus']]);
    const decision = procs[1].args[procs[1].args.indexOf('sQ6') + 1]!;
    expect(decision).toContain('レンダーは実行せず');
  });

  it('episodeId無しの非video-createジョブはrender-check承認でもキュー登録しない', async () => {
    const { mgr, calls } = hookedManager();
    const j = mgr.create({ dir: 'ch1', operation: 'channel-refine', arg: 'コロンブス' });
    writeEpisode('ep009-columbus', 'コロンブス', 'packaged');
    procs[0].push(initLine('sQ7', path.join(root, 'ch1')));
    procs[0].push(textLine(RENDER_GATE));
    await new Promise((r) => setTimeout(r, 30));
    mgr.respondGate(j.id, 'approve');
    expect(calls).toEqual([]);
  });

  it('episodeId付きの非video-createジョブ: auto成功時もrender_readyならキュー登録される', async () => {
    const { mgr, calls } = hookedManager();
    const j = mgr.create({
      dir: 'ch1',
      operation: 'channel-refine',
      arg: '再開',
      episodeId: 'ep009-columbus',
      mode: 'auto',
    });
    writeEpisode('ep009-columbus', 'コロンブス', 'render_ready');
    procs[0].push(initLine('sQ8', path.join(root, 'ch1')));
    procs[0].push(resultLine('sQ8', '<done>完了</done>'));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(mgr.get(j.id)!.status).toBe('succeeded');
    expect(calls).toEqual([['ch1', 'ep009-columbus']]);
  });

  it('auto成功時: episode.json が render_ready ならキュー登録フックが呼ばれる', async () => {
    const { mgr, calls } = hookedManager();
    const j = mgr.create({ dir: 'ch1', operation: 'video-create', arg: 'クレオパトラ', mode: 'auto' });
    writeEpisode('ep010-cleopatra', 'クレオパトラ', 'render_ready');
    procs[0].push(initLine('sQ4', path.join(root, 'ch1')));
    procs[0].push(resultLine('sQ4', '<done>承認済みで完了処理まで実施</done>'));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(mgr.get(j.id)!.status).toBe('succeeded');
    expect(calls).toEqual([['ch1', 'ep010-cleopatra']]);
  });

  it('成功時でも status が render_ready 未満(packaged)なら登録しない', async () => {
    const { mgr, calls } = hookedManager();
    const j = mgr.create({ dir: 'ch1', operation: 'video-create', arg: 'クレオパトラ', mode: 'auto' });
    writeEpisode('ep010-cleopatra', 'クレオパトラ', 'packaged');
    procs[0].push(initLine('sQ5', path.join(root, 'ch1')));
    procs[0].push(resultLine('sQ5', '<done>途中まで</done>'));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(mgr.get(j.id)!.status).toBe('succeeded');
    expect(calls).toEqual([]);
  });
});
