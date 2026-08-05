import { Component, useCallback, useMemo, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Link } from 'react-router';
import { BarChart3, ClipboardCheck, ClipboardList, Images, LayoutList, LogIn, Mail, Package, ScrollText, ShieldCheck, Store, TicketPercent, Users } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { trpc } from '@/providers/trpc';
import WishingStar, { LoadingBlock } from '@/components/admin/WishingStar';
import ToastStack from '@/components/admin/Toast';
import { useToasts } from '@/components/admin/useToasts';
import Lightbox from '@/components/admin/Lightbox';
import ReviewWorkbench from '@/components/admin/ReviewWorkbench';
import OrderList from '@/components/admin/OrderList';
import PurchaseStats from '@/components/admin/PurchaseStats';
import ProductManager from '@/components/admin/ProductManager';
import PraiseManager from '@/components/admin/PraiseManager';
import PromoManager from '@/components/admin/PromoManager';
import MarketingEmailCard from '@/components/admin/MarketingEmailCard';
import StaffManager from '@/components/admin/StaffManager';
import AnalyticsManager from '@/components/admin/AnalyticsManager';
import MemberList from '@/components/admin/MemberList';
import AuditLog from '@/components/admin/AuditLog';
import { isToday } from '@/components/admin/format';
import type { AdminOrder } from '@/components/admin/types';

/**
 * §P9 員工後台 /admin —— 訂單付款截圖審批工作枱
 * - 權限守衛：未登入 → 登入卡；member → 冇權限卡；isStaff → 工作枱
 * - 左固定側欄：待審批（金 badge）／全部訂單／商品管理／打卡牆／優惠碼／（admin）員工帳號／返回前台
 * - 頂部 stats：待審核數／今日訂單數／總訂單數（由 adminList 計）
 * - 審批：A 批准、R 拒絕（必填備註）、↑↓ 揀單；截圖大圖 + 燈箱
 */

type ViewKey =
  | 'analytics'
  | 'review'
  | 'orders'
  | 'purchase'
  | 'products'
  | 'praise'
  | 'promo'
  | 'marketing'
  | 'members'
  | 'staff'
  | 'audit';

/** 有待審批付款截圖嘅訂單（舊單優先，FIFO 隊列） */
function buildQueue(orders: AdminOrder[]): AdminOrder[] {
  return orders
    .filter((o) => o.proofs.some((p) => p.status === 'pending'))
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function GuardCard({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="mx-auto flex max-w-[1280px] justify-center px-5 py-24 md:px-8">
      <div
        className="w-full max-w-[420px] rounded-3xl border p-8 text-center backdrop-blur-xl"
        style={{ background: 'var(--glass-bg-strong)', borderColor: 'var(--glass-border)' }}
      >
        <p className="script text-3xl">Staff only ✦</p>
        <h1 className="mt-2 font-serif-tc text-2xl font-bold leading-[1.3] text-txt-1">{title}</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-txt-2">{desc}</p>
        {children && <div className="mt-6">{children}</div>}
      </div>
    </section>
  );
}

function AdminConsole() {
  const utils = trpc.useUtils();
  const { user: me } = useAuth();
  const isAdmin = me?.role === 'admin';
  const { toasts, push: pushToast } = useToasts();
  const [view, setView] = useState<ViewKey>('review');
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [reviewingProofId, setReviewingProofId] = useState<number | null>(null);
  const [statusBusyId, setStatusBusyId] = useState<number | null>(null);
  const [leavingIds, setLeavingIds] = useState<ReadonlySet<number>>(new Set());

  const listQuery = trpc.orders.adminList.useQuery(undefined, {
    enabled: true,
    refetchOnWindowFocus: false,
  });
  const orders = useMemo(() => listQuery.data ?? [], [listQuery.data]);

  const queue = useMemo(() => buildQueue(orders), [orders]);
  const todayCount = useMemo(() => orders.filter((o) => isToday(o.createdAt)).length, [orders]);

  const reviewProof = trpc.orders.reviewProof.useMutation();
  const updateStatus = trpc.orders.updateStatus.useMutation();

  const errMsg = (err: unknown) => (err instanceof Error ? err.message : '操作失敗，請再試');

  /** 審批付款截圖：成功 → toast（埋寄信結果）+ 該單向右飛出（300ms）+ invalidate adminList */
  const handleReview = useCallback(
    async (proofId: number, approve: boolean, note: string | undefined, order: AdminOrder) => {
      setReviewingProofId(proofId);
      try {
        const r = await reviewProof.mutateAsync({ proofId, approve, note });
        pushToast(
          approve
            ? `已批准 ${order.orderNo}，訂單轉做已確認${r?.emailNote ?? ''}`
            : `已拒絕 ${order.orderNo}`,
          approve ? 'success' : 'info',
        );
        setLeavingIds((prev) => new Set(prev).add(order.id));
        window.setTimeout(() => {
          setLeavingIds(new Set());
          void utils.orders.adminList.invalidate();
        }, 300);
      } catch (err) {
        pushToast(errMsg(err), 'error');
      } finally {
        setReviewingProofId(null);
      }
    },
    [reviewProof, pushToast, utils],
  );

  /** 訂單狀態操作（F-D）：已確認 → 進行出貨（完成終態）／取消訂單 */
  const handleStatus = useCallback(
    async (orderId: number, status: 'shipped' | 'cancelled') => {
      setStatusBusyId(orderId);
      try {
        await updateStatus.mutateAsync({ orderId, status });
        const label = status === 'shipped' ? '已轉做進行出貨' : '已取消訂單';
        pushToast(label, status === 'cancelled' ? 'info' : 'success');
        await utils.orders.adminList.invalidate();
      } catch (err) {
        pushToast(errMsg(err), 'error');
      } finally {
        setStatusBusyId(null);
      }
    },
    [updateStatus, pushToast, utils],
  );

  const NAV: { key: ViewKey; label: string; icon: React.ReactNode; badge?: number }[] = [
    // 業務分析只限最高管理員（admin）
    ...(isAdmin
      ? [{ key: 'analytics' as ViewKey, label: '業務分析', icon: <BarChart3 size={17} aria-hidden="true" /> }]
      : []),
    {
      key: 'review',
      label: '待審批',
      icon: <ClipboardCheck size={17} aria-hidden="true" />,
      badge: queue.length,
    },
    { key: 'orders', label: '全部訂單', icon: <LayoutList size={17} aria-hidden="true" /> },
    { key: 'purchase', label: '訂貨統計', icon: <ClipboardList size={17} aria-hidden="true" /> },
    { key: 'products', label: '商品管理', icon: <Package size={17} aria-hidden="true" /> },
    { key: 'praise', label: '客戶打卡牆', icon: <Images size={17} aria-hidden="true" /> },
    { key: 'promo', label: '優惠碼', icon: <TicketPercent size={17} aria-hidden="true" /> },
    // 促銷電郵（2026-08-05 Glo 要求）：寫推廣 email 寄畀已同意接收嘅會員
    { key: 'marketing', label: '促銷電郵', icon: <Mail size={17} aria-hidden="true" /> },
    // 會員列表只限最高管理員（admin）
    ...(isAdmin
      ? [{ key: 'members' as ViewKey, label: '會員', icon: <Users size={17} aria-hidden="true" /> }]
      : []),
    // 員工帳號管理只限最高管理員（admin）
    ...(isAdmin
      ? [{ key: 'staff' as ViewKey, label: '員工帳號', icon: <ShieldCheck size={17} aria-hidden="true" /> }]
      : []),
    // 操作日誌只限最高管理員（admin）
    ...(isAdmin
      ? [{ key: 'audit' as ViewKey, label: '日誌', icon: <ScrollText size={17} aria-hidden="true" /> }]
      : []),
  ];

  const ADMIN_ONLY_HINT = (
    <p className="py-14 text-center text-[14px] text-txt-3">需要最高管理員權限。</p>
  );

  // F-D2：Record map 取代 if-else 鏈 —— 新 view 落 map 先會 render，
  // 唔會再靜默跌入 trailing else（舊坑：新 view 會 render 咗 PraiseManager）
  const viewBody: Record<ViewKey, React.ReactNode> = {
    analytics: isAdmin ? <AnalyticsManager toast={pushToast} /> : ADMIN_ONLY_HINT,
    review: (
      <ReviewWorkbench
        queue={queue}
        onReview={(pid, approve, note, order) => void handleReview(pid, approve, note, order)}
        reviewingProofId={reviewingProofId}
        onOpenLightbox={setLightboxSrc}
        leavingIds={leavingIds}
      />
    ),
    orders: (
      <OrderList
        orders={orders}
        onReview={(pid, approve, note, order) => void handleReview(pid, approve, note, order)}
        reviewingProofId={reviewingProofId}
        onStatus={(oid, status) => void handleStatus(oid, status)}
        statusBusyId={statusBusyId}
        onOpenLightbox={setLightboxSrc}
      />
    ),
    purchase: <PurchaseStats />,
    products: <ProductManager toast={pushToast} />,
    praise: <PraiseManager toast={pushToast} />,
    promo: <PromoManager toast={pushToast} />,
    marketing: <MarketingEmailCard toast={pushToast} />,
    members: <MemberList toast={pushToast} />,
    staff: isAdmin ? <StaffManager toast={pushToast} /> : ADMIN_ONLY_HINT,
    audit: isAdmin ? <AuditLog /> : ADMIN_ONLY_HINT,
  };

  const STATS: { label: string; value: number; color: string }[] = [
    { label: '待審核截圖', value: queue.length, color: 'var(--gold)' },
    { label: '今日訂單', value: todayCount, color: 'var(--starlight)' },
    { label: '總訂單數', value: orders.length, color: 'var(--lavender)' },
  ];

  return (
    <section className="mx-auto max-w-[1280px] px-5 pb-24 pt-10 md:px-8 xl:px-12">
      <header>
        <p className="script text-3xl">Staff System</p>
        <h1 className="mt-1 font-serif-tc text-3xl font-bold leading-[1.2] text-txt-1 md:text-[36px]">
          訂單審批工作枱
        </h1>
      </header>

      {/* 頂部 stats 卡 */}
      <div className="mt-6 grid grid-cols-3 gap-3 md:gap-4">
        {STATS.map((s) => (
          <div
            key={s.label}
            className="rounded-2xl border px-4 py-4 backdrop-blur-xl md:px-6"
            style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
          >
            <p className="text-[12px] text-txt-3 md:text-[13px]">{s.label}</p>
            <p
              className="mt-1 font-mono text-[26px] leading-none md:text-[32px]"
              style={{ color: s.color }}
            >
              {listQuery.isLoading ? '·' : s.value}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-8 flex flex-col gap-8 lg:flex-row">
        {/* 左固定側欄（§P9：240px，--space-1）；手機轉頂部橫 scroll chips */}
        <aside
          className="shrink-0 rounded-2xl border p-3 lg:sticky lg:top-24 lg:w-60 lg:self-start"
          style={{ borderColor: 'var(--space-line)', background: 'var(--space-1)' }}
        >
          <Link to="/" className="mb-2 hidden items-center gap-2 px-3 pt-2 lg:flex" aria-label="RedCode 首頁">
            <img src="/logo.png" alt="RedCode Fashion Design" className="h-9 w-auto" />
          </Link>
          <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible" aria-label="後台功能">
            {NAV.map((item) => {
              const active = view === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setView(item.key)}
                  aria-current={active}
                  className="flex shrink-0 items-center gap-2.5 rounded-xl px-4 py-3 text-[14px] transition-colors"
                  style={{
                    background: active ? 'var(--space-3)' : 'transparent',
                    color: active ? 'var(--text-1)' : 'var(--text-2)',
                    fontWeight: active ? 700 : 400,
                  }}
                >
                  {item.icon}
                  {item.label}
                  {item.badge != null && item.badge > 0 && (
                    <span
                      className="ml-auto rounded-full px-2 py-0.5 font-mono text-[11px] font-bold leading-none"
                      style={{ background: 'var(--gold)', color: 'var(--space-1)' }}
                      aria-label={`${item.badge} 張待審批`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
            <Link
              to="/"
              className="flex shrink-0 items-center gap-2.5 rounded-xl px-4 py-3 text-[14px] text-txt-3 transition-colors hover:text-lavender"
            >
              <Store size={17} aria-hidden="true" />
              返回前台
            </Link>
          </nav>
        </aside>

        {/* 主區 */}
        <div className="min-w-0 flex-1">
          {listQuery.isLoading ? (
            <LoadingBlock text="許願星搬緊訂單…" />
          ) : listQuery.isError ? (
            <div
              className="rounded-2xl border px-6 py-10 text-center"
              style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
            >
              <p className="text-[15px] text-pink-soft">
                載入訂單失敗：{listQuery.error.message}
              </p>
              <button
                type="button"
                onClick={() => void listQuery.refetch()}
                className="btn btn-secondary mt-5 !px-6 !py-2.5 text-[14px]"
              >
                重試
              </button>
            </div>
          ) : (
            viewBody[view]
          )}
        </div>
      </div>

      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      <ToastStack toasts={toasts} />
    </section>
  );
}

/**
 * 2026-08-04 手機黑屏診斷：AdminConsole 喺某啲手機 render 時 throw 會成頁黑晒。
 * ErrorBoundary 接住錯誤，將 message + stack 直接顯示喺畫面，
 * 等同事 cap 圖傳返就可以即刻定位邊個組件出事（電腦正常、手機黑屏嘅個案）。
 */
class AdminErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[admin] 後台 render 錯誤：', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <section className="mx-auto w-full max-w-[680px] px-4 py-8">
          <div className="rounded-xl border border-red-200 bg-white p-5">
            <h2 className="m-0 text-[17px] font-bold text-red-700">後台顯示出咗錯（請截圖畀技術跟進）</h2>
            <p className="mb-3 mt-2 text-[13px] leading-relaxed text-gray-500">
              下面係錯誤資料，cap 圖傳返就可以搵到問題；或者撳下面個掣重新載入試下。
            </p>
            <pre className="m-0 whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-3 text-[12px] leading-relaxed text-gray-800">
              {String(error.message || error)}
              {'\n\n'}
              {error.stack ?? ''}
            </pre>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="btn btn-primary mt-4 w-full"
            >
              重新載入
            </button>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}

export default function Admin() {
  const { user, isLoading, isStaff } = useAuth();

  if (isLoading) {
    return (
      <section className="flex min-h-[60dvh] items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <WishingStar size={32} />
          <p className="text-[14px] text-txt-3">核實緊員工身份…</p>
        </div>
      </section>
    );
  }

  if (!user) {
    return (
      <GuardCard title="員工請先登入" desc="呢個係 RedCode 內部訂單審批系統，請用員工帳號登入。">
        <Link to="/login" className="btn btn-primary w-full">
          <LogIn size={16} aria-hidden="true" />
          去登入
        </Link>
      </GuardCard>
    );
  }

  if (!isStaff) {
    return (
      <GuardCard
        title="呢個帳號冇員工權限"
        desc={`你好 ${user.name}，你嘅帳號係會員身份。如果你係 RedCode 同事，請搵 Glo Glo 開通員工權限。`}
      >
        <Link to="/" className="btn btn-secondary w-full">
          返回前台
        </Link>
      </GuardCard>
    );
  }

  return (
    <AdminErrorBoundary>
      <AdminConsole />
    </AdminErrorBoundary>
  );
}
