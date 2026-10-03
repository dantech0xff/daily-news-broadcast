import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApi } from '../../api/api-context';
import { queryKeys } from '../../api/query-keys';
import type { ChannelStatus } from '../../api/types';
import { IconPlay } from '../../components/icons';
import { OperatorButton } from '../../components/operator-button';
import { useToast } from '../../components/toast';
import { isCutoverPending } from '../../lib/operations';
import { CUTOVER_BLOCKS_RUN } from './cutover-notice';

/** Why a manual run cannot start, or `null`. The server re-checks every condition. */
export function runNowBlocker(enabled: boolean, status: ChannelStatus | undefined): string | null {
  if (!enabled) return 'Kênh đang tắt';
  if (!status) return 'Đang tải trạng thái kênh';
  if (isCutoverPending(status)) return CUTOVER_BLOCKS_RUN;
  if (status.paused === true) return 'Kênh đang tạm dừng — hãy Resume trước';
  if (status.running || status.queued) return 'Kênh đang chạy hoặc đang chờ chạy';
  return null;
}

/** Queue an ordinary manual run (not a force run); the result arrives through live events. */
export function RunNowButton({ channelId, enabled, status, size = 'sm' }: {
  channelId: string;
  enabled: boolean;
  status: ChannelStatus | undefined;
  size?: 'sm' | 'md';
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: () => api.runNow(channelId),
    onSuccess: result => {
      // `position` counts this run plus every job ahead of it (1 = starts next).
      const ahead = result.position - 1;
      toast.success('Đã xếp lượt chạy', ahead > 0 ? `Có ${ahead} lượt chạy đứng trước.` : 'Lượt chạy sẽ bắt đầu ngay.');
    },
    onError: error => toast.error(error),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.ops(channelId) }),
  });

  return (
    <OperatorButton
      size={size}
      icon={<IconPlay className="size-3.5" />}
      loading={mutation.isPending}
      disabledReason={runNowBlocker(enabled, status)}
      onClick={() => mutation.mutate()}
    >
      Chạy ngay
    </OperatorButton>
  );
}
