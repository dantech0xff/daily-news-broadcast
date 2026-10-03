import { ButtonLink } from '../components/button';
import { EmptyState } from '../components/states';

export function NotFoundPage() {
  return (
    <EmptyState
      title="Không tìm thấy trang"
      description="Đường dẫn này không tồn tại trong dashboard."
      action={<ButtonLink to="/" variant="primary">Về Tổng quan</ButtonLink>}
    />
  );
}
