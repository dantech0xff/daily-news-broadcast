import { useState } from 'react';

import { useUnresolved } from '../../api/queries';
import type { ChannelStatus, ControlAction, RecoveryTarget } from '../../api/types';
import { Badge } from '../../components/badge';
import { Button } from '../../components/button';
import { Card, CardBody, CardHeader } from '../../components/card';
import { OperatorButton } from '../../components/operator-button';
import { Pagination } from '../../components/pagination';
import { EmptyState, ErrorState, LoadingState, StaleDataNotice } from '../../components/states';
import { useSession } from '../../app/session';
import { CUTOVER_BLOCKS_RETRY } from '../../features/channel-actions/cutover-notice';
import { cn } from '../../lib/cn';
import { CONTROL_ACTION_LABELS, RECOVERY_TARGET_KIND_LABELS, recoveryStateLabel } from '../../lib/labels';
import { isCutoverPending, isStuckTarget } from '../../lib/operations';
import { RecoveryActionDialog, TargetIds, targetTitle } from './recovery-action-dialog';

const UNRESOLVED_PAGE_SIZE = 20;

interface PendingAction {
  target: RecoveryTarget;
  action: ControlAction;
}

/**
 * Unresolved deliveries, outputs, and dead-letter maintenance items of one
 * channel ("mục kẹt"). Each target offers exactly the actions the server
 * lists in its `allowedActions`; operators only.
 */
export function UnresolvedCard({ channelId, status }: { channelId: string; status: ChannelStatus | undefined }) {
  const { canOperate } = useSession();
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const query = useUnresolved(channelId, { limit: UNRESOLVED_PAGE_SIZE, offset });
  const data = query.data;
  // The channel state comes from the same snapshot as the targets when the store has one.
  const channelPaused = data?.channel ? data.channel.state === 'paused' : status?.paused === true;
  const cutoverPending = isCutoverPending(status);

  return (
    <Card>
      <CardHeader
        title="Mục kẹt"
        description="Các mục giao hàng chưa xong của kênh. Mỗi mục chỉ có các thao tác máy chủ cho phép; mọi thao tác cần lý do và được ghi vào audit log."
      />
      {!canOperate ? (
        <p className="border-b border-slate-100 px-5 py-3 text-sm text-slate-500">
          Bạn đang ở chế độ chỉ xem: chỉ operator mới xử lý được các mục này.
        </p>
      ) : null}
      {data && query.error ? (
        <CardBody><StaleDataNotice errors={[query.error]} onRetry={() => void query.refetch()} /></CardBody>
      ) : null}
      {data === undefined ? (
        query.isError
          ? <CardBody><ErrorState error={query.error} onRetry={() => void query.refetch()} /></CardBody>
          : <LoadingState />
      ) : data.targets.length === 0 ? (
        offset > 0
          ? <EmptyState title="Trang này không còn mục nào" action={<Button size="sm" onClick={() => setOffset(0)}>Về trang đầu</Button>} />
          : <EmptyState title="Không có mục nào cần xử lý" description="Mọi mục giao hàng của kênh đã hoàn tất hoặc đã được bỏ." />
      ) : (
        <ul aria-label="Danh sách mục kẹt" className={cn('divide-y divide-slate-100', query.isPlaceholderData && 'opacity-60')}>
          {data.targets.map(target => (
            <TargetRow
              key={`${target.kind}:${target.deliveryId ?? ''}:${target.outputKey ?? ''}:${target.outboxId ?? ''}`}
              target={target}
              canOperate={canOperate}
              cutoverPending={cutoverPending}
              onAction={action => setPending({ target, action })}
            />
          ))}
        </ul>
      )}
      {data ? <Pagination page={data.page} label="Phân trang mục kẹt" onOffsetChange={setOffset} pending={query.isPlaceholderData} /> : null}
      {pending ? (
        <RecoveryActionDialog
          channelId={channelId}
          target={pending.target}
          action={pending.action}
          channelPaused={channelPaused}
          onClose={() => setPending(null)}
        />
      ) : null}
    </Card>
  );
}

function TargetRow({ target, canOperate, cutoverPending, onAction }: {
  target: RecoveryTarget;
  canOperate: boolean;
  cutoverPending: boolean;
  onAction: (action: ControlAction) => void;
}) {
  const stuck = isStuckTarget(target);
  return (
    <li className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="font-medium break-words text-slate-900">{targetTitle(target)}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="slate">{RECOVERY_TARGET_KIND_LABELS[target.kind]}</Badge>
          <Badge tone={stuck ? 'red' : 'blue'}>{stuck ? 'Cần operator' : 'Đang tự xử lý'}</Badge>
          <span className="text-sm text-slate-700">{recoveryStateLabel(target)}</span>
          <code className="font-mono text-xs text-slate-500">{target.state}</code>
          <span className="text-xs text-slate-500">· phiên bản {target.expectedVersion}</span>
        </div>
        <TargetIds target={target} />
      </div>
      {canOperate ? (
        <div className="flex flex-wrap gap-2 lg:max-w-sm lg:justify-end">
          {target.allowedActions.map(action => (
            <OperatorButton
              key={action}
              size="sm"
              variant={action === 'abandon' ? 'danger' : 'secondary'}
              disabledReason={action === 'retry-output' && cutoverPending ? CUTOVER_BLOCKS_RETRY : null}
              onClick={() => onAction(action)}
            >
              {CONTROL_ACTION_LABELS[action] ?? action}
            </OperatorButton>
          ))}
        </div>
      ) : null}
    </li>
  );
}
