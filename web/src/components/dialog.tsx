/**
 * Modal dialog on the native `<dialog>` element: the browser provides the top
 * layer, focus containment, and Escape handling, and nothing injects styles
 * at run time (the server CSP forbids inline `<style>`). Content renders only
 * while open, so per-dialog state (reason text, idempotency key) starts fresh
 * every time. Most dialogs are mounted only while open, so focus is handed
 * back to the element that opened them when they unmount.
 */

import { useEffect, useId, useRef, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { IconClose } from './icons';

const SIZES = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
} as const;

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  /** False while a submission is in flight: Escape, backdrop clicks, and the close button are ignored. */
  dismissible?: boolean;
  role?: 'dialog' | 'alertdialog';
}

export function Dialog({ open, onClose, title, description, children, footer, size = 'md', dismissible = true, role = 'dialog' }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const opener = useRef<Element | null>(null);
  const pressedOnBackdrop = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      showModal(dialog);
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open]);

  useEffect(() => () => {
    const target = opener.current;
    if (target instanceof HTMLElement && target.isConnected) target.focus();
  }, []);

  return (
    <dialog
      ref={ref}
      role={role}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={event => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClose={() => {
        if (!open) return;
        // Browsers may force-close a modal on a repeated Escape even when `cancel`
        // was prevented; a dialog that must stay open (submission in flight) reopens.
        if (!dismissible) {
          if (ref.current) showModal(ref.current);
          return;
        }
        onClose();
      }}
      onPointerDown={event => {
        pressedOnBackdrop.current = event.target === ref.current;
      }}
      onClick={event => {
        // Only a press and release on the backdrop closes: a text selection that
        // starts inside and ends outside the panel must not.
        const onBackdrop = pressedOnBackdrop.current && event.target === ref.current;
        pressedOnBackdrop.current = false;
        if (dismissible && onBackdrop) onClose();
      }}
      className={cn('m-auto w-[calc(100%-2rem)] rounded-xl bg-white p-0 text-slate-900 shadow-2xl', SIZES[size])}
    >
      {open ? (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold text-slate-900">{title}</h2>
              {description ? <p id={descriptionId} className="mt-1 text-sm text-slate-500">{description}</p> : null}
            </div>
            {dismissible ? (
              <button type="button" onClick={onClose} aria-label="Đóng" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
                <IconClose className="size-5" />
              </button>
            ) : null}
          </div>
          <div className="min-h-0 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 rounded-b-xl border-t border-slate-100 bg-slate-50 px-5 py-3">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

function showModal(dialog: HTMLDialogElement) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}
