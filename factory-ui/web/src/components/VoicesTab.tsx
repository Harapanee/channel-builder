import { useCallback, useEffect, useState } from 'react';
import type { VoiceEntry } from '../../../shared/types';
import { getVoices, mediaUrl } from '../api';

/**
 * 音声試聴: voice-samples/ 配下の .wav/.mp3 を <audio controls> のリストで並べる。
 * サーバー側で名前順ソート済み(server/media.ts の listVoices)。
 * この一覧は fs-update の対象外(watcher.ts の classify は画像のみを 'images' に分類する)ため
 * 購読はせず、dir 切り替え時にのみ再取得する。
 */
export function VoicesTab({ dir }: { dir: string }) {
  const [voices, setVoices] = useState<VoiceEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await getVoices(dir);
      setVoices(res.voices);
      setLoadError(null);
    } catch (e) {
      setLoadError(`音声一覧の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [dir]);

  useEffect(() => {
    setVoices([]);
    setLoadError(null);
    reload();
  }, [dir, reload]);

  if (loadError) {
    return <span style={{ color: 'var(--status-err)' }}>{loadError}</span>;
  }

  if (voices.length === 0) {
    return <div className="empty">音声サンプルなし</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {voices.map((voice) => (
        <div
          key={voice.path}
          className="panel"
          style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '16px' }}
        >
          <span className="mono" style={{ minWidth: '160px' }}>
            {voice.name}
          </span>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio controls src={mediaUrl(dir, voice.path)} style={{ flex: 1, minWidth: 0 }} />
        </div>
      ))}
    </div>
  );
}
