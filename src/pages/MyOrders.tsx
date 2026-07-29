import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Calendar } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { trpc } from '@/providers/trpc';
import WishingStar from '@/components/account/WishingStar';
import OrderCard from '@/components/account/OrderCard';

/**
 * 我的訂單 /orders —— 2026-07-30 由會員中心抽出嘅獨立頁
 * 背景：有客人唔識撳會員名入會員中心搵訂單，Glo 要求主選單一撳就到。
 * 內容同會員中心嘅訂單段一致：trpc.orders.myOrders + 日期搜尋 + OrderCard；
 * 待付款／被退回嘅單，OrderCard 會內嵌 PaymentProofDropzone 即場上傳截圖。
 * 未登入 → 玻璃卡「請先登入」，登入後經 state.from 自動返嚟呢頁。
 */

/** 本地日子（YYYY-MM-DD）對照：createdAt 係咪同一日 */
function sameLocalDay(d: Date | string, ymd: string): boolean {
  const date = d instanceof Date ? d : new Date(d);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` === ymd;
}

export default function MyOrders() {
  const { user, isLoading } = useAuth();
  // 我的訂單日期搜尋（空字串 = 唔篩）
  const [orderDate, setOrderDate] = useState('');

  const ordersQuery = trpc.orders.myOrders.useQuery(undefined, { enabled: !!user });
  // orderItems 無商品圖快照，用 products.list 對照 productId 攞縮圖
  const productsQuery = trpc.products.list.useQuery();

  const productImages = useMemo(() => {
    const map: Record<number, string> = {};
    for (const p of productsQuery.data ?? []) map[p.id] = p.image;
    return map;
  }, [productsQuery.data]);

  // 驗證會員 session 中
  if (isLoading) {
    return (
      <section className="mx-auto flex min-h-[calc(100dvh-60px)] w-full max-w-[1280px] items-center justify-center px-5 py-24 md:min-h-[calc(100dvh-72px)] md:px-8 xl:px-12">
        <WishingStar size={32} spinning />
      </section>
    );
  }

  // 未登入：提示登入，登入後自動返嚟 /orders
  if (!user) {
    return (
      <section className="mx-auto flex min-h-[calc(100dvh-60px)] w-full max-w-[1280px] items-center justify-center px-5 py-24 md:min-h-[calc(100dvh-72px)] md:px-8 xl:px-12">
        <div
          className="flex w-full max-w-[420px] flex-col items-center gap-6 rounded-2xl border p-10 text-center"
          style={{
            background: 'var(--glass-bg-strong)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            borderColor: 'var(--glass-border)',
          }}
        >
          <WishingStar size={36} />
          <div>
            <h1 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1">請先登入</h1>
            <p className="mt-2 text-[15px] text-txt-2">登入後就可以睇返你嘅訂單，未過數嘅單仲可以即場上傳付款截圖。</p>
          </div>
          <Link to="/login" state={{ from: '/orders' }} className="btn btn-primary w-full">
            去登入
          </Link>
        </div>
      </section>
    );
  }

  const orders = ordersQuery.data ?? [];
  const filteredOrders = orderDate
    ? orders.filter((o) => sameLocalDay(o.createdAt, orderDate))
    : orders;

  return (
    <section className="mx-auto w-full max-w-[1280px] px-5 py-12 md:px-8 md:py-16 xl:px-12">
      <p className="script text-3xl">My wishes</p>
      <div className="mt-2 flex items-baseline justify-between gap-4">
        <h1 className="font-serif-tc text-3xl font-bold leading-[1.2] text-txt-1 md:text-[44px]">我的訂單</h1>
        {orders.length > 0 && <span className="font-mono text-sm text-txt-3">{orders.length} 張</span>}
      </div>
      <p className="mt-3 max-w-xl text-[15px] text-txt-2">
        未過數嘅單可以喺下面直接上傳付款截圖，我哋收到就會即刻對數。
      </p>

      {/* 按日期搜尋訂單 */}
      {orders.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <label
            className="flex h-11 items-center gap-2 rounded-full border px-4"
            style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
          >
            <Calendar size={15} className="shrink-0 text-txt-3" aria-hidden="true" />
            <input
              type="date"
              value={orderDate}
              onChange={(e) => setOrderDate(e.target.value)}
              aria-label="按日期搜尋訂單"
              className="bg-transparent font-mono text-[13px] text-txt-1 focus:outline-none"
            />
          </label>
          {orderDate && (
            <>
              <button
                type="button"
                onClick={() => setOrderDate('')}
                className="text-[13px] text-lavender underline underline-offset-4 transition-colors hover:text-txt-1"
              >
                清除日期
              </button>
              <span className="font-mono text-[12px] text-txt-3">{filteredOrders.length} 張符合</span>
            </>
          )}
        </div>
      )}

      {ordersQuery.isLoading ? (
        <div className="flex justify-center py-20">
          <WishingStar size={28} spinning />
        </div>
      ) : ordersQuery.isError ? (
        <p role="alert" className="mt-6 rounded-xl border border-pink bg-space-2 px-4 py-3 text-[13px] text-pink-soft">
          訂單載入失敗，請稍後重新整理。
        </p>
      ) : orders.length === 0 ? (
        /* 空訂單狀態 */
        <div className="mt-8 flex flex-col items-center gap-5 rounded-2xl border border-space-line bg-space-2 px-6 py-16 text-center">
          <img src="/empty-cart.svg" alt="" className="h-32 w-auto opacity-90" loading="lazy" />
          <p className="script text-3xl">No wishes yet</p>
          <p className="max-w-sm text-[15px] text-txt-2">你仲未有訂單。去揀件啱心水嘅衫，許個願先啦。</p>
          <Link to="/products" className="btn btn-secondary">
            去揀衫
          </Link>
        </div>
      ) : filteredOrders.length === 0 ? (
        <p className="mt-6 rounded-xl border border-space-line bg-space-2 px-4 py-6 text-center text-[14px] text-txt-3">
          呢一日冇訂單，揀另一日睇睇。
        </p>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          {filteredOrders.map((order) => (
            <OrderCard key={order.id} order={order} productImages={productImages} />
          ))}
        </div>
      )}
    </section>
  );
}
