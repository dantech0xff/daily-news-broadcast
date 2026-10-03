/**
 * One library item (`GET /api/content/:id`) with the full AI summary.
 * Titles, summaries, and URLs come from external sources and the AI: they
 * are rendered as plain text only (never as HTML), and only http(s) URLs
 * become links (new tab, no opener, no referrer).
 */

import type { ReactNode } from 'react';

import { useContentItem } from '../../api/queries';
import type { ContentItem } from '../../api/types';
import { Badge } from '../../components/badge';
import { Button } from '../../components/button';
import { Dialog } from '../../components/dialog';
import { ExternalLink } from '../../components/external-link';
import { ErrorState, LoadingState } from '../../components/states';
import { formatDateTime } from '../../lib/format';
import { CONTENT_STATUS_LABELS, REJECT_REASON_LABELS, labelOf } from '../../lib/labels';
import { contentStatusTone } from '../../lib/status-tones';

/** Status badge; rejected items name their reason. */
export function ContentStatusBadge({ item }: { item: Pick<ContentItem, 'status' | 'rejectReason'> }) {
  const status = labelOf(CONTENT_STATUS_LABELS, item.status);
  const reason = item.status === 'rejected' && item.rejectReason ? labelOf(REJECT_REASON_LABELS, item.rejectReason) : null;
  return <Badge tone={contentStatusTone(item.status)}>{reason ? `${status}: ${reason}` : status}</Badge>;
}

export function ContentDetailDialog({ contentId, channelName, onClose }: {
  contentId: string;
  channelName: (channelId: string) => string;
  onClose: () => void;
}) {
  const query = useContentItem(contentId);
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Chi tiết bài"
      footer={<Button variant="primary" onClick={onClose}>Đóng</Button>}
    >
      {query.data ? (
        <ContentDetail item={query.data} channelName={channelName(query.data.channelId)} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <LoadingState />
      )}
    </Dialog>
  );
}

function ContentDetail({ item, channelName }: { item: ContentItem; channelName: string }) {
  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-2">
        <p className="text-base font-semibold break-words text-slate-900">{item.title ?? 'Không có tiêu đề'}</p>
        <ContentStatusBadge item={item} />
        {item.url ? (
          <p className="break-all">
            <ExternalLink href={item.url}>{item.url}</ExternalLink>
          </p>
        ) : null}
      </div>

      <dl className="grid gap-3 sm:grid-cols-2">
        <Detail label="Kênh">{channelName} <span className="font-mono text-xs text-slate-500">({item.channelId})</span></Detail>
        <Detail label="Nguồn">
          {item.sourceName ?? item.sourceId ?? '—'}
          {item.sourceId && item.sourceName ? <span className="block font-mono text-xs text-slate-500">{item.sourceId}</span> : null}
        </Detail>
        <Detail label="Chuyên mục">{item.category ?? '—'}</Detail>
        {item.status === 'rejected' ? <Detail label="Lý do bị loại">{labelOf(REJECT_REASON_LABELS, item.rejectReason)}</Detail> : null}
        <Detail label="Đăng gốc">{formatDateTime(item.publishedAt)}</Detail>
        <Detail label="Đã đăng lên kênh">{formatDateTime(item.deliveredAt)}</Detail>
        <Detail label="Quét lần đầu">{formatDateTime(item.firstSeenAt)}</Detail>
        <Detail label="Quét lần cuối">{formatDateTime(item.lastSeenAt)}</Detail>
        <Detail label="Message ID"><span className="font-mono">{item.messageId ?? '—'}</span></Detail>
        <Detail label="Cập nhật">{formatDateTime(item.updatedAt)}</Detail>
        <Detail label="Delivery ID" mono>{item.deliveryId ?? '—'}</Detail>
        <Detail label="Run ID" mono>{item.runId ?? '—'}</Detail>
      </dl>

      <section>
        <h3 className="mb-1 font-medium text-slate-700">Tóm tắt AI</h3>
        {item.summaryText ? (
          <pre className="max-h-96 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-sans text-sm whitespace-pre-wrap break-words text-slate-800">
            {item.summaryText}
          </pre>
        ) : (
          <p className="text-slate-500">Chưa có tóm tắt AI: bài chưa được tạo nội dung.</p>
        )}
      </section>
    </div>
  );
}

function Detail({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className={mono ? 'mt-0.5 font-mono text-xs break-all text-slate-800' : 'mt-0.5 text-slate-800'}>{children}</dd>
    </div>
  );
}
