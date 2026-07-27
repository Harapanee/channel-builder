import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * ネイティブ confirm() の置き換え。アプリのデザイン言語に合わせたモーダルで
 * Promise<boolean> を返す。使い方:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: '中止しますか?', body: '実行中のレンダーを停止します。', danger: true }))) return;
 *
 * App を <ConfirmProvider> で包むこと。フォーカスはダイアログ内に移し、
 * 閉じたら呼び出し元のフォーカスへ戻す(Escape=キャンセル)。
 */

export type ConfirmOptions = {
  title: string;
  body?: string;
  /** 実行ボタンのラベル(既定「実行する」) */
  confirmLabel?: string;
  /** キャンセルボタンのラベル(既定「キャンセル」) */
  cancelLabel?: string;
  /** 破壊的操作(実行ボタンを赤にする) */
  danger?: boolean;
};

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error('useConfirm は <ConfirmProvider> の内側で使うこと');
  return fn;
}

type PendingConfirm = ConfirmOptions & { resolve: (ok: boolean) => void };

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPending({ ...opts, resolve });
    });
  }, []);

  const close = useCallback(
    (ok: boolean) => {
      if (!pending) return;
      pending.resolve(ok);
      setPending(null);
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    },
    [pending],
  );

  // 開いたら実行ボタンへフォーカス(誤爆防止で danger 時はキャンセル側でも良いが、
  // confirm() 互換の操作感を優先し常に実行ボタン。Tabはダイアログ内で循環させる)
  useEffect(() => {
    if (pending) confirmButtonRef.current?.focus();
  }, [pending]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(false);
      return;
    }
    if (e.key === 'Tab') {
      // 簡易フォーカストラップ: ダイアログ内のボタン2つの間で循環させる
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>('button');
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
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div
          className="modal-backdrop"
          onClick={() => close(false)}
          onKeyDown={onKeyDown}
          role="presentation"
        >
          <div
            ref={dialogRef}
            className="modal confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="confirm-dialog-title">{pending.title}</h3>
            {pending.body && <p>{pending.body}</p>}
            <div className="confirm-actions">
              <button className="btn btn-ghost" onClick={() => close(false)}>
                {pending.cancelLabel ?? 'キャンセル'}
              </button>
              <button
                ref={confirmButtonRef}
                className={`btn ${pending.danger ? 'btn-danger-solid' : 'btn-primary'}`}
                onClick={() => close(true)}
              >
                {pending.confirmLabel ?? '実行する'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
