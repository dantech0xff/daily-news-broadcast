import type { ContentStatus, RunStatus } from '../api/types';
import type { BadgeTone } from '../components/badge';

const RUN_TONES: Readonly<Record<RunStatus, BadgeTone>> = {
  running: 'blue',
  success: 'green',
  partial: 'amber',
  failed: 'red',
  ambiguous: 'red',
  skipped: 'slate',
  error: 'red',
  interrupted: 'amber',
};

const CONTENT_TONES: Readonly<Record<ContentStatus, BadgeTone>> = {
  selected: 'blue',
  rejected: 'slate',
  queued: 'blue',
  generating: 'blue',
  delivering: 'blue',
  delivered: 'green',
  generation_failed: 'red',
  failed: 'red',
  ambiguous: 'red',
  blocked: 'amber',
  abandoned: 'slate',
};

export function runStatusTone(status: string): BadgeTone {
  return RUN_TONES[status as RunStatus] ?? 'slate';
}

export function contentStatusTone(status: string): BadgeTone {
  return CONTENT_TONES[status as ContentStatus] ?? 'slate';
}
