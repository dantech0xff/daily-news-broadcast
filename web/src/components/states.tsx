import type { ReactNode } from 'react';

import { ApiError } from '../api/client';
import { cn } from '../lib/cn';
import { describeError } from '../lib/errors';
import { IconAlert, IconRefresh } from './icons';

export function Spinner({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn('animate-spin text-current', className)}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function LoadingState({ label = 'Đang tải…', className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cn('flex items-center justify-center gap-2 py-10 text-sm text-slate-500', className)}>
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const { title, lines } = describeError(error);
  return (
    <div role="alert" className={cn('flex flex-col items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800', className)}>
      <div className="flex items-center gap-2 font-medium">
        <IconAlert className="size-4 shrink-0" />
        <span>{title}</span>
      </div>
      {lines.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5">
          {lines.map(line => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
      {onRetry ? (
        <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 font-medium text-rose-900 underline-offset-2 hover:underline">
          <IconRefresh className="size-3.5" />
          Thử lại
        </button>
      ) : null}
    </div>
  );
}

/**
 * Shown above data that is still displayed after a background refresh failed
 * (TanStack keeps the last data). An expired session is covered by the
 * session dialog, so it is not repeated here.
 */
export function StaleDataNotice({ errors, onRetry, className }: { errors: readonly unknown[]; onRetry: () => void; className?: string }) {
  const error = errors.find(entry => entry !== null && entry !== undefined && !(entry instanceof ApiError && entry.isSessionExpired));
  if (!error) return null;
  return (
    <div role="status" className={cn('flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900', className)}>
      <IconAlert className="size-4 shrink-0" />
      <span>Không tải lại được dữ liệu mới nhất ({describeError(error).title}); đang hiển thị dữ liệu đã tải trước đó.</span>
      <button type="button" onClick={onRetry} className="font-medium underline-offset-2 hover:underline">Thử lại</button>
    </div>
  );
}

export function EmptyState({ title, description, action, className }: { title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-4 py-10 text-center', className)}>
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description ? <p className="max-w-md text-sm text-slate-500">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Notice({ tone = 'info', title, children, className }: { tone?: 'info' | 'warning' | 'danger'; title?: ReactNode; children?: ReactNode; className?: string }) {
  const tones = {
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    warning: 'border-amber-300 bg-amber-50 text-amber-900',
    danger: 'border-rose-300 bg-rose-50 text-rose-900',
  } as const;
  return (
    <div className={cn('rounded-lg border p-3 text-sm', tones[tone], className)}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={cn(title ? 'mt-1' : undefined, 'space-y-1')}>{children}</div> : null}
    </div>
  );
}
