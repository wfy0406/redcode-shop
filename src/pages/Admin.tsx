import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import {
  ClipboardCheck,
  LayoutList,
  Package,
  LogOut,
  Camera,
  TicketPercent,
  Users as UsersIcon,
  BarChart3,
} from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { clearToken } from '@/lib/auth';
import ReviewWorkbench from '@/components/admin/ReviewWorkbench';
import OrderList from '@/components/admin/OrderList';
import ProductManager from '@/components/admin/ProductManager';
import PraiseManager from '@/components/admin/PraiseManager';
import StaffManager from '@/components/admin/StaffManager';
import PromoManager from '@/components/admin/PromoManager';
import AnalyticsManager from '@/components/admin/AnalyticsManager';
import MemberList from '@/components/admin/MemberList';
import ToastStack from '@/components/admin/ToastStack';
import Lightbox from '@/components/admin/Lightbox';
import { useToasts } from '@/components/admin/useToasts';
import type { AdminOrder, ProofStatus } from '@/components/admin/types';

type ViewKey = 'analytics' | 'review' | 'orders' | 'products' | 'praise' | 'promo' | 'members' | 'staff';

/**
 * 後台主頁（§P6-P8；F-D2 render 鏈重構成 Record map，消滅 trailing-else 暗坑）
 * - staff 預設落待審批；admin 預設落業務分析
 * - 左固定側欄：業務分析（admin）／待審批（金 badge）／全部訂單／商品管理／打卡牆／優惠碼／（admin）會員／（admin）員工帳號／返回前台
 */
export default function Admin() {
  const { user, isStaff, isAdmin, isLoading } = useAuth();
  const [view, setView] = useState<ViewKey>(isAdmin ? 'analytics' : 'review');
  const [lightbox, setLightbox] = useState<string | null>(null);
  const { toasts, push } = useToasts();
  const utils = trpc.useUtils();

  const ordersQuery = trpc.orders.adminList.useQuery(undefined, {
    enabled: !!isStaff,
    refetchInterval: 30_000,
  });
  const orders = useMemo(() => ordersQuery.data ?? [], [ordersQuery.data]);
  const pendingCount = useMemo(
    () => orders.filter((o) => o.status === 'payment_review').length,
    [orders],
  );

  const reviewMutation = trpc.orders.reviewProof.useMutation({
    onSuccess: (_data, vars) => {
      push(vars.approve ? '已確認收款' : '已拒絕截圖', vars.approve ? 'success' : 'info');
      void utils.orders.adminList.invalidate();
    },
    onError: (err) => push(err.message, 'error'),
  });
  const statusMutation = trpc.orders.updateStatus.useMutation({
    onSuccess: (data) => {
      const label =
        data?.status === 'shipped'
          ? '訂單已進行出貨'
          : '訂單已取消';
      push(label, 'success');
      void utils.orders.adminList.invalidate();
    },
    onError: (err) => push(err.message, 'error'),
  });

  const handleReview = useCallback(
    (proofId: number, approve: boolean, note: string | undefined, _order: AdminOrder) => {
      reviewMutation.mutate({ proofId, approve, note });
    },
    [reviewMutation],
  );

  const handleStatus = useCallback(
    (orderId: number, status: 'shipped' | 'cancelled') => {
      statusMutation.mutate({ orderId, status });
    },
    [statusMutation],
  );

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-pink border-t-transparent" />
      </div>
    );
  }

  if (!isStaff) {
    return (
      <div className="mx-auto max-w-[520px] px-5 py-24 text-center">
        <div className="glass rounded-3xl p-10">
          <p className="script text-3xl">staff only</p>
          <h1 className="mt-2 font-serif-tc text-2xl font-bold text-txt-1">後台要員工帳號先入到</h1>
          <p className="mt-3 text-sm text-txt-3">
            {user
              ? '你而家嘅帳號冇後台權限。'
              : '請用員工或管理員帳號登入。'}
          </p>
          {!user && (
            <Link to="/login?from=/admin" className="btn btn-primary mt-6 inline-flex">
              去登入
            </Link>
          )}
        </div>
      </div>
    );
  }

  const NAV: { key: ViewKey; label: string; icon: ReactNode; badge?: number; adminOnly?: boolean }[] = [
    { key: 'analytics', label: '業務分析', icon: <BarChart3 size={17} />, adminOnly: true },
    {
      key: 'review',
      label: '待審批',
      icon: <ClipboardCheck size={17} />,
      badge: pendingCount,
    },
    { key: 'orders', label: '全部訂單', icon: <LayoutList size={17} /> },
    { key: 'products', label: '商品管理', icon: <Package size={17} /> },
    { key: 'praise', label: '打卡牆', icon: <Camera size={17} /> },
    { key: 'promo', label: '優惠碼', icon: <TicketPercent size={17} /> },
    { key: 'members', label: '會員', icon: <UsersIcon size={17} />, adminOnly: true },
    ...(isAdmin ? [{ key: 'staff' as const, label: '員工帳號', icon: <UsersIcon size={17} /> }] : []),
  ];

  const VIEWS: Record<ViewKey, ReactNode> = {
    analytics: <AnalyticsManager toast={push} />,
    review: (
      <ReviewWorkbench
        orders={orders}
        onReview={handleReview}
        reviewingProofId={reviewMutation.isPending ? reviewMutation.variables?.proofId ?? null : null}
        onOpenLightbox={setLightbox}
      />
    ),
    orders: (
      <OrderList
        orders={orders}
        onReview={handleReview}
        reviewingProofId={reviewMutation.isPending ? reviewMutation.variables?.proofId ?? null : null}
        onStatus={handleStatus}
        statusBusyId={statusMutation.isPending ? statusMutation.variables?.orderId ?? null : null}
        onOpenLightbox={setLightbox}
      />
    ),
    products: <ProductManager toast={push} />,
    praise: <PraiseManager toast={push} />,
    promo: <PromoManager toast={push} />,
    members: <MemberList />,
    staff: <StaffManager toast={push} />,
  };

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-[1440px] gap-6 px-4 py-6 md:px-6">
      {/* 左固定側欄 */}
      <aside
        className="glass sticky top-6 hidden h-fit w-52 shrink-0 rounded-2xl p-3 md:block"
        aria-label="後台導覽"
      >
        <p className="px-3 pb-2 pt-1 font-mono text-[11px] uppercase tracking-[0.18em] text-txt-3">
          RedCode 後台
        </p>
        <nav className="flex flex-col gap-1">
          {NAV.filter((item) => !item.adminOnly || isAdmin).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setView(item.key)}
              aria-current={view === item.key ? 'page' : undefined}
              className="flex h-11 items-center gap-3 rounded-xl px-3 text-left text-[14px] transition-colors"
              style={
                view === item.key
                  ? { background: 'var(--glass-bg-strong)', color: 'var(--starlight)', border: '1px solid var(--pink)' }
                  : { color: 'var(--text-2)', border: '1px solid transparent' }
              }
            >
              {item.icon}
              <span className="flex-1">{item.label}</span>
              {item.badge != null && item.badge > 0 && (
                <span
                  className="rounded-full px-2 py-0.5 font-mono text-[11px] font-bold"
                  style={{ background: 'var(--gold)', color: 'var(--space-1)' }}
                >
                  {item.badge}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--space-line)' }}>
          <Link
            to="/"
            className="flex h-10 items-center gap-2 rounded-xl px-3 text-[13px] text-txt-3 transition-colors hover:text-txt-1"
          >
            <LogOut size={15} />
            返回前台
          </Link>
          <button
            type="button"
            onClick={() => {
              clearToken();
              window.location.href = '/';
            }}
            className="flex h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-[13px] text-txt-3 transition-colors hover:text-pink-soft"
          >
            <LogOut size={15} />
            登出（{user?.name}）
          </button>
        </div>
      </aside>

      {/* 手機頂部 tab bar */}
      <div className="fixed inset-x-0 bottom-0 z-40 flex gap-1 overflow-x-auto border-t px-2 py-2 md:hidden" style={{ background: 'var(--space-1)', borderColor: 'var(--space-line)' }}>
        {NAV.filter((item) => !item.adminOnly || isAdmin).map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setView(item.key)}
            className="flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-[12px]"
            style={
              view === item.key
                ? { background: 'var(--pink)', color: 'var(--space-1)', fontWeight: 700 }
                : { color: 'var(--text-2)' }
            }
          >
            {item.icon}
            {item.label}
            {item.badge != null && item.badge > 0 && (
              <span className="rounded-full px-1.5 font-mono text-[10px] font-bold" style={{ background: 'var(--gold)', color: 'var(--space-1)' }}>
                {item.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* 主內容 */}
      <main className="min-w-0 flex-1 pb-20 md:pb-0">
        {ordersQuery.isLoading && (
          <div className="flex min-h-[40vh] items-center justify-center">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-pink border-t-transparent" />
          </div>
        )}
        {!ordersQuery.isLoading && ordersQuery.isError && (
          <div className="glass rounded-2xl p-8 text-center">
            <p className="text-pink-soft">載入訂單失敗：{ordersQuery.error.message}</p>
          </div>
        )}
        {!ordersQuery.isLoading && !ordersQuery.isError && VIEWS[view]}
      </main>

      <ToastStack toasts={toasts} />
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
