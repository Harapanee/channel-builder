// Task 15 構造検証用サーバー: JobManager に FakeSpawn を注入し、実 claude を呼ばずに
// ジョブ→ゲート→再開→完了の全経路(REST+WS+UI)を駆動できるようにする。
// 実行: SMOKE_PORT=4701 npx tsx spike/smoke-server.ts
import path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import { config } from '../server/config';
import { createApiRouter } from '../server/api';
import { SessionManager } from '../server/sessions';
import { createWatcher } from '../server/watcher';
import { attachWsHub } from '../server/wshub';
import { JobManager, type SpawnClaude } from '../server/jobs';
import { isLocalRequest } from '../server/guards';

const PORT = Number(process.env.SMOKE_PORT ?? 4701);

// スクリプト化された疑似 claude。初回はinit→gateを出して停止、--resumeでresult成功を出す。
const fakeSpawn: SpawnClaude = (args) => {
  const stdout = new Readable({ read() {} });
  const isResume = args.includes('--resume');
  let exitCb: (code: number) => void = () => {};
  const push = (obj: unknown) => stdout.push(JSON.stringify(obj) + '\n');

  setTimeout(() => {
    if (isResume) {
      push({ type: 'assistant', message: { content: [{ type: 'text', text: '素材を採用して続行しました。' }] } });
      push({ type: 'result', subtype: 'success', session_id: 'smoke-sid', result: '完了しました。' });
      exitCb(0);
    } else {
      push({ type: 'system', subtype: 'init', session_id: 'smoke-sid', cwd: 'x' });
      push({ type: 'assistant', message: { content: [{ type: 'text', text: '調査と台本を準備しています…' }] } });
      push({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: '<gate>{"gateId":"g1","question":"生成した5枚の素材を採用しますか?","options":[{"id":"approve","label":"採用","description":"この5枚で進める"},{"id":"regen","label":"再生成","description":"作り直す"}],"context":"キャラクター変種を5枚生成しました"}</gate>',
            },
          ],
        },
      });
      exitCb(0); // ゲートで停止(JobManagerはawaiting_gate、exitは無視される)
    }
  }, 300);

  return {
    stdout,
    onExit: (cb) => {
      exitCb = cb;
    },
    kill: () => exitCb(143),
  };
};

const app = express();
const sessions = new SessionManager(config.root);
const watcher = createWatcher(config.root);
const jobs = new JobManager(config.root, fakeSpawn);
jobs.restore();

app.use((req, res, next) => {
  if (!isLocalRequest(req.headers)) {
    res.status(403).end();
    return;
  }
  next();
});
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use(express.json());
app.use('/api', createApiRouter({ root: config.root, sessions, jobs }));
app.use(express.static(path.join(import.meta.dirname, '..', 'web', 'dist')));

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`smoke server on http://127.0.0.1:${PORT}`);
});
attachWsHub(server, sessions, watcher, jobs);
