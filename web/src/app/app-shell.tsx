import { useState, type ComponentType } from 'react';
import { NavLink, Outlet } from 'react-router';

import { useHealth } from '../api/queries';
import { Badge } from '../components/badge';
import {
  IconChannels,
  IconClose,
  IconKey,
  IconLibrary,
  IconMenu,
  IconOverview,
  IconQueue,
  IconRadar,
  IconStats,
} from '../components/icons';
import { cn } from '../lib/cn';
import { formatDateTime } from '../lib/format';
import { ROLE_LABELS, labelOf } from '../lib/labels';
import { identityLabel, useSession } from './session';
import { useLiveEvents, type LiveState } from './use-live-events';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Tổng quan', icon: IconOverview, end: true },
  { to: '/channels', label: 'Kênh', icon: IconChannels },
  { to: '/operations', label: 'Queue & vận hành', icon: IconQueue },
  { to: '/library', label: 'Thư viện nội dung', icon: IconLibrary },
  { to: '/stats', label: 'Thống kê', icon: IconStats },
  { to: '/secrets', label: 'AI & secret', icon: IconKey },
];

const LIVE_LABELS: Record<LiveState, { label: string; dot: string }> = {
  open: { label: 'Realtime: đã kết nối', dot: 'bg-emerald-500' },
  connecting: { label: 'Realtime: đang kết nối…', dot: 'bg-amber-400' },
  closed: { label: 'Realtime: mất kết nối, đang thử lại', dot: 'bg-rose-500' },
  stopped: { label: 'Realtime: đã dừng — tải lại trang để kết nối lại', dot: 'bg-slate-400' },
  unsupported: { label: 'Realtime: trình duyệt không hỗ trợ', dot: 'bg-slate-400' },
};

export function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const live = useLiveEvents();

  return (
    <div className="min-h-full">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-200 bg-white lg:flex">
        <Sidebar live={live} />
      </aside>

      {menuOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label="Đóng menu" className="absolute inset-0 bg-slate-900/40" onClick={() => setMenuOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col bg-white shadow-xl" aria-label="Menu">
            <button type="button" aria-label="Đóng menu" onClick={() => setMenuOpen(false)} className="absolute top-3 right-3 rounded-md p-1 text-slate-500 hover:bg-slate-100">
              <IconClose className="size-5" />
            </button>
            <Sidebar live={live} onNavigate={() => setMenuOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white/95 px-4 py-2 lg:px-8">
          <button type="button" aria-label="Mở menu" onClick={() => setMenuOpen(true)} className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden">
            <IconMenu className="size-5" />
          </button>
          <EngineStatus />
          <IdentitySummary />
        </header>
        <main className="mx-auto w-full max-w-7xl px-4 py-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Sidebar({ live, onNavigate }: { live: LiveState; onNavigate?: () => void }) {
  const health = useHealth();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2 border-b border-slate-100 px-5">
        <IconRadar className="size-6 text-indigo-600" />
        <span className="text-base font-semibold text-slate-900">Content Radar</span>
      </div>
      <nav aria-label="Điều hướng chính" className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {NAV_ITEMS.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) => cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
            )}
          >
            <item.icon className="size-5 shrink-0" />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="space-y-1 border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
        <p className="flex items-center gap-2">
          <span className={cn('size-2 rounded-full', LIVE_LABELS[live].dot)} aria-hidden="true" />
          {LIVE_LABELS[live].label}
        </p>
        {health.data ? <p>Phiên bản {health.data.version}</p> : null}
      </div>
    </div>
  );
}

function EngineStatus() {
  const health = useHealth();
  if (health.data === undefined) {
    if (!health.isError) return <span className="text-sm text-slate-500">Đang kiểm tra engine…</span>;
    return (
      <span className="flex items-center gap-2 text-sm text-rose-700">
        <span className="size-2 rounded-full bg-rose-500" aria-hidden="true" />
        Không đọc được trạng thái engine
      </span>
    );
  }
  // The last known state stays visible, marked stale, when a refresh fails.
  if (health.isError) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-sm text-rose-700" title={`Trạng thái cuối cùng đọc được lúc ${formatDateTime(health.data.time)}`}>
        <span className="size-2 rounded-full bg-rose-500" aria-hidden="true" />
        <span className="font-medium">Không cập nhật được trạng thái engine</span>
        <span className="text-slate-500">· lần đọc cuối {formatDateTime(health.data.time)}</span>
      </span>
    );
  }
  const { runtime } = health.data;
  if (runtime.active) {
    const activity = runtime.running ? 'đang chạy 1 lượt' : 'đang rảnh';
    return (
      <span className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
        <span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
        <span className="font-medium">Engine đang hoạt động</span>
        <span className="text-slate-500">· {activity} · {runtime.queued} lượt chờ · {runtime.scheduledChannels} kênh có lịch</span>
      </span>
    );
  }
  const holder = runtime.leaseHolder;
  const detail = holder && !holder.self
    ? `instance khác (${holder.id}) đang giữ runtime lease đến ${formatDateTime(holder.expiresAt)}`
    : 'instance này chưa giữ runtime lease';
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm text-amber-800" title="Không có lịch nào chạy cho tới khi instance giữ được lease.">
      <span className="size-2 rounded-full bg-amber-500" aria-hidden="true" />
      <span className="font-medium">Engine chưa hoạt động</span>
      <span>· {detail}</span>
    </span>
  );
}

function IdentitySummary() {
  const { identity, role } = useSession();
  return (
    <div className="ml-auto flex min-w-0 items-center gap-2 text-sm">
      <span className="truncate text-slate-700" title={identityLabel(identity)}>{identityLabel(identity)}</span>
      <Badge tone={role === 'operator' ? 'indigo' : 'slate'}>{labelOf(ROLE_LABELS, role)}</Badge>
    </div>
  );
}
