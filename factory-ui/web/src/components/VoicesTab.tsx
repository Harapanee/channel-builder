import { useCallback, useEffect, useState } from 'react';
import type { VoiceEntry } from '../../../shared/types';
import { getVoices, mediaUrl } from '../api';

/**
 * 音声試聴: voice-samples/ 配下の .wav/.mp3 を <audio controls> のリストで並べる。
 * サーバー側で名前順ソート済み(server/media.ts の listVoices)。
 * この一覧は fs-update の対象外(watcher.ts の classify は音声素材を分類しない)ため
 * 購読はせず、dir 切り替え時にのみ再取得する。
 */
export function VoicesTab({ dir }: { dir: string }) {
  const [voices, setVoices] = useState<VoiceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await getVoices(dir);
      setVoices(res.voices);
      setLoadError(null);
    } catch (e) {
      setLoadError(`音声一覧の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [dir]);

  useEffect(() => {
    setVoices([]);
    setLoading(true);
    setLoadError(null);
    reload();
  }, [dir, reload]);

  if (loadError) {
    return <span style={{ color: 'var(--status-err)' }}>{loadError}</span>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
        このチャンネルのナレーション音声は channel/voice.json で固定されています(変更禁止)。以下は試聴用サンプルです。
      </span>

      {loading ? (
        <div className="empty">読み込み中…</div>
      ) : voices.length === 0 ? (
        <div className="empty">音声サンプルなし</div>
      ) : (
        voices.map((voice) => (
          <div
            key={voice.path}
            className="panel"
            style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '16px' }}
          >
            <div style={{ minWidth: '200px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {/* IDを見出し扱いにする: ハイフンを空白に開いた表示名を主、生のIDを従で併記 */}
              <span style={{ fontWeight: 600, fontSize: '14px' }}>{displayName(voice.name)}</span>
              <span className="mono" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                {voice.name}
              </span>
            </div>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio controls src={mediaUrl(dir, voice.path)} style={{ flex: 1, minWidth: 0 }} />
          </div>
        ))
      )}
    </div>
  );
}

/** "aoyama-ryusei-normal" のようなIDのハイフンを空白に開いて見出しらしくする */
function displayName(id: string): string {
  return id.split('-').filter(Boolean).join(' ');
}
