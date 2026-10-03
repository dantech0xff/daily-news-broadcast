import { useMutation } from '@tanstack/react-query';

import { useApi } from '../../api/api-context';
import { Card, CardBody, CardHeader } from '../../components/card';
import { IconEye } from '../../components/icons';
import { OperatorButton } from '../../components/operator-button';
import { ErrorState, LoadingState, Notice } from '../../components/states';
import { PreviewResultView } from '../../features/channel-actions/preview-dialog';

/**
 * Inline read-only preview (`POST /api/channels/:id/preview`): the server
 * fetches and calls the AI like a run but never sends or writes state.
 * Operators only, because it spends AI quota.
 */
export function PreviewPanel({ channelId }: { channelId: string }) {
  const api = useApi();
  const mutation = useMutation({ mutationFn: () => api.preview(channelId) });
  const ran = mutation.data !== undefined || mutation.isError;

  return (
    <Card>
      <CardHeader
        title="Preview"
        description="Xem trước nội dung kênh sẽ tạo ở lượt chạy kế tiếp."
        actions={(
          <OperatorButton icon={<IconEye className="size-4" />} loading={mutation.isPending} onClick={() => mutation.mutate()}>
            {ran ? 'Chạy lại preview' : 'Chạy preview'}
          </OperatorButton>
        )}
      />
      <CardBody className="space-y-4">
        <Notice tone="info" title="Preview không gửi bài">
          Preview lấy bài từ nguồn và gọi AI như một lượt chạy thật, nhưng không gửi gì lên Telegram và không ghi trạng thái giao hàng,
          lịch sử run hay thư viện nội dung.
        </Notice>
        {mutation.isPending ? (
          <LoadingState label="Đang lấy bài từ nguồn và gọi AI… việc này có thể mất khoảng một phút." />
        ) : mutation.isError ? (
          <ErrorState error={mutation.error} onRetry={() => mutation.mutate()} />
        ) : mutation.data ? (
          <PreviewResultView result={mutation.data} />
        ) : null}
      </CardBody>
    </Card>
  );
}
