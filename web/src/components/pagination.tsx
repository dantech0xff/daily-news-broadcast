import type { Page } from '../api/types';
import { formatNumber } from '../lib/format';
import { Button } from './button';

/**
 * Previous/next paging of an offset-paginated list. `label` names the
 * navigation landmark (several lists can share a page), e.g. "Phân trang
 * lịch sử run". Renders nothing while the list is empty.
 */
export function Pagination({ page, label, onOffsetChange, pending = false }: {
  page: Page;
  label: string;
  onOffsetChange: (offset: number) => void;
  /** Disable the buttons while the next page loads. */
  pending?: boolean;
}) {
  const { limit, offset, total } = page;
  if (total === 0 && offset === 0) return null;
  const first = Math.min(offset + 1, total);
  const last = Math.min(offset + limit, total);
  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-3 text-sm">
      <p className="text-slate-600">
        {total === 0 ? 'Không còn mục nào' : `Hiển thị ${formatNumber(first)}–${formatNumber(last)} / ${formatNumber(total)}`}
      </p>
      <div className="flex gap-2">
        <Button size="sm" disabled={offset === 0 || pending} onClick={() => onOffsetChange(Math.max(0, offset - limit))}>
          Trang trước
        </Button>
        <Button size="sm" disabled={offset + limit >= total || pending} onClick={() => onOffsetChange(offset + limit)}>
          Trang sau
        </Button>
      </div>
    </nav>
  );
}
