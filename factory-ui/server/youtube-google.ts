import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import type { StoredToken, UploadParams, YoutubeApi } from './youtube';

// googleapis / google-auth-library の依存が重複解決され型が食い違うことがあるため、
// 明示的に google-auth-library から型をimportせず googleapis自身の戻り値型から導出する
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly', // 連携先チャンネル名の表示用
];

type ClientSecret = { client_id: string; client_secret: string };

/**
 * <root>/factory-ui/youtube-client.json からOAuthクライアントを構築する。
 * ファイル形式はGoogle Cloud Consoleのダウンロード形式({"installed":{...}} または {"web":{...}})。
 * 未設置なら null(YoutubeManager は no_client を返す)。
 */
export function loadYoutubeApi(root: string, redirectUri: string): YoutubeApi | null {
  const p = path.join(root, 'factory-ui', 'youtube-client.json');
  let secret: ClientSecret;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, ClientSecret | undefined>;
    const inner = raw.installed ?? raw.web;
    if (!inner?.client_id || !inner?.client_secret) return null;
    secret = inner;
  } catch {
    return null;
  }

  // OAuth2Clientは資格情報(トークン)を保持するため、呼び出しごとに生成する
  const makeClient = (token?: StoredToken, onToken?: (t: StoredToken) => void): OAuth2Client => {
    const client = new google.auth.OAuth2(secret.client_id, secret.client_secret, redirectUri);
    if (token) client.setCredentials(token);
    if (onToken) {
      client.on('tokens', (t) => {
        // refresh_tokenは初回発行時のみ届く。既存を失わないようマージして通知する
        onToken({ ...token, ...t } as StoredToken);
      });
    }
    return client;
  };

  return {
    generateAuthUrl(state) {
      return makeClient().generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // 再連携時にもrefresh_tokenを確実に得る
        scope: SCOPES,
        state,
      });
    },

    async exchangeCode(code) {
      const { tokens } = await makeClient().getToken(code);
      return tokens as StoredToken;
    },

    async getChannelTitle(token, onToken) {
      const auth = makeClient(token, onToken);
      const yt = google.youtube({ version: 'v3', auth });
      const res = await yt.channels.list({ part: ['snippet'], mine: true });
      return res.data.items?.[0]?.snippet?.title ?? '(チャンネル名不明)';
    },

    async upload(params: UploadParams) {
      const auth = makeClient(params.token, params.onToken);
      const yt = google.youtube({ version: 'v3', auth });
      const res = await yt.videos.insert(
        {
          part: ['snippet', 'status'],
          requestBody: {
            snippet: {
              title: params.meta.title,
              description: params.meta.description,
              tags: params.meta.tags,
              categoryId: params.meta.categoryId,
            },
            status: {
              privacyStatus: params.meta.privacyStatus,
              selfDeclaredMadeForKids: false,
            },
          },
          media: { body: fs.createReadStream(params.videoPath) },
        },
        {
          // googleapisはresumable uploadを自動選択する。進捗はaxios互換フック
          onUploadProgress: (evt: { bytesRead?: number; loaded?: number }) => {
            params.onProgress(evt.bytesRead ?? evt.loaded ?? 0);
          },
        },
      );
      const videoId = res.data.id;
      if (!videoId) throw new Error('アップロード応答にvideoIdがありません');
      return videoId;
    },

    async setThumbnail(token, videoId, thumbnailPath, onToken) {
      const auth = makeClient(token, onToken);
      const yt = google.youtube({ version: 'v3', auth });
      await yt.thumbnails.set({ videoId, media: { body: fs.createReadStream(thumbnailPath) } });
    },
  };
}
