import { Card, CardBody } from '../components/card';
import { PageHeader } from '../components/page-header';

/** Routable stand-in for a section that is not built yet. */
export function PlaceholderPage({ title, description, features }: { title: string; description: string; features: string[] }) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <Card>
        <CardBody>
          <p className="text-sm font-medium text-slate-700">Trang này đang được hoàn thiện. Sẽ có:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
            {features.map(feature => <li key={feature}>{feature}</li>)}
          </ul>
        </CardBody>
      </Card>
    </>
  );
}

export function OperationsPage() {
  return (
    <PlaceholderPage
      title="Queue & vận hành"
      description="Theo dõi queue, lịch sử chạy và xử lý các mục kẹt của từng kênh."
      features={[
        'Trạng thái kênh và queue theo ngày',
        'Lịch sử run kèm thống kê, lựa chọn bài, sức khoẻ từng nguồn và kết quả output',
        'Mục kẹt với các thao tác được phép (xác nhận, lý do bắt buộc)',
        'Preview nội dung (không gửi)',
      ]}
    />
  );
}

export function LibraryPage() {
  return (
    <PlaceholderPage
      title="Thư viện nội dung"
      description="Duyệt các bài đã quét và đã đăng."
      features={[
        'Lọc theo kênh, trạng thái, nguồn, thời gian và từ khoá; phân trang',
        'Chi tiết bài: tóm tắt AI, link gốc, message ID, mốc thời gian, lý do bị loại',
      ]}
    />
  );
}

export function StatsPage() {
  return (
    <PlaceholderPage
      title="Thống kê"
      description="Biểu đồ hoạt động theo khoảng thời gian."
      features={[
        'Số bài đăng theo ngày và kênh',
        'Sức khoẻ nguồn theo thời gian',
        'Tỉ lệ lỗi AI và output',
        'Token usage',
      ]}
    />
  );
}
