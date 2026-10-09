import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Calendar, Wallet } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { trpc } from '@/providers/trpc';
import WishingStar from '@/components/account/WishingStar';
import VipCard from '@/components/account/VipCard';
import WalletCard from '@/components/account/WalletCard';
import VipCertCard from '@/components/account/VipCertCard';
import { vipTierTheme, formatMemberNo } from '@/lib/vipTheme';
import OrderCard from '@/components/account/OrderCard';
import ProfileCard from '@/components/account/ProfileCard';
import DeliveryPrefCard from '@/components/account/DeliveryPrefCard';
import CompleteProfileCard from '@/components/account/CompleteProfileCard';
import GoogleLinkCard from '@/components/account/GoogleLinkCard';
import MarketingPrefCard from '@/components/account/MarketingPrefCard';
import LivePushCard from '@/components/account/LivePushCard';
import PasswordCard from '@/components/account/PasswordCard';
import AccountToastStack, { useAccountToasts } from '@/components/account/Toast';

/**
 * RedCode 設計系統 §P8 —— 會員中心 /account
 * 未登入 → 玻璃卡「請先登入」+ 登入掣；
 * 頂部會員資料卡（ProfileCard：稱呼/地址/年齡逐行 inline edit + 登出掣）；
 * 更改密碼卡（PasswordCard）；
 * 我的訂單：trpc.orders.myOrders，每張訂單一張玻璃卡（OrderCard）；
 * 訂單可以按日期搜尋（本地日子對照 createdAt）。
 */

/**
 * v2.2.0 英式 atelier 克制感 section label：
 * 大寫闊字距英文小標（letter-spacing 0.3em）＋editorial serif 中文標題＋hairline 金線分隔
 */
function SectionLabel({ en, zh }: { en: string; zh: string }) {
  return (
    <div className="mt-16 md:mt-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-gold">{en}</p>
      <div className="mt-3 flex items-center gap-5">
        <h2 className="shrink-0 font-serif-tc text-xl font-semibold leading-[1.3] text-txt-1 md:text-2xl">
          {zh}
        </h2>
        <span
          aria-hidden="true"
          className="h-px flex-1 opacity-30"
          style={{ background: 'var(--gold)' }}
        />
      </div>
    </div>
  );
}

/** 本地日子（YYYY-MM-DD）對照：createdAt 係咪同一日 */
function sameLocalDay(d: Date | string, ymd: string): boolean {
  const date = d instanceof Date ? d : new Date(d);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` === ymd;
}

export default function Account() {
  const { user, isLoading, logout } = useAuth();
  const { toasts, push: pushToast } = useAccountToasts();
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
  const filteredOrders = orderDate
    ? orders.filter((o) => sameLocalDay(o.createdAt, orderDate))
    : orders;

  // v2.2.0：頂部會員級別 hero 帶——銀／金用級別絲綢橫幅，普通會員用 member-hero.jpg
  const tierTheme = vipTierTheme(user.vipTier);
  const heroImg = tierTheme.ribbonImg ?? '/vip/member-hero.jpg';

  return (
    <section className="mx-auto w-full max-w-[1280px] px-5 py-12 md:px-8 md:py-16 xl:px-12">
      {/* 頂部會員級別 hero 帶（絲綢底＋深色漸層，文字擺左；hairline 金線框） */}
      <header className={`relative overflow-hidden ${tierTheme.hairlineClass}`}>
        <img
          src={heroImg}
          alt=""
          className="absolute inset-0 h-full w-full object-cover object-right"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(90deg, rgba(10,6,20,.94) 0%, rgba(10,6,20,.78) 42%, rgba(10,6,20,.42) 72%, rgba(10,6,20,.55) 100%)',
          }}
        />
        <div className="relative px-6 py-14 md:px-12 md:py-20">
          <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-gold">
            RedCode Membership
          </p>
          <p className="script mt-5 text-3xl">My little galaxy</p>
          <h1 className="mt-2 font-serif-tc text-3xl font-bold leading-[1.2] text-txt-1 md:text-[44px]">
            會員中心
          </h1>
          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
            <span className={tierTheme.chipClass}>
              {tierTheme.seal} {tierTheme.label}
            </span>
            <span className="font-mono text-[13px] tracking-[0.18em] text-txt-2">
              {formatMemberNo(user.id)}
            </span>
          </div>
        </div>
      </header>

      {/* 會員證書下載（v2.2.0）：JPG／PDF，歷史晉升都下載到 */}
      <SectionLabel en="Membership Certificate" zh="會員證書" />
      <div className="mt-8">
        <VipCertCard />
      </div>

      {/* VIP 級別區塊（v2.1.0，2026-09-29）：級別 badge＋有效期＋年度消費＋升級進度＋ /vip 入口 */}
      <SectionLabel en="Tier & Privileges" zh="會員級別" />
      <div className="mt-8">
        <VipCard />
      </div>

      {/* 購物金區塊（v2.5.0，2026-10-09 老闆指令）：餘額＋待跟進充值單＋最近流水＋充值入口 */}
      <SectionLabel en="Wallet" zh="購物金" />
      <div className="mt-8">
        <WalletCard />
      </div>

      <SectionLabel en="Profile & Settings" zh="會員資料" />

      {/* Google 開戶（電話仲係 g- 佔位）→ 頂置「完成會員資料」卡：Google 預填、可改、確認先儲存 */}
      {user.phone.startsWith('g-') && (
        <div className="mt-8">
          <CompleteProfileCard user={user} pushToast={pushToast} />
        </div>
      )}

      {/* 會員資料卡（逐行 inline edit） */}
      <div className="mt-8">
        <ProfileCard user={user} onLogout={logout} pushToast={pushToast} />
      </div>

      {/* 預設取貨方式卡（2026-08-08 Glo 要求）：送貨上門／順豐站／智能櫃，結帳自動帶入 */}
      <div className="mt-6">
        <DeliveryPrefCard user={user} pushToast={pushToast} />
      </div>

      {/* 優惠資訊接收設定卡（2026-08-05 Glo 要求）：會員自己開/關直接促銷同意 */}
      <div className="mt-6">
        <MarketingPrefCard optIn={!!user.marketingOptIn} pushToast={pushToast} />
      </div>

      {/* 直播開播通知卡（v2.2.0）：綁定/取消呢部裝置嘅 Web Push */}
      <div className="mt-6">
        <LivePushCard pushToast={pushToast} />
      </div>

      {/* Google 帳號連結卡（2026-08-04）：舊會員綁定 Google，之後一撳登入；未設 GOOGLE_CLIENT_ID 會自動隱藏 */}
      <div className="mt-6">
        <GoogleLinkCard linked={!!user.googleLinked} pushToast={pushToast} />
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
      <SectionLabel en="Order History" zh="我的訂單" />
      {/* 按日期搜尋訂單 */}
      {orders.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <span className="font-mono text-sm text-txt-3">{orders.length} 張</span>
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

      {/* 全域成功 toast（資料已更新／密碼已更新） */}
      <AccountToastStack toasts={toasts} />
    </section>
  );
}
