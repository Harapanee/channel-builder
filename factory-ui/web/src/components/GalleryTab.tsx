import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ImageEntry } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import { curateLibrary, getFileText, getImages, mediaUrl, sendInput, type CurateDecision } from '../api';

type LibraryAsset = { assetId: string; file: string; approvedBy: string };

/**
 * 素材ギャラリー: assets/、episodes/ 配下各エピソード、scratchpad_gen/ の画像を mtime 降順で並べる。
 *
 * - タイル(.tile)クリックで選択トグル(.tile.selected)。タイル右上の「拡大」ボタンは
 *   選択トグルとは独立していて(stopPropagation)、モーダルで大きめのプレビューを開く。
 * - 1件以上選択すると下部に編集可能なテキストエリアが現れる。初期値は選択中ファイル名から
 *   自動生成し、選択が変わるたびに追従する。ただしユーザーが一度手で編集したら、
 *   選択を全解除するまでは自動追従を止める(textEdited で追跡)。
 * - fs-update(kind:'images', dir が一致)を受けたら一覧を再取得する
 *   (生成直後のバリアントが mtime 降順で先頭に現れる)。
 *
 * 素材キュレーション(直接編集): assets/library.json を getFileText 経由で読み、
 * ImageEntry.path(チャンネルdir相対。例 "assets/characters/x.png")から
 * "assets/" を除いた相対パスで library.json の asset.file と突き合わせて assetId を逆引きする。
 * 一致した画像だけ、拡大モーダルに「採用/却下」(curateLibrary)を出す
 * (未登録画像 = episodes/ や scratchpad_gen/ の生成候補には出さない)。
 */
export function GalleryTab({
  dir,
  ws,
  activeSessionId,
}: {
  dir: string;
  ws: FactoryWS;
  activeSessionId: string | null;
}) {
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [textEdited, setTextEdited] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const [libraryByFile, setLibraryByFile] = useState<Map<string, LibraryAsset>>(new Map());
  const [curating, setCurating] = useState(false);
  const [curateError, setCurateError] = useState<string | null>(null);
  const [curateMessage, setCurateMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await getImages(dir);
      setImages(res.images);
      setLoadError(null);
    } catch (e) {
      setLoadError(`素材一覧の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [dir]);

  const reloadLibrary = useCallback(async () => {
    try {
      const raw = await getFileText(dir, 'assets/library.json');
      const parsed = JSON.parse(raw) as { assets?: unknown };
      const map = new Map<string, LibraryAsset>();
      if (Array.isArray(parsed.assets)) {
        for (const a of parsed.assets) {
          if (
            a &&
            typeof a === 'object' &&
            typeof (a as Record<string, unknown>).assetId === 'string' &&
            typeof (a as Record<string, unknown>).file === 'string'
          ) {
            const entry = a as Record<string, unknown>;
            const file = entry.file as string;
            map.set(file, {
              assetId: entry.assetId as string,
              file,
              approvedBy: typeof entry.approvedBy === 'string' ? entry.approvedBy : '',
            });
          }
        }
      }
      setLibraryByFile(map);
    } catch {
      // assets/library.json が無い・壊れている場合は素材キュレーションUIを単に出さない(ギャラリー自体は動く)
      setLibraryByFile(new Map());
    }
  }, [dir]);

  useEffect(() => {
    setImages([]);
    setLoadError(null);
    setSelected(new Set());
    setPreviewPath(null);
    setText('');
    setTextEdited(false);
    setSendError(null);
    setSent(false);
    setLibraryByFile(new Map());
    setCurateError(null);
    setCurateMessage(null);
    reload();
    reloadLibrary();
  }, [dir, reload, reloadLibrary]);

  useEffect(() => {
    return ws.onMessage((msg) => {
      if (msg.type === 'fs-update' && msg.dir === dir && msg.kind === 'images') {
        reload();
      }
    });
  }, [ws, dir, reload]);

  useEffect(() => {
    if (!previewPath) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewPath(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewPath]);

  const selectedImages = useMemo(
    () => images.filter((img) => selected.has(img.path)),
    [images, selected],
  );

  // 未編集なら、選択変更のたびにテキストエリアの初期値を再生成して追従させる。
  useEffect(() => {
    if (textEdited) return;
    if (selectedImages.length === 0) {
      setText('');
      return;
    }
    const names = selectedImages.map((img) => basename(img.path));
    setText(`以下の素材を採用: ${names.join(', ')}`);
  }, [selectedImages, textEdited]);

  function toggleSelect(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      if (next.size === 0) setTextEdited(false); // 全解除したら次の選択で自動追従を復帰
      return next;
    });
    setSendError(null);
    setSent(false);
  }

  async function send() {
    if (!activeSessionId || selected.size === 0) return;
    setSending(true);
    setSendError(null);
    setSent(false);
    try {
      await sendInput(activeSessionId, text, true);
      setSent(true);
    } catch (e) {
      setSendError(`送信に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  }

  function libraryAssetFor(path: string): LibraryAsset | null {
    if (!path.startsWith('assets/')) return null;
    return libraryByFile.get(path.slice('assets/'.length)) ?? null;
  }

  async function curate(assetId: string, decision: CurateDecision) {
    if (curating) return;
    if (decision === 'reject') {
      const ok = window.confirm(
        `素材 ${assetId} を library.json から削除します(元の画像ファイル自体は残ります)。よろしいですか?`,
      );
      if (!ok) return;
    }
    setCurating(true);
    setCurateError(null);
    setCurateMessage(null);
    try {
      await curateLibrary(dir, assetId, decision);
      setCurateMessage(decision === 'approve' ? '採用しました' : '却下しました');
      await reloadLibrary();
      if (decision === 'reject') {
        setPreviewPath(null);
      }
    } catch (e) {
      setCurateError(`キュレーションに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCurating(false);
    }
  }

  const preview = previewPath ? (images.find((img) => img.path === previewPath) ?? null) : null;
  const previewAsset = preview ? libraryAssetFor(preview.path) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {loadError && <span style={{ color: 'var(--status-err)' }}>{loadError}</span>}

      {images.length === 0 && !loadError ? (
        <div className="empty">素材がまだありません</div>
      ) : (
        <div className="gallery-grid">
          {images.map((img) => {
            const name = basename(img.path);
            const isSelected = selected.has(img.path);
            return (
              <div
                key={img.path}
                className={`tile${isSelected ? ' selected' : ''}`}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                title={name}
                onClick={() => toggleSelect(img.path)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleSelect(img.path);
                  }
                }}
              >
                <img src={mediaUrl(dir, img.path)} alt={name} loading="lazy" />
                <button
                  type="button"
                  className="tile-zoom"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurateError(null);
                    setCurateMessage(null);
                    setPreviewPath(img.path);
                  }}
                >
                  拡大
                </button>
              </div>
            );
          })}
        </div>
      )}

      {selected.size > 0 && (
        <div
          className="panel"
          style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}
        >
          <span className="mono">選択: {selected.size}件</span>
          <textarea
            className="editor"
            style={{ minHeight: '84px' }}
            value={text}
            rows={3}
            onChange={(e) => {
              setText(e.target.value);
              setTextEdited(true);
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button className="btn btn-primary" disabled={!activeSessionId || sending} onClick={send}>
              セッションへ送信
            </button>
            {!activeSessionId && (
              <span className="mono">稼働中のジョブがありません(ジョブタブから操作を起動してください)</span>
            )}
            {sent && <span style={{ color: 'var(--status-ok)' }}>送信済み</span>}
            {sendError && <span style={{ color: 'var(--status-err)' }}>{sendError}</span>}
          </div>
        </div>
      )}

      {preview && (
        <div className="modal-backdrop" onClick={() => setPreviewPath(null)}>
          <div
            className="panel modal"
            role="dialog"
            aria-modal="true"
            aria-label={basename(preview.path)}
            onClick={(e) => e.stopPropagation()}
          >
            <img src={mediaUrl(dir, preview.path)} alt={basename(preview.path)} />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
              }}
            >
              <span className="mono">{basename(preview.path)}</span>
              <button className="btn btn-ghost" onClick={() => setPreviewPath(null)}>
                閉じる
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {previewAsset ? (
                <>
                  <span className="mono">
                    library.json: {previewAsset.assetId}(現在の状態:{' '}
                    {previewAsset.approvedBy === 'human'
                      ? '採用済み'
                      : previewAsset.approvedBy || '未採用'}
                    )
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <button
                      className="btn btn-ghost"
                      disabled={curating}
                      onClick={() => curate(previewAsset.assetId, 'approve')}
                    >
                      採用
                    </button>
                    <button
                      className="btn btn-danger"
                      disabled={curating}
                      onClick={() => curate(previewAsset.assetId, 'reject')}
                    >
                      却下
                    </button>
                    {curateMessage && <span style={{ color: 'var(--status-ok)' }}>{curateMessage}</span>}
                    {curateError && <span style={{ color: 'var(--status-err)' }}>{curateError}</span>}
                  </div>
                </>
              ) : (
                <span className="mono">library.json に未登録の画像です(直接編集の対象外)</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}
