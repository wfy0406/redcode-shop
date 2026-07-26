import { useMemo } from 'react';
import { Link } from 'react-router';
import { Wallet } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { trpc } from '@/providers/trpc';
import WishingStar from '@/components/account/WishingStar';
import OrderCard from '@/components/account/OrderCard';
import ProfileCard from '@/components/account/ProfileCard';
import PasswordCard from '@/components/account/PasswordCard';
import AccountToastStack, { useAccountToasts } from '@/components/account/Toast';

/**
 * RedCode 設計系統 §P8 —— 會員中心 /account
 * 未登入 → 玻璃卡「請先登入」+ 登入掣；
 * 頂部會員資料卡（ProfileCard：稱呼/地址/年齡逐行 inline edit + 登出掣）；
 * 更改密碼卡（PasswordCard）；
 * 我的訂單：trpc.orders.myOrders，每張訂單一張玻璃卡（OrderCard）。
 */

export default function Account() {
  const { user, isLoading, logout } = useAuth();
  const { toasts, push: pushToast } = useAccountToasts();

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

  // 未登入
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
            <p className="mt-2 text-[15px] text-txt-2">登入後就可以睇返你嘅訂單同會員資料。</p>
          </div>
          <Link to="/login" state={{ from: '/account' }} className="btn btn-primary w-full">
            去登入
          </Link>
        </div>
      </section>
    );
  }

  const orders = ordersQuery.data ?? [];

  return (
    <section className="mx-auto w-full max-w-[1280px] px-5 py-12 md:px-8 md:py-16 xl:px-12">
      <p className="script text-3xl">My little galaxy</p>
      <h1 className="mt-2 font-serif-tc text-3xl font-bold leading-[1.2] text-txt-1 md:text-[44px]">會員中心</h1>

      {/* 會員資料卡（逐行 inline edit） */}
      <div className="mt-8">
        <ProfileCard user={user} onLogout={logout} pushToast={pushToast} />
      </div>

      {/* 更改密碼卡 */}
      <div className="mt-6">
        <PasswordCard pushToast={pushToast} />
      </div>

      {/* 付款方式入口（會員限定） */}
      <Link
        to="/payment"
        className="mt-6 flex items-center justify-between gap-4 rounded-2xl border p-5 transition-colors duration-200 hover:border-gold md:p-6"
        style={{
          background: 'var(--glass-bg)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderColor: 'var(--glass-border)',
        }}
      >
        <div className="flex items-center gap-4">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border"
            style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}
          >
            <Wallet size={20} aria-hidden="true" />
          </span>
          <div>
            <p className="font-serif-tc text-lg font-bold text-txt-1">付款方式</p>
            <p className="text-sm text-txt-3">中銀／PayMe／Alipay／FPS 轉數快收款資料</p>
          </div>
        </div>
        <span className="font-mono text-lg text-gold" aria-hidden="true">→</span>
      </Link>

      {/* 我的訂單 */}
      <div className="mt-12 flex items-baseline justify-between">
        <h2 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px]">我的訂單</h2>
        {orders.length > 0 && <span className="font-mono text-sm text-txt-3">{orders.length} 張</span>}
      </div>

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
          <img src="/empty-cart.jpg" alt="" className="h-32 w-auto opacity-90" loading="lazy" />
          <p className="script text-3xl">No wishes yet</p>
          <p className="max-w-sm text-[15px] text-txt-2">你仲未有訂單。去揀件啱心水嘅衫，許個願先啦。</p>
          <Link to="/products" className="btn btn-secondary">
            去揀衫
          </Link>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          {orders.map((order) => (
            <OrderCard key={order.id} order={order} productImages={productImages} />
          ))}
        </div>
      )}

      {/* 全域成功 toast（資料已更新／密碼已更新） */}
      <AccountToastStack toasts={toasts} />
    </section>
  );
}
