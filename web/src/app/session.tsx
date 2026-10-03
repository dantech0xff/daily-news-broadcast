/**
 * Who is signed in (`GET /api/me`) and whether the Cloudflare Access session
 * is still valid. The server decides every permission; the role here only
 * hides or disables controls a viewer could not use anyway.
 *
 * Once the API client finds the session expired, a blocking dialog offers a
 * full-page reload (Access then signs the user in again). The operator may
 * postpone it to copy unsaved input; a banner keeps the reload one click away.
 * Nothing retries automatically.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { useApi, useApiClient } from '../api/api-context';
import { ApiError } from '../api/client';
import { queryKeys } from '../api/query-keys';
import type { Identity, Role } from '../api/types';
import { Button } from '../components/button';
import { Dialog } from '../components/dialog';
import { IconAlert, IconRadar } from '../components/icons';
import { ErrorState, Spinner } from '../components/states';

export interface SessionValue {
  identity: Identity | null;
  role: Role | null;
  /** Operators may run every mutation; viewers only read. */
  canOperate: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function reloadPage(): void {
  window.location.reload();
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useApiClient();
  const api = useApi();
  const queryClient = useQueryClient();
  const [expired, setExpired] = useState(client.sessionExpired);
  const [postponed, setPostponed] = useState(false);

  useEffect(() => client.onSessionExpired(() => {
    setExpired(true);
    void queryClient.cancelQueries();
  }), [client, queryClient]);

  const me = useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => api.getMe(signal),
    staleTime: 5 * 60_000,
  });

  // A failed background refetch keeps the identity already loaded: the app stays
  // usable (and the session dialog covers expiry); full-page screens are only for
  // a first load that never got an identity.
  const loaded = me.data;
  if (loaded === undefined) {
    if (expired || (me.error instanceof ApiError && me.error.isSessionExpired)) return <SessionExpiredScreen />;
    if (me.isPending) return <FullPageMessage><Spinner /><span>Đang tải dashboard…</span></FullPageMessage>;
    if (me.error instanceof ApiError && me.error.isForbidden) return <ForbiddenScreen />;
    return (
      <FullPageMessage>
        <ErrorState error={me.error} onRetry={() => void me.refetch()} className="w-full max-w-md" />
      </FullPageMessage>
    );
  }

  const value: SessionValue = {
    identity: loaded.identity,
    role: loaded.role,
    canOperate: loaded.role === 'operator',
  };
  return (
    <SessionContext.Provider value={value}>
      {expired && postponed ? <SessionExpiredBanner /> : null}
      {children}
      <Dialog
        open={expired && !postponed}
        onClose={() => setPostponed(true)}
        dismissible={false}
        role="alertdialog"
        size="sm"
        title="Phiên đăng nhập đã hết hạn"
        footer={(
          <>
            <Button onClick={() => setPostponed(true)}>Để sau</Button>
            <Button variant="primary" onClick={reloadPage}>Tải lại trang</Button>
          </>
        )}
      >
        <p className="text-sm text-slate-600">
          Phiên Cloudflare Access của bạn đã hết hạn nên dashboard không thể tải hay lưu dữ liệu. Tải lại trang để đăng nhập lại.
        </p>
        <p className="mt-2 text-sm text-slate-500">
          Chọn "Để sau" nếu cần sao chép nội dung chưa lưu trước khi tải lại; mọi thay đổi chưa lưu sẽ mất khi tải lại.
        </p>
      </Dialog>
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession() must be used inside <SessionProvider>');
  return value;
}

export function identityLabel(identity: Identity | null): string {
  if (!identity) return 'Không rõ danh tính';
  return identity.type === 'user' ? identity.email : `service:${identity.clientId}`;
}

function SessionExpiredBanner() {
  return (
    <div role="alert" className="sticky top-0 z-40 flex flex-wrap items-center justify-center gap-3 bg-rose-600 px-4 py-2 text-sm text-white">
      <IconAlert className="size-4" />
      <span>Phiên đăng nhập đã hết hạn — dữ liệu không được cập nhật hay lưu.</span>
      <button type="button" onClick={reloadPage} className="rounded-md bg-white/15 px-2.5 py-1 font-medium hover:bg-white/25">
        Tải lại trang
      </button>
    </div>
  );
}

function FullPageMessage({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-sm text-slate-600">
      <div className="mb-2 flex items-center gap-2 text-slate-900">
        <IconRadar className="size-6 text-indigo-600" />
        <span className="text-lg font-semibold">Content Radar</span>
      </div>
      <div className="flex flex-col items-center gap-3">{children}</div>
    </main>
  );
}

export function SessionExpiredScreen() {
  return (
    <FullPageMessage>
      <div role="alert" className="flex max-w-md flex-col items-center gap-3 text-center">
        <h1 className="text-lg font-semibold text-slate-900">Phiên đăng nhập đã hết hạn</h1>
        <p>Phiên Cloudflare Access của bạn đã hết hạn. Tải lại trang để đăng nhập lại.</p>
        <Button variant="primary" onClick={reloadPage}>Tải lại trang</Button>
      </div>
    </FullPageMessage>
  );
}

export function ForbiddenScreen() {
  return (
    <FullPageMessage>
      <div role="alert" className="flex max-w-md flex-col items-center gap-3 text-center">
        <h1 className="text-lg font-semibold text-slate-900">Bạn không có quyền truy cập</h1>
        <p>
          Bạn đã đăng nhập qua Cloudflare Access nhưng tài khoản chưa được cấp vai trò viewer hoặc operator cho dashboard này.
          Hãy liên hệ quản trị viên.
        </p>
        <Button onClick={reloadPage}>Tải lại trang</Button>
      </div>
    </FullPageMessage>
  );
}
