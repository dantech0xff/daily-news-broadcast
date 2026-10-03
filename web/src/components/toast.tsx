/**
 * Toast notifications (bottom-right, auto-dismissed). Session-expiry errors
 * are not toasted: the session dialog already covers them. Dialogs show their
 * own errors inline because a modal `<dialog>` sits above every toast.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ApiError } from '../api/client';
import { cn } from '../lib/cn';
import { describeError } from '../lib/errors';
import { IconAlert, IconCheck, IconClose } from './icons';

type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  lines: string[];
}

export interface ToastApi {
  success: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
  /** Toast an error: `ApiError`s show their message and details. */
  error: (error: unknown) => void;
}

const MAX_TOASTS = 4;
const DURATION_MS: Record<ToastTone, number> = { success: 5_000, info: 6_000, error: 10_000 };

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts(list => list.filter(toast => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const push = useCallback((tone: ToastTone, title: string, lines: string[]) => {
    const id = nextId.current;
    nextId.current += 1;
    setToasts(list => [...list.slice(-(MAX_TOASTS - 1)), { id, tone, title, lines }]);
    timers.current.set(id, setTimeout(() => dismiss(id), DURATION_MS[tone]));
  }, [dismiss]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({
    success: (title, description) => push('success', title, description ? [description] : []),
    info: (title, description) => push('info', title, description ? [description] : []),
    error: error => {
      if (error instanceof ApiError && error.isSessionExpired) return;
      const { title, lines } = describeError(error);
      push('error', title, lines);
    },
  }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-end gap-2 p-4 sm:inset-x-auto sm:right-0">
        {toasts.map(toast => (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-white p-3 text-sm shadow-lg',
              toast.tone === 'error' ? 'border-rose-200' : toast.tone === 'success' ? 'border-emerald-200' : 'border-slate-200',
            )}
          >
            {toast.tone === 'error' ? (
              <IconAlert className="mt-0.5 size-4 shrink-0 text-rose-600" />
            ) : (
              <IconCheck className={cn('mt-0.5 size-4 shrink-0', toast.tone === 'success' ? 'text-emerald-600' : 'text-sky-600')} />
            )}
            <div className="min-w-0 flex-1">
              <p className="font-medium text-slate-900">{toast.title}</p>
              {toast.lines.map(line => <p key={line} className="mt-0.5 break-words text-slate-600">{line}</p>)}
            </div>
            <button type="button" onClick={() => dismiss(toast.id)} aria-label="Đóng thông báo" className="rounded p-0.5 text-slate-400 hover:text-slate-600">
              <IconClose className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast() must be used inside <ToastProvider>');
  return value;
}
