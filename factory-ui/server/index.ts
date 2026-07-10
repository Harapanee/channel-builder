import path from 'node:path';
import express from 'express';
import { config } from './config';
import { createApiRouter } from './api';
import { SessionManager } from './sessions';
import { createWatcher } from './watcher';
import { attachWsHub } from './wshub';
import { isLocalRequest } from './guards';
import { JobManager } from './jobs';
import { RenderQueueManager } from './render-queue';
import { StudioManager } from './studio';
import { YoutubeManager } from './youtube';
import { loadYoutubeApi } from './youtube-google';

const app = express();
const sessions = new SessionManager(config.root);
const watcher = createWatcher(config.root);
const renderQueue = new RenderQueueManager(config.root);
renderQueue.restore();
// render-check承認(またはauto成功)で夜間レンダーキューへ登録する
const jobs = new JobManager(config.root, undefined, {
  enqueueRender: (dir, epId) => renderQueue.enqueueFromGate(dir, epId),
});
jobs.restore();
// render-check目視確認用のRemotion Studio(サーバー終了時に道連れで止める)
const studio = new StudioManager(config.root);
// YouTubeアップロード管理(client未設置時はnullで初期化し、authルートで503を返す)
const youtubeRedirectUri = `http://127.0.0.1:${config.port}/api/youtube/callback`;
const youtube = new YoutubeManager(config.root, () => loadYoutubeApi(config.root, youtubeRedirectUri));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    studio.stop();
    process.exit(0);
  });
}

// 悪意あるWebページからのDNS rebinding / クロスオリジンのドライブバイを拒否(全リクエスト)
app.use((req, res, next) => {
  if (!isLocalRequest(req.headers)) {
    res.status(403).end();
    return;
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use(express.json());
app.use('/api', createApiRouter({ root: config.root, sessions, jobs, renderQueue, studio, youtube, youtubeRedirectUri }));

app.use(express.static(path.join(import.meta.dirname, '..', 'web', 'dist')));

const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`factory-ui server listening on http://127.0.0.1:${config.port}`);
});

attachWsHub(server, sessions, watcher, jobs, renderQueue, youtube);
