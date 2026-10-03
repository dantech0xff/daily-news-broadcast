import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/cn';

const CONTROL =
  'block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-1 ring-inset placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500';

function controlClasses(invalid: boolean | undefined, className?: string) {
  return cn(CONTROL, invalid ? 'ring-rose-400 focus:ring-rose-500' : 'ring-slate-300 focus:ring-indigo-600', className);
}

export function errorId(id: string) {
  return `${id}-error`;
}

export function hintId(id: string) {
  return `${id}-hint`;
}

/** `aria-describedby` for a control rendered inside `<Field>`. */
export function describedBy(id: string, { error, hint }: { error?: string | null; hint?: ReactNode }): string | undefined {
  if (error) return errorId(id);
  return hint ? hintId(id) : undefined;
}

export interface FieldProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/** Label, control, and either the error or the hint below it. */
export function Field({ id, label, hint, error, required, className, children }: FieldProps) {
  return (
    <div className={cn('space-y-1', className)}>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
        {required ? <span className="ml-0.5 text-rose-600" aria-hidden="true">*</span> : null}
      </label>
      {children}
      {error ? (
        <p id={errorId(id)} className="text-xs text-rose-600">{error}</p>
      ) : hint ? (
        <p id={hintId(id)} className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

export function TextInput({ invalid, className, ...props }: ComponentProps<'input'> & { invalid?: boolean }) {
  return <input aria-invalid={invalid || undefined} className={controlClasses(invalid, className)} {...props} />;
}

export function Select({ invalid, className, children, ...props }: ComponentProps<'select'> & { invalid?: boolean }) {
  return (
    <select aria-invalid={invalid || undefined} className={controlClasses(invalid, cn('pr-8', className))} {...props}>
      {children}
    </select>
  );
}

export function Textarea({ invalid, className, ...props }: ComponentProps<'textarea'> & { invalid?: boolean }) {
  return <textarea aria-invalid={invalid || undefined} className={controlClasses(invalid, className)} {...props} />;
}

export function Checkbox({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-indigo-600 disabled:cursor-not-allowed"
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
      />
      <label htmlFor={id} className="text-sm">
        <span className="font-medium text-slate-700">{label}</span>
        {description ? <span className="block text-xs text-slate-500">{description}</span> : null}
      </label>
    </div>
  );
}
