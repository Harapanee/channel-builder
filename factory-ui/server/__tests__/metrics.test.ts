import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { collectMetrics } from '../metrics';
import { SessionManager } from '../sessions';
import { JobManager } from '../jobs';
import { RenderQueueManager } from '../render-queue';
import { createApiRouter } from '../api';

/** episodes/<id>/episode.json を書く小道具(statusのみ関心事)。 */
function writeEpisode(channelDir: string, epId: string, status?: string): void {
  const epDir = path.join(channelDir, 'episodes', epId);
  fs.mkdirSync(epDir, { recursive: true });
  if (status !== undefined) {
    fs.writeFileSync(path.join(epDir, 'episode.json'), JSON.stringify({ status }));
  }
}

describe('metrics', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-metrics-'));

    // --- chan-a: metrics配列(非数値混在)+ episode 3件(final2)+ episode.json不在1件 ---
    const chanA = path.join(root, 'chan-a');
    fs.mkdirSync(chanA, { recursive: true });
    fs.writeFileSync(
      path.join(chanA, '.channel-system.json'),
      JSON.stringify({
        channelId: 'UCA',
        channelName: 'Channel A',
        metrics: [
          { episodeId: 'ep001', renderMinutes: 12, wallClockHours: 1.5, imageGenCount: 20 },
          { episodeId: 'ep002', renderMinutes: 8, wallClockHours: 0.5, imageGenCount: 5 },
          // 非数値/欠落は0扱い
          { episodeId: 'ep003', renderMinutes: 'oops', imageGenCount: null },
        ],
      }),
    );
    writeEpisode(chanA, 'ep001', 'final');
    writeEpisode(chanA, 'ep002', 'draft');
    writeEpisode(chanA, 'ep003', 'final');
    writeEpisode(chanA, 'ep004-nometa'); // episode.json 不在 → episodeCountに含めない

    // --- chan-b: metricsキー自体が無い(空扱い)+ episode 1件(final) ---
    const chanB = path.join(root, 'chan-b');
    fs.mkdirSync(chanB, { recursive: true });
    fs.writeFileSync(
      path.join(chanB, '.channel-system.json'),
      JSON.stringify({ channelId: 'UCB', channelName: 'Channel B' }),
    );
    writeEpisode(chanB, 'ep010', 'final');

    // --- chan-broken: .channel-system.json が壊れている → スキップ対象 ---
    const chanBroken = path.join(root, 'chan-broken');
    fs.mkdirSync(chanBroken, { recursive: true });
    fs.writeFileSync(path.join(chanBroken, '.channel-system.json'), '{ not valid json ');

    // --- 非チャンネルディレクトリ(除外されるべき) ---
    fs.mkdirSync(path.join(root, 'factory-ui'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('collectMetrics', () => {
    it('チャンネルごとの集計値を返す(dirソート済み)', () => {
      const res = collectMetrics(root);
      expect(res.channels.map((c) => c.dir)).toEqual(['chan-a', 'chan-b']);

      const a = res.channels.find((c) => c.dir === 'chan-a')!;
      expect(a.channelName).toBe('Channel A');
      expect(a.episodeCount).toBe(3); // ep001,ep002,ep003(ep004-nometaは除外)
      expect(a.finalCount).toBe(2); // ep001,ep003
      expect(a.renderMinutesTotal).toBe(20); // 12+8+0
      expect(a.wallClockHoursTotal).toBe(2); // 1.5+0.5+0
      expect(a.imageGenTotal).toBe(25); // 20+5+0

      const b = res.channels.find((c) => c.dir === 'chan-b')!;
      expect(b.channelName).toBe('Channel B');
      expect(b.episodeCount).toBe(1);
      expect(b.finalCount).toBe(1);
      expect(b.renderMinutesTotal).toBe(0);
      expect(b.wallClockHoursTotal).toBe(0);
      expect(b.imageGenTotal).toBe(0);
    });

    it('非チャンネルディレクトリ(factory-ui/node_modules)は含まれない', () => {
      const res = collectMetrics(root);
      const dirs = res.channels.map((c) => c.dir);
      expect(dirs).not.toContain('factory-ui');
      expect(dirs).not.toContain('node_modules');
    });

    it('.channel-system.jsonが壊れたチャンネルはスキップしconsole.errorを呼ぶ', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = collectMetrics(root);
        expect(res.channels.map((c) => c.dir)).not.toContain('chan-broken');
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('totalsは全チャンネルの同名フィールド合計(dir/channelNameを除く)', () => {
      const res = collectMetrics(root);
      expect(res.totals).toEqual({
        episodeCount: 4,
        finalCount: 3,
        renderMinutesTotal: 20,
        wallClockHoursTotal: 2,
        imageGenTotal: 25,
      });
    });

    it('episode.jsonが存在するが壊れているエピソードはカウントしない(他の正常エピソードは数える)', () => {
      // 既存フィクスチャのtotals期待値を揺らさないよう、専用の一時rootで検証する
      const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-metrics-brokenep-'));
      try {
        const chan = path.join(broken, 'chan-c');
        fs.mkdirSync(chan, { recursive: true });
        fs.writeFileSync(
          path.join(chan, '.channel-system.json'),
          JSON.stringify({ channelId: 'UCC', channelName: 'Channel C' }),
        );
        writeEpisode(chan, 'ep001', 'final'); // 正常(final)
        writeEpisode(chan, 'ep002', 'draft'); // 正常(非final)
        // ep003: episode.json は存在するがJSONとして壊れている → episodeCount/finalCount 対象外
        const ep3 = path.join(chan, 'episodes', 'ep003-broken');
        fs.mkdirSync(ep3, { recursive: true });
        fs.writeFileSync(path.join(ep3, 'episode.json'), '{ not valid json ');

        const res = collectMetrics(broken);
        expect(res.channels.map((c) => c.dir)).toEqual(['chan-c']); // チャンネル自体はスキップされない
        const c = res.channels[0]!;
        expect(c.episodeCount).toBe(2); // ep001,ep002(壊れたep003-brokenは数えない)
        expect(c.finalCount).toBe(1); // ep001のみ
        expect(res.totals.episodeCount).toBe(2);
        expect(res.totals.finalCount).toBe(1);
      } finally {
        fs.rmSync(broken, { recursive: true, force: true });
      }
    });

    it('空rootはchannels:[]・totalsは全フィールド0', () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fui-metrics-empty-'));
      try {
        const res = collectMetrics(empty);
        expect(res.channels).toEqual([]);
        expect(res.totals).toEqual({
          episodeCount: 0,
          finalCount: 0,
          renderMinutesTotal: 0,
          wallClockHoursTotal: 0,
          imageGenTotal: 0,
        });
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  describe('GET /api/metrics', () => {
    it('200 + {channels, totals} の形状を返す', async () => {
      const app = express();
      app.use(express.json());
      app.use(
        '/api',
        createApiRouter({
          root,
          sessions: new SessionManager(root),
          jobs: new JobManager(root),
          renderQueue: new RenderQueueManager(root),
        }),
      );

      const res = await request(app).get('/api/metrics');
      expect(res.status).toBe(200);
      expect(res.body.channels.map((c: { dir: string }) => c.dir)).toEqual(['chan-a', 'chan-b']);
      expect(res.body.totals).toEqual({
        episodeCount: 4,
        finalCount: 3,
        renderMinutesTotal: 20,
        wallClockHoursTotal: 2,
        imageGenTotal: 25,
      });
    });
  });
});
