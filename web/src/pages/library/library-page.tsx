/**
 * Thư viện nội dung (`/library`): scanned and posted articles of every
 * channel, filtered by channel, status, source, date range, and keyword.
 * The applied filters live in the URL (see `library-query.ts`); the form
 * edits a draft that is applied on submit. Read-only for every role.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';

import { useChannels, useContentList, useMeta } from '../../api/queries';
import type { ChannelRecord, ContentItem, ContentStatus } from '../../api/types';
import { Button } from '../../components/button';
import { Card, CardBody, CardHeader } from '../../components/card';
import { ExternalLink } from '../../components/external-link';
import { describedBy, Field, Select, TextInput } from '../../components/form-controls';
import { Pagination } from '../../components/pagination';
import { PageHeader } from '../../components/page-header';
import { EmptyState, ErrorState, LoadingState, StaleDataNotice } from '../../components/states';
import { cn } from '../../lib/cn';
import { formatDateTime, formatNumber } from '../../lib/format';
import { CONTENT_DATE_FIELD_LABELS, CONTENT_STATUS_LABELS } from '../../lib/labels';
import { ContentDetailDialog, ContentStatusBadge } from './content-detail-dialog';
import {
  CONTENT_STATUS_OPTIONS,
  DATE_FIELD_OPTIONS,
  DEFAULT_FILTERS,
  PAGE_SIZE_OPTIONS,
  TEXT_FILTER_MAX_LENGTH,
  hasFilters,
  libraryParams,
  parseLibraryParams,
  toContentQuery,
  validateFilters,
  type FilterErrors,
  type LibraryFilters,
  type LibraryView,
} from './library-query';

export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const view = useMemo(() => parseLibraryParams(params), [params]);
  const query = useMemo(() => toContentQuery(view), [view]);
  const content = useContentList(query);
  const channels = useChannels();
  const meta = useMeta();
  const [detailId, setDetailId] = useState<string | null>(null);
  const channelList = channels.data ?? [];
  const statuses = meta.data?.content.statuses ?? CONTENT_STATUS_OPTIONS;
  const channelName = (channelId: string) => channelList.find(channel => channel.id === channelId)?.name ?? channelId;

  const apply = (next: LibraryView) => setParams(libraryParams(next));
  const data = content.data;

  return (
    <>
      <PageHeader
        title="Thư viện nội dung"
        description="Các bài đã quét và đã đăng của mọi kênh. Bài đã đăng được giữ vĩnh viễn; bài quét nhưng không đăng được giữ 30 ngày."
      />

      <Card>
        <CardBody>
          {/* Keyed by the URL: back/forward navigation or a new link reloads the draft. */}
          <LibraryFilterForm
            key={params.toString()}
            view={view}
            channels={channelList}
            statuses={statuses}
            onApply={filters => apply({ ...filters, page: 1, limit: view.limit })}
            onReset={() => setParams(new URLSearchParams())}
          />
        </CardBody>
      </Card>

      <Card className="mt-6">
        <CardHeader
          title="Kết quả"
          description={data ? `${formatNumber(data.page.total)} bài khớp bộ lọc.` : undefined}
          actions={(
            <div className="flex items-center gap-2">
              <label htmlFor="library-page-size" className="text-sm whitespace-nowrap text-slate-700">Số bài mỗi trang</label>
              <div className="w-24">
                <Select
                  id="library-page-size"
                  value={String(view.limit)}
                  onChange={event => apply({ ...view, limit: Number(event.target.value), page: 1 })}
                >
                  {PAGE_SIZE_OPTIONS.map(size => <option key={size} value={size}>{size}</option>)}
                </Select>
              </div>
            </div>
          )}
        />
        {data && content.error ? (
          <CardBody><StaleDataNotice errors={[content.error]} onRetry={() => void content.refetch()} /></CardBody>
        ) : null}
        {data === undefined ? (
          content.isError
            ? <CardBody><ErrorState error={content.error} onRetry={() => void content.refetch()} /></CardBody>
            : <LoadingState />
        ) : data.items.length === 0 ? (
          view.page > 1
            ? <EmptyState title="Trang này không còn bài nào" action={<Button size="sm" onClick={() => apply({ ...view, page: 1 })}>Về trang đầu</Button>} />
            : <EmptyState title="Không có bài nào khớp bộ lọc" description={hasFilters(view) ? 'Thử nới rộng bộ lọc hoặc bấm “Xoá bộ lọc”.' : 'Bài xuất hiện ở đây sau lượt quét đầu tiên.'} />
        ) : (
          <ContentTable
            items={data.items}
            channelName={channelName}
            dimmed={content.isPlaceholderData}
            onOpen={setDetailId}
            onFilterSource={source => apply({ ...view, source, page: 1 })}
          />
        )}
        {data ? (
          <Pagination
            page={data.page}
            label="Phân trang thư viện"
            pending={content.isPlaceholderData}
            onOffsetChange={offset => apply({ ...view, page: Math.floor(offset / view.limit) + 1 })}
          />
        ) : null}
      </Card>

      {detailId ? <ContentDetailDialog contentId={detailId} channelName={channelName} onClose={() => setDetailId(null)} /> : null}
    </>
  );
}

function LibraryFilterForm({ view, channels, statuses, onApply, onReset }: {
  view: LibraryView;
  channels: readonly ChannelRecord[];
  statuses: readonly ContentStatus[];
  onApply: (filters: LibraryFilters) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState<LibraryFilters>(() => ({
    channelId: view.channelId,
    statuses: view.statuses,
    source: view.source,
    dateField: view.dateField,
    from: view.from,
    to: view.to,
    keyword: view.keyword,
  }));
  const [errors, setErrors] = useState<FilterErrors>({});
  const knownChannel = draft.channelId === '' || channels.some(channel => channel.id === draft.channelId);
  const patch = (changes: Partial<LibraryFilters>) => setDraft(current => ({ ...current, ...changes }));
  const toggleStatus = (status: ContentStatus, checked: boolean) => {
    setDraft(current => ({
      ...current,
      statuses: checked ? statuses.filter(entry => entry === status || current.statuses.includes(entry)) : current.statuses.filter(entry => entry !== status),
    }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = validateFilters(draft);
    setErrors(found);
    if (Object.keys(found).length === 0) onApply({ ...draft, source: draft.source.trim(), keyword: draft.keyword.trim() });
  };

  return (
    <form aria-label="Bộ lọc thư viện" noValidate onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field id="library-channel" label="Kênh">
          <Select id="library-channel" value={draft.channelId} onChange={event => patch({ channelId: event.target.value })}>
            <option value="">Tất cả kênh</option>
            {channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name} ({channel.id})</option>)}
            {!knownChannel ? <option value={draft.channelId}>{draft.channelId}</option> : null}
          </Select>
        </Field>
        <Field id="library-source" label="Nguồn" error={errors.source} hint="Tên hoặc ID nguồn, khớp chính xác (bấm tên nguồn trong bảng để lọc).">
          <TextInput
            id="library-source"
            value={draft.source}
            maxLength={TEXT_FILTER_MAX_LENGTH}
            autoComplete="off"
            invalid={Boolean(errors.source)}
            aria-describedby={describedBy('library-source', { error: errors.source, hint: true })}
            onChange={event => patch({ source: event.target.value })}
          />
        </Field>
        <Field id="library-keyword" label="Từ khoá" error={errors.keyword} hint="Tìm trong tiêu đề, link và tóm tắt AI.">
          <TextInput
            id="library-keyword"
            type="search"
            value={draft.keyword}
            maxLength={TEXT_FILTER_MAX_LENGTH}
            autoComplete="off"
            invalid={Boolean(errors.keyword)}
            aria-describedby={describedBy('library-keyword', { error: errors.keyword, hint: true })}
            onChange={event => patch({ keyword: event.target.value })}
          />
        </Field>
        <Field id="library-date-field" label="Mốc thời gian" hint="Dùng để lọc theo ngày và sắp xếp (mới nhất trước).">
          <Select
            id="library-date-field"
            value={draft.dateField}
            aria-describedby={describedBy('library-date-field', { hint: true })}
            onChange={event => {
              const next = DATE_FIELD_OPTIONS.find(field => field === event.target.value);
              if (next) patch({ dateField: next });
            }}
          >
            {DATE_FIELD_OPTIONS.map(field => <option key={field} value={field}>{CONTENT_DATE_FIELD_LABELS[field]}</option>)}
          </Select>
        </Field>
        <Field id="library-from" label="Từ ngày" hint="Theo giờ Việt Nam (UTC+7).">
          <TextInput
            id="library-from"
            type="date"
            value={draft.from}
            aria-describedby={describedBy('library-from', { hint: true })}
            onChange={event => patch({ from: event.target.value })}
          />
        </Field>
        <Field id="library-to" label="Đến ngày" error={errors.to} hint="Gồm cả ngày này.">
          <TextInput
            id="library-to"
            type="date"
            value={draft.to}
            min={draft.from || undefined}
            invalid={Boolean(errors.to)}
            aria-describedby={describedBy('library-to', { error: errors.to, hint: true })}
            onChange={event => patch({ to: event.target.value })}
          />
        </Field>
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-slate-700">Trạng thái</legend>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          {statuses.map(status => (
            <label key={status} className="inline-flex items-center gap-1.5 text-sm text-slate-700">
              <input
                type="checkbox"
                className="size-4 accent-indigo-600"
                checked={draft.statuses.includes(status)}
                onChange={event => toggleStatus(status, event.target.checked)}
              />
              {CONTENT_STATUS_LABELS[status] ?? status}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-slate-500">Không chọn trạng thái nào = mọi trạng thái.</p>
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary">Lọc</Button>
        <Button disabled={!hasFilters(view) && !hasFilters(draft)} onClick={() => {
          setDraft({ ...DEFAULT_FILTERS });
          setErrors({});
          onReset();
        }}>
          Xoá bộ lọc
        </Button>
      </div>
    </form>
  );
}

function ContentTable({ items, channelName, dimmed, onOpen, onFilterSource }: {
  items: ContentItem[];
  channelName: (channelId: string) => string;
  dimmed: boolean;
  onOpen: (contentId: string) => void;
  onFilterSource: (source: string) => void;
}) {
  return (
    <div className={cn('overflow-x-auto', dimmed && 'opacity-60')} aria-busy={dimmed || undefined}>
      <table aria-label="Danh sách bài" className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
          <tr>
            <th scope="col" className="px-5 py-3">Bài</th>
            <th scope="col" className="px-5 py-3">Nguồn</th>
            <th scope="col" className="px-5 py-3">Trạng thái</th>
            <th scope="col" className="px-5 py-3">Thời gian</th>
            <th scope="col" className="px-5 py-3">Message ID</th>
            <th scope="col" className="px-5 py-3"><span className="sr-only">Thao tác</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {items.map(item => {
            const source = item.sourceName ?? item.sourceId;
            return (
              <tr key={item.id} className="align-top">
                <td className="max-w-md min-w-64 px-5 py-3">
                  <ExternalLink href={item.url} className="font-medium">{item.title ?? 'Không có tiêu đề'}</ExternalLink>
                  <span className="block text-xs text-slate-500">
                    {channelName(item.channelId)}{item.category ? ` · ${item.category}` : ''}
                  </span>
                </td>
                <td className="px-5 py-3">
                  {source ? (
                    <button type="button" title="Lọc theo nguồn này" onClick={() => onFilterSource(source)} className="text-left text-slate-700 hover:text-indigo-700 hover:underline">
                      {source}
                    </button>
                  ) : '—'}
                </td>
                <td className="px-5 py-3"><ContentStatusBadge item={item} /></td>
                <td className="px-5 py-3 text-xs whitespace-nowrap text-slate-600">
                  <dl className="grid grid-cols-[auto_auto] gap-x-2">
                    <dt className="text-slate-400">Đăng gốc</dt>
                    <dd>{formatDateTime(item.publishedAt)}</dd>
                    <dt className="text-slate-400">Quét</dt>
                    <dd>{formatDateTime(item.lastSeenAt)}</dd>
                    {item.deliveredAt ? (
                      <>
                        <dt className="text-slate-400">Đã đăng</dt>
                        <dd className="font-medium text-slate-800">{formatDateTime(item.deliveredAt)}</dd>
                      </>
                    ) : null}
                  </dl>
                </td>
                <td className="px-5 py-3 font-mono text-xs">{item.messageId ?? '—'}</td>
                <td className="px-5 py-3 text-right">
                  <Button size="sm" onClick={() => onOpen(item.id)}>Chi tiết</Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
