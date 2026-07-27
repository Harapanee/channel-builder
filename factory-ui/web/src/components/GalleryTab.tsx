import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ImageEntry } from '../../../shared/types';
import type { FactoryWS } from '../ws';
import { curateLibrary, getFileText, getImages, mediaUrl, sendInput, type CurateDecision } from '../api';
import { useConfirm } from './ConfirmDialog';

type LibraryAsset = { assetId: string; file: string; approvedBy: string };

/**
 * 素材ギャラリー: assets/、episodes/ 配下各エピソード、scratchpad_gen/ の画像を mtime 降順で並べる。
 *
 * - タイル(.tile)は <button> で、クリックすると拡大モーダルを開く。
 *   選択トグルはタイル下のキャプション(チェックボックス+ファイル名)が担う
 *   (拡大と選択を1つのタイルに同居させつつ、button のネストを避けるための分担)。
 * - 検索ボックスでファイル名の部分一致フィルタができる。
 * - library.json 登録済み素材と未登録(サムネ・中間生成物等)はセクション見出しで分ける。
 * - 1件以上選択すると下部に編集可能なテキストエリアが現れる。初期値は選択中ファイル名から
 *   自動生成し、選択が変わるたびに追従する。ただしユーザーが一度手で編集したら、
 *   選択を全解除するまでは自動追従を止める(textEdited で追跡)。
 * - 画像のライブ更新はしない(watcherのfd枯渇対策で画像は監視対象外)。タブ表示時と
 *   WS再接続時にAPIで再取得する。
 * - ws-status(connected:true = 再接続)を受けたら切断中の取りこぼしを埋めるため再取得する。
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const [textEdited, setTextEdited] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const [libraryByFile, setLibraryByFile] = useState<Map<string, LibraryAsset>>(new Map());
  const [curating, setCurating] = useState(false);
  const [curateError, setCurateError] = useState<string | null>(null);
  const [curateMessage, setCurateMessage] = useState<string | null>(null);

  const confirm = useConfirm();
  // モーダルのフォーカス管理: 開いたら閉じるボタンへ、閉じたら開いた元のタイルへ戻す
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await getImages(dir);
      setImages(res.images);
      setLoadError(null);
    } catch (e) {
      setLoadError(`素材一覧の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
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
    setLoading(true);
    setLoadError(null);
    setSelected(new Set());
    setPreviewPath(null);
    setQuery('');
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
      if (msg.type === 'ws-status' && msg.connected) {
        // 再接続: 切断中の fs-update を取りこぼしている可能性があるため再取得
        reload();
        reloadLibrary();
      }
    });
  }, [ws, dir, reload, reloadLibrary]);

  function openPreview(path: string) {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCurateError(null);
    setCurateMessage(null);
    setPreviewPath(path);
  }

  const closePreview = useCallback(() => {
    setPreviewPath(null);
    restoreFocusRef.current?.focus();
    restoreFocusRef.current = null;
  }, []);

  useEffect(() => {
    if (!previewPath) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePreview();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewPath, closePreview]);

  // モーダルを開いたら閉じるボタンへフォーカス(ConfirmDialog と同じ流儀)
  useEffect(() => {
    if (previewPath) closeButtonRef.current?.focus();
  }, [previewPath]);

  function onModalKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Tab') return;
    // 簡易フォーカストラップ: モーダル内のボタン間で循環させる(ConfirmDialog と同じ実装)
    const focusables = modalRef.current?.querySelectorAll<HTMLElement>('button');
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

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

  const libraryAssetFor = useCallback(
    (path: string): LibraryAsset | null => {
      if (!path.startsWith('assets/')) return null;
      return libraryByFile.get(path.slice('assets/'.length)) ?? null;
    },
    [libraryByFile],
  );

  async function curate(assetId: string, decision: CurateDecision) {
    if (curating) return;
    if (decision === 'reject') {
      const ok = await confirm({
        title: `素材 ${assetId} を却下しますか?`,
        body: 'library.json から削除します(元の画像ファイル自体は残ります)。',
        confirmLabel: '却下する',
        danger: true,
      });
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
        closePreview();
      }
    } catch (e) {
      setCurateError(`キュレーションに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCurating(false);
    }
  }

  // 検索(ファイル名の部分一致・大文字小文字無視)→ 登録済み/未登録に分ける
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return images;
    return images.filter((img) => basename(img.path).toLowerCase().includes(q));
  }, [images, query]);

  const registered = useMemo(
    () => filtered.filter((img) => libraryAssetFor(img.path) !== null),
    [filtered, libraryAssetFor],
  );
  const unregistered = useMemo(
    () => filtered.filter((img) => libraryAssetFor(img.path) === null),
    [filtered, libraryAssetFor],
  );

  const preview = previewPath ? (images.find((img) => img.path === previewPath) ?? null) : null;
  const previewAsset = preview ? libraryAssetFor(preview.path) : null;

  function renderTiles(list: ImageEntry[]) {
    return (
      <div className="gallery-grid">
        {list.map((img) => {
          const name = basename(img.path);
          const isSelected = selected.has(img.path);
          return (
            <div key={img.path} className="gallery-item">
              <button
                type="button"
                className={`tile${isSelected ? ' selected' : ''}`}
                aria-label={`${name} を拡大表示`}
                title={name}
                onClick={() => openPreview(img.path)}
              >
                <img src={mediaUrl(dir, img.path)} alt={name} loading="lazy" />
              </button>
              <label className="tile-caption" title={name}>
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelect(img.path)}
                  aria-label={`${name} を選択`}
                />
                <span className="tile-name">{stripExt(name)}</span>
              </label>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {loadError && <span style={{ color: 'var(--status-err)' }}>{loadError}</span>}

      {loading && !loadError ? (
        <div className="empty">読み込み中…</div>
      ) : images.length === 0 && !loadError ? (
        <div className="empty">素材がまだありません</div>
      ) : (
        <>
          <input
            type="search"
            className="gallery-search"
            placeholder="ファイル名で検索"
            aria-label="ファイル名で検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {filtered.length === 0 ? (
            <div className="empty">検索に一致する素材がありません</div>
          ) : registered.length > 0 && unregistered.length > 0 ? (
            <>
              <h3 className="gallery-section-title">素材ライブラリ登録済み({registered.length})</h3>
              {renderTiles(registered)}
              <h3 className="gallery-section-title">
                未登録 — サムネイル・中間生成物など({unregistered.length})
              </h3>
              {renderTiles(unregistered)}
            </>
          ) : (
            // 片方しか無いときは見出しを出さず1グリッドで表示(library.json が無いチャンネルを含む)
            renderTiles(filtered)
          )}
        </>
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
            <span aria-live="polite">
              {sent && <span style={{ color: 'var(--status-ok)' }}>送信済み</span>}
              {sendError && <span style={{ color: 'var(--status-err)' }}>{sendError}</span>}
            </span>
          </div>
        </div>
      )}

      {preview && (
        <div className="modal-backdrop" onClick={closePreview}>
          <div
            ref={modalRef}
            className="panel modal"
            role="dialog"
            aria-modal="true"
            aria-label={basename(preview.path)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onModalKeyDown}
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
              <button ref={closeButtonRef} className="btn btn-ghost" onClick={closePreview}>
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
                    <span aria-live="polite">
                      {curateMessage && <span style={{ color: 'var(--status-ok)' }}>{curateMessage}</span>}
                      {curateError && <span style={{ color: 'var(--status-err)' }}>{curateError}</span>}
                    </span>
                  </div>
                </>
              ) : (
                <span className="mono">素材ライブラリ未登録の画像です(サムネイル・中間生成物など)</span>
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

/** タイル下のキャプション用にファイル名の拡張子を落とす(識別に不要な情報を減らす) */
function stripExt(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx <= 0 ? name : name.slice(0, idx);
}
