import type { ReactNode } from 'react';

import { cn } from '../lib/cn';
import { IconExternal } from './icons';

/** Only absolute http(s) URLs become links; anything else (e.g. `javascript:`) renders as plain text. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Link to untrusted external content: new tab, no opener, no referrer. */
export function ExternalLink({ href, children, className, showIcon = true }: { href: string | null | undefined; children: ReactNode; className?: string; showIcon?: boolean }) {
  const url = safeHttpUrl(href);
  if (!url) return <span className={className}>{children}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={cn('inline-flex items-baseline gap-1 text-indigo-700 hover:underline', className)}>
      <span className="min-w-0">{children}</span>
      {showIcon ? <IconExternal className="size-3 shrink-0 self-center" /> : null}
    </a>
  );
}
