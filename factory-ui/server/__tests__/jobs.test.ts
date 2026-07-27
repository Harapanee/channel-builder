import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JobDetail } from '../../shared/types';
import { JobManager, makeClaudeSpawn, type SpawnClaude } from '../jobs';
import { _clearProgressCache } from '../progress';

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
    // progress.ts のTTLキャッシュ(dir+episodeId/titleがキー。rootは含まない)が
    // 別テストのmkdtempルートをまたいで衝突しないよう、テストごとに空にする
    _clearProgressCache();
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

  it('rootLevel操作(channel-analyze)は dir="" で起動し、cwdはファクトリールートになる', () => {
    const j = m.create({ dir: '', operation: 'channel-analyze', arg: 'https://www.youtube.com/@example' });
    expect(j.status).toBe('running');
    expect(j.dir).toBe('');
    expect(procs[0].cwd).toBe(root);
  });

  it('rootLevel操作にチャンネルdirは指定できず、非rootLevel操作の dir="" も拒否する', () => {
    expect(() => m.create({ dir: 'ch1', operation: 'channel-analyze', arg: '@x' })).toThrow();
    expect(() => m.create({ dir: '', operation: 'theme-scout', arg: '' })).toThrow();
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

  it('成功時に生成物(artifacts)を収集する: out/*.mp4・publish/metadata.json・publish/thumb-*.png', async () => {
    const epDir = path.join(root, 'ch1', 'episodes', 'ep001-x');
    fs.mkdirSync(path.join(epDir, 'out'), { recursive: true });
    fs.mkdirSync(path.join(epDir, 'publish'), { recursive: true });
    fs.writeFileSync(path.join(epDir, 'out', 'final.mp4'), '');
    fs.writeFileSync(path.join(epDir, 'publish', 'metadata.json'), '{}');
    fs.writeFileSync(path.join(epDir, 'publish', 'thumb-1.png'), '');
    // フェーズチェーン導入により video-create は既定でphase0開始(<done>で次フェーズへ)。
    // このテストの意図(成功時のartifacts収集)を保つため、render_readyで最終フェーズから開始させる
    fs.writeFileSync(
      path.join(epDir, 'episode.json'),
      JSON.stringify({ episodeId: 'ep001-x', subject: 'x', status: 'render_ready' }),
    );
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: '', episodeId: 'ep001-x' });
    procs[0].push(initLine('sArt', path.join(root, 'ch1')));
    procs[0].push(resultLine('sArt', `完了 ${DONE}`));
    await new Promise((r) => setTimeout(r, 20)); // 実プロセス同様、stdout処理後にclose
    procs[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    const d = m.get(j.id)!;
    expect(d.status).toBe('succeeded');
    expect(d.artifacts).toEqual([
      path.join('episodes', 'ep001-x', 'out', 'final.mp4'),
      path.join('episodes', 'ep001-x', 'publish', 'metadata.json'),
      path.join('episodes', 'ep001-x', 'publish', 'thumb-1.png'),
    ]);
  });

  it('short-create成功時はshorts/<shortId>/out/*.mp4を収集する(publishは対象外)', async () => {
    const shDir = path.join(root, 'ch1', 'shorts', 'sh002-nobunaga-top3');
    fs.mkdirSync(path.join(shDir, 'out'), { recursive: true });
    fs.writeFileSync(path.join(shDir, 'out', 'short.mp4'), '');
    writeShort('sh002-nobunaga-top3', 'ep001-nobunaga', 'rank3-reasons', 'implemented');
    const j = m.create({ dir: 'ch1', operation: 'short-create', arg: 'ep001-nobunaga rank3-reasons' });
    procs[0].push(initLine('sSh', path.join(root, 'ch1')));
    procs[0].push(resultLine('sSh', `完了 ${DONE}`));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    const d = m.get(j.id)!;
    expect(d.status).toBe('succeeded');
    expect(d.artifacts).toEqual([path.join('shorts', 'sh002-nobunaga-top3', 'out', 'short.mp4')]);
  });

  it('channel-refineはepisodeId/shortIdどちらも解決できないため生成物は空のまま', async () => {
    const j = m.create({ dir: 'ch1', operation: 'channel-refine', arg: 'サムネの文字を大きく' });
    procs[0].push(initLine('sRef', path.join(root, 'ch1')));
    procs[0].push(resultLine('sRef', `完了 ${DONE}`));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    const d = m.get(j.id)!;
    expect(d.status).toBe('succeeded');
    expect(d.artifacts).toEqual([]);
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
    // <done>の有無とゲート応答の世代管理を見るテストでvideo-createである必然はない。
    // video-createはフェーズチェーン導入で<done>=即succeededではなくなったため、
    // phases無しのtheme-scoutに差し替えて完走(succeeded)の意図を保つ
    const j = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
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

  it('short-create同士(対象違い)は同一チャンネルで並列実行できる', () => {
    m.create({ dir: 'ch1', operation: 'short-create', arg: 'ep001-nobunaga rank3-reasons' });
    const j2 = m.create({ dir: 'ch1', operation: 'short-create', arg: 'ep006-ieyasu rank3-reasons' });
    expect(m.get(j2.id)!.status).toBe('running');
    expect(procs.length).toBe(2);
  });

  it('同じ対象のshort-create同士は排他(2本目はqueued)', () => {
    m.create({ dir: 'ch1', operation: 'short-create', arg: 'ep001-nobunaga rank3-reasons' });
    const j2 = m.create({ dir: 'ch1', operation: 'short-create', arg: 'ep001-nobunaga rank3-reasons' });
    expect(m.get(j2.id)!.status).toBe('queued');
    expect(procs.length).toBe(1);
  });

  it('video-createとshort-createは元エピソードが違えば並列実行できる', () => {
    m.create({ dir: 'ch1', operation: 'video-create', arg: '', episodeId: 'ep002-b' });
    const j2 = m.create({ dir: 'ch1', operation: 'short-create', arg: 'ep001-nobunaga rank3-reasons' });
    expect(m.get(j2.id)!.status).toBe('running');
    expect(procs.length).toBe(2);
  });

  it('制作中エピソードを元にするshort-createは排他(queued)', () => {
    m.create({ dir: 'ch1', operation: 'video-create', arg: '', episodeId: 'ep001-nobunaga' });
    const j2 = m.create({ dir: 'ch1', operation: 'short-create', arg: 'ep001-nobunaga rank3-reasons' });
    expect(m.get(j2.id)!.status).toBe('queued');
    expect(procs.length).toBe(1);
  });

  // video-create × short-create の突き合わせ用(題材名からepisodeIdを解決させる)
  function writeEpisodeFixture(episodeId: string, subject: string) {
    const ep = path.join(root, 'ch1', 'episodes', episodeId);
    fs.mkdirSync(ep, { recursive: true });
    fs.writeFileSync(path.join(ep, 'episode.json'), JSON.stringify({ episodeId, subject, status: 'scripted' }));
    _clearProgressCache();
  }

  it('題材名で起動したvideo-create稼働中でも、別エピソード元のshort-createは並列実行できる(episodeIdをディスクから解決)', () => {
    writeEpisodeFixture('ep004-penguin', 'コウテイペンギン');
    m.create({ dir: 'ch1', operation: 'video-create', arg: 'コウテイペンギン' });
    const j2 = m.create({ dir: 'ch1', operation: 'short-create', arg: 'ep001-nobunaga rank3-reasons' });
    expect(m.get(j2.id)!.status).toBe('running');
    expect(procs.length).toBe(2);
  });

  it('題材名で起動したvideo-createの解決先エピソードを元にするshort-createは排他(queued)', () => {
    writeEpisodeFixture('ep004-penguin', 'コウテイペンギン');
    m.create({ dir: 'ch1', operation: 'video-create', arg: 'コウテイペンギン' });
    const j2 = m.create({ dir: 'ch1', operation: 'short-create', arg: 'ep004-penguin rank3-reasons' });
    expect(m.get(j2.id)!.status).toBe('queued');
    expect(procs.length).toBe(1);
  });

  it('episodeId未解決で待機したshort-createは、video-createの<stage>前進時に再評価されて起動する', async () => {
    const j1 = m.create({ dir: 'ch1', operation: 'video-create', arg: 'コウテイペンギン' });
    const j2 = m.create({ dir: 'ch1', operation: 'short-create', arg: 'ep001-nobunaga rank3-reasons' });
    expect(m.get(j2.id)!.status).toBe('queued'); // エピソード未作成=解決不能なので保守的に待機
    // スキルがエピソードフォルダを作って工程マーカーを出した時点で解決可能になる
    writeEpisodeFixture('ep004-penguin', 'コウテイペンギン');
    procs[0].push(initLine('sVC', path.join(root, 'ch1')));
    procs[0].push(textLine('<stage>台本</stage>'));
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get(j1.id)!.status).toBe('running');
    expect(m.get(j2.id)!.status).toBe('running');
    expect(procs.length).toBe(2);
  });

  it('short-publish同士(別ショート)は同一チャンネルで並列実行できる', () => {
    m.create({ dir: 'ch1', operation: 'short-publish', arg: 'sh003-ieyasu-top3' });
    const j2 = m.create({ dir: 'ch1', operation: 'short-publish', arg: 'sh002-nobunaga-top3' });
    expect(m.get(j2.id)!.status).toBe('running');
    expect(procs.length).toBe(2);
  });

  it('同じショートを対象とするshort-publish同士は排他(2本目はqueued)', () => {
    m.create({ dir: 'ch1', operation: 'short-publish', arg: 'sh003-ieyasu-top3' });
    const j2 = m.create({ dir: 'ch1', operation: 'short-publish', arg: 'sh003-ieyasu-top3' });
    expect(m.get(j2.id)!.status).toBe('queued');
    expect(procs.length).toBe(1);
  });

  // short-create × short-publish の突き合わせ用(short-create の arg から shortId を解決させる)
  function writeShortFixture(shortId: string, sourceEpisodeId: string, formatId: string) {
    const sh = path.join(root, 'ch1', 'shorts', shortId);
    fs.mkdirSync(sh, { recursive: true });
    fs.writeFileSync(
      path.join(sh, 'short.json'),
      JSON.stringify({ shortId, sourceEpisodeId, formatId, status: 'implemented' }),
    );
    _clearProgressCache();
  }

  it('short-createとshort-publishは対象ショートが違えば並列実行できる', () => {
    writeShortFixture('sh002-nobunaga-top3', 'ep001-nobunaga', 'rank3-reasons');
    m.create({ dir: 'ch1', operation: 'short-create', arg: 'ep001-nobunaga rank3-reasons' });
    const j2 = m.create({ dir: 'ch1', operation: 'short-publish', arg: 'sh003-ieyasu-top3' });
    expect(m.get(j2.id)!.status).toBe('running');
    expect(procs.length).toBe(2);
  });

  it('制作中のショートを対象とするshort-publishは排他(queued)', () => {
    writeShortFixture('sh002-nobunaga-top3', 'ep001-nobunaga', 'rank3-reasons');
    m.create({ dir: 'ch1', operation: 'short-create', arg: 'ep001-nobunaga rank3-reasons' });
    const j2 = m.create({ dir: 'ch1', operation: 'short-publish', arg: 'sh002-nobunaga-top3' });
    expect(m.get(j2.id)!.status).toBe('queued');
    expect(procs.length).toBe(1);
  });

  it('対象ショート未解決のshort-create稼働中はshort-publishもqueued(保守的排他)', () => {
    m.create({ dir: 'ch1', operation: 'short-create', arg: 'ep999-none rank3-reasons' });
    const j2 = m.create({ dir: 'ch1', operation: 'short-publish', arg: 'sh003-ieyasu-top3' });
    expect(m.get(j2.id)!.status).toBe('queued');
    expect(procs.length).toBe(1);
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

  it('ステージレール: 起動で先頭active、<stage>で前進、成功で全done', async () => {
    // <stage>マーカーの前進と成功時の全done化を見るテストでvideo-createである必然はない。
    // video-createはフェーズチェーン導入で<done>=即succeededではなくなったため、
    // phases無しのtheme-scoutに差し替える(工程ラベルは探索/採点の2本)
    const j = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    let d = m.get(j.id)!;
    expect(d.stages.length).toBeGreaterThan(1);
    expect(d.stages[0]!.state).toBe('active');
    expect(d.stages[1]!.state).toBe('pending');
    procs[0].push(initLine('sG', path.join(root, 'ch1')));
    procs[0].push(textLine('<stage>採点</stage>'));
    await new Promise((r) => setTimeout(r, 20));
    d = m.get(j.id)!;
    expect(d.stages[0]!.state).toBe('done');
    expect(d.stages[1]!.state).toBe('active');
    procs[0].push(textLine(GATE)); // ゲートは工程を動かさない
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
    procs[0].push(textLine('調査が終わりました。<stage>台本</stage> 執筆に入ります。'));
    await new Promise((r) => setTimeout(r, 20));
    const d = m.get(j.id)!;
    const labels = d.stages.map((s) => `${s.label}:${s.state}`);
    expect(labels).toContain('台本:active');
    expect(d.stages[0]!.state).toBe('done'); // 調査
    expect(d.stages[4]!.state).toBe('pending'); // 素材
  });

  it('<stage>の未知ラベル・後退・フェーズ外は無視する', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sS2', path.join(root, 'ch1')));
    procs[0].push(textLine('<stage>台本</stage>'));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].push(textLine('<stage>存在しない工程</stage>'));
    procs[0].push(textLine('<stage>調査</stage>')); // 後退
    // フェーズ外: フェーズ1(工程0〜3)のセッションが監査などで後工程ラベルを誤発行
    // (実測 ep001-shoyu: 素材・実装の実作業が「検査」枠に計上された表示ずれの原因)
    procs[0].push(textLine('<stage>検査</stage>'));
    procs[0].push(textLine('<stage>実装</stage>'));
    await new Promise((r) => setTimeout(r, 20));
    const d = m.get(j.id)!;
    expect(d.stages[1]!.state).toBe('active'); // 台本のまま
    expect(d.stages[0]!.state).toBe('done');
    expect(d.stages[5]!.state).toBe('pending'); // 実装は前進しない
    expect(d.stages[6]!.state).toBe('pending'); // 検査は前進しない
  });

  // ---- 回帰: 工程ラベル「レビュー」の誤マッチ(実バグ ep004-emperor-penguin) ----
  // 台本工程内の「台本レビュー(二重審査)」開始時にエージェントが <stage>レビュー</stage> を
  // 誤出力し、進捗バーが音声〜検査を飛ばして最終レビューまで暴走した。ラベルを「最終レビュー」に
  // 改名したため、旧ラベルは未知として無視されることを保証する。

  it('<stage>レビュー</stage>(旧ラベル)は未知として無視され、工程は前進しない', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'コウテイペンギン' });
    procs[0].push(initLine('sPen', path.join(root, 'ch1')));
    procs[0].push(textLine('<stage>台本</stage>'));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].push(textLine('二重審査を並列で起動します。<stage>レビュー</stage>'));
    await new Promise((r) => setTimeout(r, 20));
    const d = m.get(j.id)!;
    expect(d.stages.find((s) => s.state === 'active')?.label).toBe('台本');
    expect(d.stages.find((s) => s.label === '最終レビュー')?.state).toBe('pending');
  });

  it('restore: 旧ラベル「レビュー」を含むstate.jsonは「最終レビュー」へ移行される', () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    const statePath = path.join(root, 'factory-ui', 'jobs', j.id, 'state.json');
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')) as JobDetail;
    persisted.stages.find((s) => s.label === '最終レビュー')!.label = 'レビュー'; // 旧形式を再現
    fs.writeFileSync(statePath, JSON.stringify(persisted));
    const m2 = new JobManager(root, spawnFn);
    m2.restore();
    const labels = m2.get(j.id)!.stages.map((s) => s.label);
    expect(labels).toContain('最終レビュー');
    expect(labels).not.toContain('レビュー');
  });

  // ---- 回帰: ゲートは工程の境界ではない(実バグ ep011-galileo) ----
  // 素材工程で画像生成クレジットが枯渇し、同一工程内で確認ゲートが5回開いた。
  // ゲート到達=1工程前進としていたため、進捗バーが素材→…→レンダーまで暴走し、
  // 以降の本物の<stage>マーカーは後退ガードで無視されて二度と戻らなくなった。

  it('同一工程内でゲートが複数回開いても工程は前進しない', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'ガリレオ・ガリレイ' });
    procs[0].push(initLine('sRG', path.join(root, 'ch1')));
    procs[0].push(textLine('<stage>台本</stage> 執筆します'));
    await new Promise((r) => setTimeout(r, 20));

    // クレジット枯渇の確認ゲートが素材工程の中で3回開く(実バグは5回)
    for (let i = 0; i < 3; i++) {
      procs[i]!.push(textLine(GATE));
      await new Promise((r) => setTimeout(r, 20));
      expect(m.get(j.id)!.status).toBe('awaiting_gate');
      m.respondGate(j.id, 'yes');
      await new Promise((r) => setTimeout(r, 20));
    }

    const labels = Object.fromEntries(m.get(j.id)!.stages.map((s) => [s.label, s.state]));
    expect(labels['台本']).toBe('active'); // 台本のまま。ゲート数だけ勝手に進まない
    expect(labels['音声']).toBe('pending');
    expect(labels['レンダー']).toBe('pending');
  });

  it('工程がレンダーまで進んだ状態でも、未承認なら<stage>レンダー</stage>でバックストップが効く', async () => {
    // 壊れたstate.jsonからのrestore等でfrontierが既にレンダーに達していても、
    // 目視確認(render-check)未承認のレンダー突入は止める(後退ガードに飲まれない)
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sRB', path.join(root, 'ch1')));
    procs[0].push(textLine('<stage>レンダー</stage>'));
    await new Promise((r) => setTimeout(r, 20));
    expect(m.get(j.id)!.status).toBe('awaiting_gate');
    expect(m.get(j.id)!.gate?.kind).toBe('render-check');

    // 承認せずに修正を依頼 → 再開後にまたレンダーへ入ろうとしても再び止まる
    m.respondGate(j.id, 'revise', '画像を差し替えて');
    await new Promise((r) => setTimeout(r, 20));
    procs[1]!.push(textLine('<stage>レンダー</stage>'));
    await new Promise((r) => setTimeout(r, 20));
    expect(m.get(j.id)!.status).toBe('awaiting_gate');
    expect(m.get(j.id)!.gate?.kind).toBe('render-check');
  });

  // ---- 工程タイムスタンプ: 全stage遷移経路でstartedAt/endedAtが刻まれる ----

  it('create直後の先頭stageにstartedAtが入る(以降のstageは未設定)', () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    const d = m.get(j.id)!;
    expect(d.stages[0]!.startedAt).toBeTypeOf('number');
    expect(d.stages[0]!.endedAt).toBeUndefined();
    expect(d.stages[1]!.startedAt).toBeUndefined();
    expect(d.stages[1]!.endedAt).toBeUndefined();
  });

  it('<stage>マーカー前進(maybeStage経由)で前stageのendedAtと新activeのstartedAtが入る', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sTS', path.join(root, 'ch1')));
    procs[0].push(textLine('調査完了。<stage>台本</stage> 執筆に入ります。'));
    await new Promise((r) => setTimeout(r, 20));
    const d = m.get(j.id)!;
    const active = d.stages.find((s) => s.state === 'active')!;
    expect(active.label).toBe('台本');
    expect(active.startedAt).toBeTypeOf('number');
    const doneStages = d.stages.filter((s) => s.state === 'done');
    expect(doneStages.length).toBeGreaterThan(0);
    for (const s of doneStages) expect(s.endedAt).toBeTypeOf('number');
    // 未到達のstageにはまだ刻まれない
    for (const s of d.stages.filter((s) => s.state === 'pending')) {
      expect(s.startedAt).toBeUndefined();
      expect(s.endedAt).toBeUndefined();
    }
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
    procs[0].push(textLine('<stage>台本</stage> 確認お願いします ' + GATE));
    await new Promise((r) => setTimeout(r, 20));
    const d = m.get(j.id)!;
    expect(d.status).toBe('awaiting_gate'); // ゲートは開く
    const labels = Object.fromEntries(d.stages.map((s) => [s.label, s.state]));
    expect(labels['台本']).toBe('active'); // <stage>で台本まで前進する(ゲート同居で無視されない)
    expect(labels['調査']).toBe('done');
    expect(labels['音声']).toBe('pending'); // ゲートでは進まない
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

  it('Important-3: activeが無い工程レール(全done)でも<stage>の後退ガードが効く', async () => {
    // 全工程doneでゲート待ちのまま永続化されたジョブを復元して再開する経路。
    // activeが無いため findIndex(active) では後退を検出できず、frontier(pendingでない最大index)
    // で判定する必要がある
    const dir = path.join(root, 'factory-ui', 'jobs', 'nog-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        id: 'nog-1', dir: 'ch1', operation: 'theme-scout', title: 'ネタ帳を補充',
        status: 'awaiting_gate', createdAt: 1, updatedAt: 1, artifacts: [], sessionId: 'sP',
        gate: { gateId: 'g1', question: '?', options: [{ id: 'yes', label: 'はい', description: '' }] },
        stages: [
          { key: 's0', label: '探索', state: 'done' },
          { key: 's1', label: '採点', state: 'done' },
        ],
      }),
    );
    m.restore();
    expect(m.get('nog-1')!.stages.find((s) => s.state === 'active')).toBeUndefined();

    m.respondGate('nog-1', 'yes'); // procs[0]、statusはrunningに戻る
    procs[0].push(textLine('<stage>探索</stage>')); // 後退マーカー。無視されるべき
    await new Promise((r) => setTimeout(r, 20));
    const d = m.get('nog-1')!;
    expect(d.stages[0]!.state).toBe('done'); // 巻き戻らない
    expect(d.stages[1]!.state).toBe('done'); // 巻き戻らない
  });

  // ---- 型拡張: mode/model/effort/request の既定値と永続化互換 ----

  it('create は mode=manual, model=opus, effort=high, request.arg を既定で持つ', () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: '織田信長' });
    const d = m.get(j.id)!;
    expect(d.mode).toBe('manual');
    expect(d.model).toBe('opus');
    expect(d.effort).toBe('high');
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
    expect(d.effort).toBe('high');
    expect(d.request).toEqual({ arg: '' });
  });

  // ---- モデル/effort: spawn引数と検証 ----

  function argAfter(args: string[], flag: string): string | undefined {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  }

  it('既定で --model opus --effort high が付く。指定時はその値', () => {
    m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    expect(argAfter(procs[0].args, '--model')).toBe('opus');
    expect(argAfter(procs[0].args, '--effort')).toBe('high');
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
    // durationSecMax は durationSec と併せた範囲指定のみ受理する
    expect(() => m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', durationSecMax: 900 })).toThrow(/durationSecMax/);
    expect(() => m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', durationSec: 480, durationSecMax: 480 })).toThrow(/durationSecMax/);
    expect(() => m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', durationSec: 480, durationSecMax: 4000 })).toThrow(/durationSecMax/);
    const ok = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', durationSec: 480, durationSecMax: 900 });
    expect(m.get(ok.id)!.request.durationSecMax).toBe(900);
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
    // resumeの汎用機構(--resume/セッション再開/<done>完走)を見るテストでvideo-createである
    // 必然はない。video-createはフェーズチェーン導入で<done>=即succeededではなくなったため、
    // phases無しのtheme-scoutに差し替える
    const j = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
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

  it('setMode: ゲート停止中に manual → auto へ切り替えると、そのゲートを即自動応答する', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' }); // manual
    procs[0].push(initLine('sM1', path.join(root, 'ch1')));
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get(j.id)!.status).toBe('awaiting_gate'); // manualなので停止

    const d = m.setMode(j.id, 'auto');
    expect(d.mode).toBe('auto');
    await new Promise((r) => setTimeout(r, 50)); // setImmediate分の余裕
    expect(m.get(j.id)!.status).toBe('running'); // 停止中のゲートが自動応答された
    expect(procs.length).toBe(2);
  });

  it('setMode: running中の auto → manual 切替は次のゲートで停止する', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', mode: 'auto' });
    procs[0].push(initLine('sM2', path.join(root, 'ch1')));
    await new Promise((r) => setTimeout(r, 20));
    m.setMode(j.id, 'manual');
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 50));
    expect(m.get(j.id)!.status).toBe('awaiting_gate'); // 自動応答されない
    expect(procs.length).toBe(1);
  });

  it('setMode: 終了状態のジョブ・不正モードは throw する', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    expect(() => m.setMode(j.id, 'turbo' as never)).toThrow(/invalid mode/);
    m.cancel(j.id);
    expect(() => m.setMode(j.id, 'auto')).toThrow(/conflict/);
  });

  it('setMode: 切替は暴走保護カウンタをリセットする(上限間際でも切替後は前進できる)', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', mode: 'auto' });
    procs[0].push(initLine('sM3', path.join(root, 'ch1')));
    for (let i = 0; i < 19; i++) {
      procs[procs.length - 1].push(textLine(GATE));
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(m.get(j.id)!.status).toBe('running'); // まだ上限未満
    m.setMode(j.id, 'semi'); // 人間の切替=リセット
    m.setMode(j.id, 'auto');
    for (let i = 0; i < 3; i++) {
      procs[procs.length - 1].push(textLine(GATE));
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(m.get(j.id)!.status).toBe('running'); // リセット済みなのでinterruptedにならない
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

  it('semi: レンダー直前(未承認)で通常ゲートが出ても自動応答されず人間待ちになる(atRenderBrink)', async () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x', mode: 'semi' });
    procs[0].push(initLine('sBrink', path.join(root, 'ch1')));
    procs[0].push(textLine('<stage>レンダー</stage>')); // バックストップでレンダーactive+render-checkゲート
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get(j.id)!.gate?.kind).toBe('render-check');

    m.respondGate(j.id, 'revise', '画像を差し替えて'); // 未承認のまま再開(procs[1])
    await new Promise((r) => setTimeout(r, 20));
    expect(m.get(j.id)!.renderApproved).toBeFalsy();
    const spawned = procs.length;

    procs[1]!.push(textLine(GATE)); // 通常ゲート(kind無し)。semiなら本来は自動応答される
    await new Promise((r) => setTimeout(r, 30));
    const d = m.get(j.id)!;
    expect(d.status).toBe('awaiting_gate');
    expect(d.stages.find((s) => s.state === 'active')?.label).toBe('レンダー');
    expect(procs.length).toBe(spawned); // 自動応答による再spawnは起きない
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
    // m.create()のemitUpdate(reconciled)がこの時点より前にfindEpisodeProgressを呼び、
    // 「episode.json不在」のmissをTTLキャッシュ済みのことがある。書き換え後は必ず無効化して読み直させる
    _clearProgressCache();
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
    // prechecked から始める作り直しジョブ(フェーズ4=工程9〜10)なら
    // <stage>最終レビュー</stage> は担当フェーズ内で有効
    writeEpisode('ep010-cleopatra', 'クレオパトラ', 'prechecked');
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'クレオパトラ', episodeId: 'ep010-cleopatra' });
    procs[0].push(initLine('sRec', path.join(root, 'ch1')));
    procs[0].push(textLine('<stage>最終レビュー</stage>'));
    await new Promise((r) => setTimeout(r, 20));
    writeEpisode('ep010-cleopatra', 'クレオパトラ', 'scripted'); // 実進捗の方が手前
    const d = m.get(j.id)!;
    expect(d.stages.find((s) => s.state === 'active')?.label).toBe('最終レビュー');
    const persisted = JSON.parse(
      fs.readFileSync(path.join(root, 'factory-ui', 'jobs', j.id, 'state.json'), 'utf8'),
    ) as JobDetail;
    expect(persisted.stages.find((s) => s.state === 'active')?.label).toBe('最終レビュー');
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
    const calls: Array<[string, string] | [string, string, string]> = [];
    const mgr = new JobManager(root, spawnFn, {
      enqueueRender: (dir: string, epId: string, kind?: 'episode' | 'short') => {
        calls.push(kind ? [dir, epId, kind] : [dir, epId]);
        return true;
      },
    });
    return { mgr, calls };
  }

  function writeShort(shortId: string, sourceEpisodeId: string, formatId: string, status: string) {
    const sh = path.join(root, 'ch1', 'shorts', shortId);
    fs.mkdirSync(sh, { recursive: true });
    fs.writeFileSync(
      path.join(sh, 'short.json'),
      JSON.stringify({ shortId, sourceEpisodeId, formatId, status }),
    );
    // writeEpisode同様、create()時点でのfindShortIdForJobのmissキャッシュを無効化する
    _clearProgressCache();
  }

  it('short-create: render-check承認でショートがkind=shortでキュー登録され、決定文がショート完了処理指示になる', async () => {
    const { mgr, calls } = hookedManager();
    const j = mgr.create({ dir: 'ch1', operation: 'short-create', arg: 'ep001-nobunaga rank3-reasons' });
    writeShort('sh002-nobunaga-top3', 'ep001-nobunaga', 'rank3-reasons', 'implemented');
    procs[0].push(initLine('sQ8', path.join(root, 'ch1')));
    procs[0].push(textLine(RENDER_GATE));
    await new Promise((r) => setTimeout(r, 30));
    mgr.respondGate(j.id, 'approve');
    expect(calls).toEqual([['ch1', 'sh002-nobunaga-top3', 'short']]);
    const decision = procs[1].args[procs[1].args.indexOf('sQ8') + 1]!;
    expect(decision).toContain('レンダーは実行せず');
    expect(decision).toContain('short.json');
    expect(decision).toContain('"queued"');
    expect(decision).not.toContain('レンダーを実行し');
    // Important-1(最終レビュー): 公開準備工程(/short-publish)を飛ばさせない
    expect(decision).toContain('short-publish');
    expect(decision).toContain('公開準備');
    expect(decision).toContain('metadata.json');
    expect(decision).toContain('validate:metadata');
    expect(decision.indexOf('公開準備')).toBeLessThan(decision.indexOf('"queued"')); // 公開メタデータ→status更新の順
  });

  it('short-create: 対応ショート未解決ならフックを呼ばず従来のレンダー実行指示にフォールバック', async () => {
    const { mgr, calls } = hookedManager();
    const j = mgr.create({ dir: 'ch1', operation: 'short-create', arg: 'ep999-none rank3-reasons' });
    procs[0].push(initLine('sQ9', path.join(root, 'ch1')));
    procs[0].push(textLine(RENDER_GATE));
    await new Promise((r) => setTimeout(r, 30));
    mgr.respondGate(j.id, 'approve');
    expect(calls).toEqual([]);
    const decision = procs[1].args[procs[1].args.indexOf('sQ9') + 1]!;
    expect(decision).toContain('レンダーを実行');
  });

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
    expect(decision).toContain('npm run finalize');
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
    // フェーズチェーン導入により、完走後の挙動(maybeQueueOnSuccess)を見るには最終フェーズから
    // 開始させる必要がある。episodeIdを明示しepisode.jsonをcreate前に用意する
    writeEpisode('ep010-cleopatra', 'クレオパトラ', 'render_ready');
    const j = mgr.create({
      dir: 'ch1',
      operation: 'video-create',
      arg: 'クレオパトラ',
      episodeId: 'ep010-cleopatra',
      mode: 'auto',
    });
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
    // packagedはvideoCreatePhaseForStatusで最終フェーズ(4)に該当するため、
    // episodeId指定で最終フェーズから開始しても完走後の判定(未満なら未登録)を検証できる
    writeEpisode('ep010-cleopatra', 'クレオパトラ', 'packaged');
    const j = mgr.create({
      dir: 'ch1',
      operation: 'video-create',
      arg: 'クレオパトラ',
      episodeId: 'ep010-cleopatra',
      mode: 'auto',
    });
    procs[0].push(initLine('sQ5', path.join(root, 'ch1')));
    procs[0].push(resultLine('sQ5', '<done>途中まで</done>'));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(mgr.get(j.id)!.status).toBe('succeeded');
    expect(calls).toEqual([]);
  });

  // ---- 削除: remove / clearFinished ----

  it('remove は終了状態のジョブをメモリとディスクから消し removed を発火する', async () => {
    const j = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    procs[0].push(initLine('sR1', path.join(root, 'ch1')));
    procs[0].push(resultLine('sR1', DONE));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(m.get(j.id)!.status).toBe('succeeded');
    const dir = path.join(root, 'factory-ui', 'jobs', j.id);
    expect(fs.existsSync(dir)).toBe(true);
    const removed: string[] = [];
    m.on('removed', (id: string) => removed.push(id));
    m.remove(j.id);
    expect(m.get(j.id)).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
    expect(removed).toEqual([j.id]);
  });

  it('remove は running/queued/awaiting_gate を conflict で拒否し、不明idは unknown', () => {
    const j1 = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' }); // running
    const j2 = m.create({ dir: 'ch1', operation: 'ask', arg: 'q' }); // queued(ch1排他)
    expect(() => m.remove(j1.id)).toThrow(/^conflict:/);
    expect(() => m.remove(j2.id)).toThrow(/^conflict:/);
    expect(() => m.remove('nope')).toThrow(/^unknown:/);
  });

  it('clearFinished は終了状態のジョブだけまとめて消し件数を返す(冪等)', () => {
    const j1 = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' }); // running
    const j2 = m.create({ dir: 'ch1', operation: 'ask', arg: 'q' }); // queued
    m.cancel(j2.id); // queued → cancelled(終了状態)
    expect(m.clearFinished()).toBe(1);
    expect(m.get(j2.id)).toBeUndefined();
    expect(m.get(j1.id)!.status).toBe('running');
    expect(m.clearFinished()).toBe(0);
  });

  // ---- Task 4: 同期I/Oの解消(ジョブログのメモリテール化・ファイルtail読み) ----

  it('readLog はこのプロセスが書いたジョブについてはログファイルが消えてもメモリから返す', async () => {
    const j = m.create({ dir: 'ch1', operation: 'theme-scout', arg: '' });
    procs[0].push(initLine('sMem', path.join(root, 'ch1')));
    procs[0].push(textLine('メモリ経由のテスト'));
    await new Promise((r) => setTimeout(r, 20));
    // ディスク上のログファイルを消しても、このプロセスがappendLogした内容はメモリ(logTail)から返せる
    fs.rmSync(path.join(root, 'factory-ui', 'jobs', j.id, 'log.jsonl'), { force: true });
    const lines = m.readLog(j.id);
    expect(lines).toHaveLength(2); // init行 + text行
    expect(lines![0]).toContain('sMem');
    expect(lines![1]).toContain('メモリ経由のテスト');
  });

  it('restore→resume後のappendLogは既存ログ履歴を保持する(readLogが旧3行+新2行の5行を返す)', async () => {
    // 実バグ: appendLogの遅延初期化が空配列だったため、resume後の最初の1行で
    // readLogがメモリ経由に切り替わり、resume前のファイル履歴が返却窓から消えた
    const dir = path.join(root, 'factory-ui', 'jobs', 'res-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        id: 'res-1', dir: 'ch1', operation: 'theme-scout', title: 'x',
        status: 'interrupted', createdAt: 1, updatedAt: 1, stages: [], artifacts: [],
        mode: 'manual', model: 'opus', effort: 'xhigh', request: { arg: '' },
        sessionId: 'sOld',
      }),
    );
    fs.writeFileSync(path.join(dir, 'log.jsonl'), 'old1\nold2\nold3\n');
    m.restore();
    m.resume('res-1'); // --resume sOld で procs[0] がspawnされる
    procs[0].push(textLine('新しい行A'));
    procs[0].push(textLine('新しい行B'));
    await new Promise((r) => setTimeout(r, 20));
    const lines = m.readLog('res-1')!;
    expect(lines).toHaveLength(5);
    expect(lines.slice(0, 3)).toEqual(['old1', 'old2', 'old3']);
    expect(lines[3]).toContain('新しい行A');
    expect(lines[4]).toContain('新しい行B');
  });

  it('auto成功時のキュー登録判定はキャッシュを迂回する(直前のstale進捗キャッシュで取りこぼさない)', async () => {
    const { mgr, calls } = hookedManager();
    // フェーズチェーン導入により、完走後の挙動(maybeQueueOnSuccess)を見るには最終フェーズから
    // 開始させる必要がある。packagedはvideoCreatePhaseForStatusで最終フェーズ(4)に該当するため、
    // これをcreate前のepisode.jsonに書いてepisodeId指定で最終フェーズから開始させる。
    // writeEpisodeヘルパー(キャッシュクリア付き)は意図的に使わず、create直後にrender_readyへ
    // 書き換えてキャッシュをクリアしない → create()時点でTTLキャッシュされた古い進捗(packaged)が
    // 残ったまま <done> 終了するシナリオ(maybeQueueOnSuccessの明示的_clearProgressCache()の検証)
    const ep = path.join(root, 'ch1', 'episodes', 'ep010-cleopatra');
    fs.mkdirSync(ep, { recursive: true });
    fs.writeFileSync(
      path.join(ep, 'episode.json'),
      JSON.stringify({ episodeId: 'ep010-cleopatra', subject: 'クレオパトラ', status: 'packaged' }),
    );
    const j = mgr.create({
      dir: 'ch1',
      operation: 'video-create',
      arg: 'クレオパトラ',
      episodeId: 'ep010-cleopatra',
      mode: 'auto',
    });
    fs.writeFileSync(
      path.join(ep, 'episode.json'),
      JSON.stringify({ episodeId: 'ep010-cleopatra', subject: 'クレオパトラ', status: 'render_ready' }),
    );
    procs[0].push(initLine('sStale', path.join(root, 'ch1')));
    procs[0].push(resultLine('sStale', '<done>完了</done>'));
    await new Promise((r) => setTimeout(r, 20));
    procs[0].emitExit(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(mgr.get(j.id)!.status).toBe('succeeded');
    expect(calls).toEqual([['ch1', 'ep010-cleopatra']]); // stale窓で取りこぼさない
  });

  it('restore後(このプロセスで書いていないジョブ)のreadLogは、ファイル末尾512KiBのtail読みで返す(全量は読まない)', () => {
    const dir = path.join(root, 'factory-ui', 'jobs', 'big-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        id: 'big-1', dir: 'ch1', operation: 'theme-scout', title: 'x',
        status: 'interrupted', createdAt: 1, updatedAt: 1, stages: [], artifacts: [],
        mode: 'manual', model: 'opus', effort: 'xhigh', request: { arg: '' },
      }),
    );
    // 512KiBを超えるログファイルを直接用意する(1行2000バイト級 × 300行 ≒ 600KB)。
    // 総行数はMAX_LOG_READ_LINES(2000)よりずっと少ないので、旧実装(全文readFileSync+末尾2000行slice)
    // なら300行全部が返るはず。tail読み(末尾512KiBのみ)なら一部の先頭行が欠けるので行数が減る。
    const totalLines = 300;
    const lines: string[] = [];
    for (let i = 0; i < totalLines; i++) {
      lines.push(`L${String(i).padStart(4, '0')}:${'x'.repeat(2000)}`);
    }
    fs.writeFileSync(path.join(dir, 'log.jsonl'), lines.join('\n') + '\n');
    m.restore(); // status=interrupted なので新規spawnはされない
    const got = m.readLog('big-1');
    expect(got).toBeDefined();
    expect(got!.length).toBeGreaterThan(0);
    expect(got!.length).toBeLessThan(totalLines); // 512KiB上限でファイル全体は読み込まない
    expect(got![got!.length - 1]).toBe(lines[totalLines - 1]); // 末尾行は正しく読める
    expect(got![0]!.startsWith('L')).toBe(true); // 先頭行は途中で切れた壊れた行ではない
  });

  describe('video-create フェーズチェーン', () => {
    function makeEpisode(epId: string, subject: string, status: string) {
      const epDir = path.join(root, 'ch1', 'episodes', epId);
      fs.mkdirSync(epDir, { recursive: true });
      fs.writeFileSync(
        path.join(epDir, 'episode.json'),
        JSON.stringify({ episodeId: epId, subject, status }),
      );
    }

    it('create時: phaseIndex=0、プロンプトにP1の担当範囲が入る', () => {
      const j = m.create({ dir: 'ch1', operation: 'video-create', arg: '織田信長' });
      expect(m.get(j.id)!.phaseIndex).toBe(0);
      expect(procs[0].args[1]).toContain('工程0〜3');
    });

    it('P1の<done>終了で succeeded にせず、新規セッション(--resumeなし)でP2を起動する', async () => {
      makeEpisode('ep001-x', '織田信長', 'scripted');
      const j = m.create({ dir: 'ch1', operation: 'video-create', arg: '織田信長' });
      procs[0].push(initLine('sid-p1', path.join(root, 'ch1')));
      procs[0].push(resultLine('sid-p1', `台本審査PASS ${DONE}`));
      await new Promise((r) => setTimeout(r, 20));
      procs[0].emitExit(0);
      await new Promise((r) => setTimeout(r, 30));
      const d = m.get(j.id)!;
      expect(d.status).toBe('running');
      expect(d.phaseIndex).toBe(1);
      expect(d.request.episodeId).toBe('ep001-x'); // 引き継ぎ時にepisodeIdを確定
      expect(procs.length).toBe(2);
      expect(procs[1].args[0]).toBe('-p');
      expect(procs[1].args).not.toContain('--resume');
      expect(procs[1].args[1]).toContain('工程4〜6');
      expect(procs[1].args[1]).toContain('ep001-x');
    });

    it('最終フェーズ(P5)の<done>で succeeded になる', async () => {
      makeEpisode('ep002-y', 'カエサル', 'packaged');
      const j = m.create({ dir: 'ch1', operation: 'video-create', arg: '', episodeId: 'ep002-y' });
      // episodeId指定+status packaged → 開始フェーズ4(最終)
      expect(m.get(j.id)!.phaseIndex).toBe(4);
      expect(procs[0].args[1]).toContain('工程11〜12');
      procs[0].push(initLine('sid-p3', path.join(root, 'ch1')));
      procs[0].push(resultLine('sid-p3', `完了 ${DONE}`));
      await new Promise((r) => setTimeout(r, 20));
      procs[0].emitExit(0);
      await new Promise((r) => setTimeout(r, 30));
      expect(m.get(j.id)!.status).toBe('succeeded');
      expect(procs.length).toBe(1); // 次フェーズは起動しない
    });

    it('エピソードを特定できないままP1が<done>したら failed(エラーメッセージつき)', async () => {
      const j = m.create({ dir: 'ch1', operation: 'video-create', arg: '見つからない題材' });
      procs[0].push(initLine('sid-nf', path.join(root, 'ch1')));
      procs[0].push(resultLine('sid-nf', DONE));
      await new Promise((r) => setTimeout(r, 20));
      procs[0].emitExit(0);
      await new Promise((r) => setTimeout(r, 30));
      const d = m.get(j.id)!;
      expect(d.status).toBe('failed');
      expect(d.error).toContain('エピソード');
      expect(procs.length).toBe(1);
    });

    it('フェーズ途中のexit≠0はfailed。resumeは現フェーズの範囲指示つきで--resume再開する', async () => {
      makeEpisode('ep003-z', '信玄', 'voiced');
      const j = m.create({ dir: 'ch1', operation: 'video-create', arg: '', episodeId: 'ep003-z' });
      expect(m.get(j.id)!.phaseIndex).toBe(1);
      procs[0].push(initLine('sid-f', path.join(root, 'ch1')));
      await new Promise((r) => setTimeout(r, 20));
      procs[0].emitExit(1);
      await new Promise((r) => setTimeout(r, 30));
      expect(m.get(j.id)!.status).toBe('failed');
      m.resume(j.id);
      expect(procs.length).toBe(2);
      expect(procs[1].args).toContain('--resume');
      expect(procs[1].args.some((a) => a.includes('工程4〜6'))).toBe(true);
    });

    it('restore互換: phaseIndexの無い旧running ジョブは interrupted になり、<done>で従来どおり完走できる', async () => {
      // 旧形式のstate.json(phaseIndexなし)を直接書いてrestoreする
      const oldId = 'legacy-job-1';
      const jdir = path.join(root, 'factory-ui', 'jobs', oldId);
      fs.mkdirSync(jdir, { recursive: true });
      fs.writeFileSync(
        path.join(jdir, 'state.json'),
        JSON.stringify({
          id: oldId, dir: 'ch1', operation: 'video-create', title: 'x', status: 'running',
          createdAt: Date.now(), updatedAt: Date.now(),
          mode: 'manual', model: 'opus', effort: 'xhigh', request: { arg: 'x' },
          sessionId: 'sid-legacy', stages: [], artifacts: [],
        }),
      );
      m.restore();
      const d = m.get(oldId)!;
      expect(d.status).toBe('interrupted');
      expect(d.phaseIndex).toBeUndefined();
      m.resume(oldId);
      const p = procs[procs.length - 1];
      expect(p.args.some((a) => a.includes('担当範囲'))).toBe(false); // 旧ジョブに範囲指示を付けない
      p.push(resultLine('sid-legacy', DONE));
      await new Promise((r) => setTimeout(r, 20));
      p.emitExit(0);
      await new Promise((r) => setTimeout(r, 30));
      expect(m.get(oldId)!.status).toBe('succeeded'); // フェーズチェーンに入らない
    });
  });
});

// spawn失敗の防御(2026-07-16 fd枯渇でのspawn EBADF座礁対策)
describe('JobManager spawn失敗', () => {
  let root: string;

  beforeEach(() => {
    _clearProgressCache();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-jobs-spawnfail-'));
    fs.mkdirSync(path.join(root, 'ch1'));
    fs.writeFileSync(path.join(root, 'ch1', '.channel-system.json'), JSON.stringify({ channelId: 'ch1' }));
  });

  it('create時にspawnFnが同期throwしたら failed になり error に原因を含む(座礁しない)', () => {
    const m = new JobManager(root, () => {
      throw new Error('spawn EBADF');
    });
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    const d = m.get(j.id)!;
    expect(d.status).toBe('failed');
    expect(d.error).toContain('spawn EBADF');
  });

  it('respondGate時にspawnFnが同期throwしたら failed になる(running×プロセスなしで残らない)', async () => {
    const procs: FakeProc[] = [];
    let broken = false;
    const m = new JobManager(root, (args, opts) => {
      if (broken) throw new Error('spawn EBADF');
      const p = new FakeProc(args, opts.cwd);
      procs.push(p);
      return { stdout: p.stdout, onExit: (cb) => p.onExit(cb), kill: () => p.kill() };
    });
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sid-f', path.join(root, 'ch1')));
    procs[0].push(textLine(GATE));
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get(j.id)!.status).toBe('awaiting_gate');
    broken = true;
    m.respondGate(j.id, 'yes');
    const d = m.get(j.id)!;
    expect(d.status).toBe('failed');
    expect(d.error).toContain('spawn EBADF');
    // failed なので resume で復旧できる
    broken = false;
    m.resume(j.id);
    expect(m.get(j.id)!.status).toBe('running');
    expect(procs[1].args).toContain('--resume');
  });

  it('makeClaudeSpawn は起動失敗(errorイベント)を onExit(-1) として通知する', async () => {
    const spawnBroken = makeClaudeSpawn('definitely-not-a-real-binary-xyz');
    const p = spawnBroken(['-p', 'hi'], { cwd: root });
    const code = await new Promise<number>((resolve) => p.onExit(resolve));
    expect(code).toBe(-1);
  });
});

describe('JobManager killAll(サーバー終了時の道連れkill)', () => {
  let root: string;
  let procs: FakeProc[];
  let m: JobManager;

  beforeEach(() => {
    _clearProgressCache();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-jobs-'));
    fs.mkdirSync(path.join(root, 'ch1'));
    fs.mkdirSync(path.join(root, 'ch2'));
    fs.writeFileSync(path.join(root, 'ch1', '.channel-system.json'), JSON.stringify({ channelId: 'ch1' }));
    fs.writeFileSync(path.join(root, 'ch2', '.channel-system.json'), JSON.stringify({ channelId: 'ch2' }));
    procs = [];
    const spawnFn: SpawnClaude = (args, opts) => {
      const p = new FakeProc(args, opts.cwd);
      procs.push(p);
      return { stdout: p.stdout, onExit: (cb) => p.onExit(cb), kill: () => p.kill() };
    };
    m = new JobManager(root, spawnFn);
  });

  it('running ジョブの proc を kill し interrupted へ。kill由来の遅延exitで状態が汚れない', () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    m.killAll();
    expect(procs[0].killed).toBe(true);
    // FakeProc.kill() は exit(143) を同期発火する — 世代無効化により interrupted のまま
    const d = m.get(j.id)!;
    expect(d.status).toBe('interrupted');
    expect(d.error).toBeUndefined();
  });

  it('interrupted が state.json に即時永続化される(restore不要でディスクも正しい)', () => {
    const j = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    m.killAll();
    const st = JSON.parse(
      fs.readFileSync(path.join(root, 'factory-ui', 'jobs', j.id, 'state.json'), 'utf8'),
    );
    expect(st.status).toBe('interrupted');
  });

  it('終了状態のジョブには触らない。複数running は全て止まる', async () => {
    const j1 = m.create({ dir: 'ch1', operation: 'video-create', arg: 'x' });
    procs[0].push(initLine('sid1', path.join(root, 'ch1')));
    await new Promise((r) => setTimeout(r, 10));
    m.cancel(j1.id);
    expect(m.get(j1.id)!.status).toBe('cancelled');
    const j2 = m.create({ dir: 'ch1', operation: 'video-create', arg: 'y' });
    const j3 = m.create({ dir: 'ch2', operation: 'video-create', arg: 'z' });
    procs[1].push(initLine('sid2', path.join(root, 'ch1')));
    await new Promise((r) => setTimeout(r, 10));
    m.killAll();
    expect(m.get(j1.id)!.status).toBe('cancelled');
    expect(m.get(j2.id)!.status).toBe('interrupted');
    expect(m.get(j3.id)!.status).toBe('interrupted');
    // interrupted は resume で --resume 再開できる(既存機構との整合)
    expect(() => m.resume(j2.id)).not.toThrow();
  });
});
