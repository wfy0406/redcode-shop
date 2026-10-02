import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, useLocation } from 'react-router';
import { ChevronDown, Heart, Menu, MessageCircle, ShoppingBag, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { trpc } from '@/providers/trpc';
import type { CartLine } from '@/components/cart/types';
import MessengerIcon from '@/components/MessengerIcon';
import AnimatedLogo from '@/components/AnimatedLogo';
import { normalizeVipTier } from '@/components/VipBadge';
import { vipTierTheme } from '@/lib/vipTheme';
import { PRODUCT_CATEGORIES } from '@contracts/types';

/**
 * RedCode 設計系統 §4.2 —— 玻璃導航
 * sticky top-0 z-50（react-dev.md navbar contract：唔用 fixed，Layout 唔使 offset bookkeeping）
 * 高度 72px（手機 60px）、glass-bg + blur 16px、底邊 1px glass-border
 * 2026-08-06（Glo 要求）：WhatsApp 掣左邊加 Messenger 掣，一撳直開 m.me 對話。
 * 2026-08-06（Glo 要求）：刪走「員工內部系統」WMS 連結（desktop 右側＋手機選單底部）——
 * 放上網擔心被攻擊或資料外洩，唔俾外部見到（員工自己記住 WMS 網址直接用）。
 * 「後台管理」入口保留：登入嘅員工／主管／管理員先見到，外部訪客見唔到。
 * 2026-08-07（Glo 要求）：選單「商品」可展開商品分類——desktop hover（＋鍵盤 focus）
 * 彈 dropdown；手機全屏選單撳箭嘴展開分類子列表。分類連結去 /products?category=X，
 * 商品頁會讀網址參數自動篩選。
 */

// TODO: 換返 RedCode 真 WhatsApp 號碼
const WHATSAPP_URL = 'https://wa.me/85254835368';
// Facebook Messenger 深層連結：撳咗直開 RedCode 專頁對話
const MESSENGER_URL = 'https://m.me/redcodexhk';

/** 時段問候（2026-08-04 Glo 要求；跟客人裝置本地時間）：早晨 05–12／午安 12–18／晚上好 18–05 */
function greetingNow(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return '早晨';
  if (h >= 12 && h < 18) return '午安';
  return '晚上好';
}

// v2.2.13（老闆指令）：主導航淨返購物核心四項，順豐站點查詢／VIP會員制度／關於我們
// 改做次級「更多」——desktop 收 hover dropdown，手機 drawer 擺會員中心下面（跟老闆畀嘅順序）。
// 之前七條主連結＋右邊 icon 群，電腦版迫到標題摺做兩行（格式跑晒）。
const MAIN_LINKS = [
  { to: '/', label: '首頁' },
  { to: '/products', label: '商品' },
  { to: '/live', label: '直播' },
  // 2026-07-30：有客人唔識入會員中心搵訂單 → 主選單直接放「我的訂單」；
  // 未登入撳入去會見到「請先登入」提示，登入後自動返訂單頁
  { to: '/orders', label: '我的訂單' },
];

// 次級資訊連結（順序係老闆 v2.2.13 親口指定：順豐 → VIP → 關於，唔准調）
const INFO_LINKS = [
  // v2.2.0：順豐站點查詢（公開頁，客人同員工都用）
  { to: '/sf-stations', label: '順豐站點查詢' },
  // v2.2.12（老闆指令）：目錄加「VIP會員制度」
  { to: '/vip', label: 'VIP會員制度' },
  { to: '/about', label: '關於我們' },
];

/** YYYYMMDD → 2026年9月（直播場次月份分組標題；v2.2.13 老闆指令：一個月30日唔可以逐日排晒出嚟） */
function fmtLiveMonth(d: string): string {
  if (!/^\d{8}$/.test(d)) return d;
  return `${d.slice(0, 4)}年${Number(d.slice(4, 6))}月`;
}

type LiveDayGroup = { liveDate: string; sessions: string[] };
type LiveMonthGroup = { key: string; label: string; days: LiveDayGroup[]; sessionCount: number };

/** 日期→場次清單按年月分組（月份新→舊；月份入面維持日期新→舊） */
function groupLiveMonths(groups: LiveDayGroup[]): LiveMonthGroup[] {
  const byMonth = new Map<string, LiveDayGroup[]>();
  for (const g of groups) {
    const key = /^\d{8}$/.test(g.liveDate) ? g.liveDate.slice(0, 6) : 'other';
    const arr = byMonth.get(key) ?? [];
    arr.push(g);
    byMonth.set(key, arr);
  }
  return [...byMonth.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, days]) => ({
      key,
      label: key === 'other' ? '其他' : fmtLiveMonth(`${key}01`),
      days,
      sessionCount: days.reduce((n, d) => n + d.sessions.length, 0),
    }));
}

/**
 * 手機 drawer 連結行（v2.2.13 老闆指令「高度美化」）：
 * 金色 mono 序號 01/02… ＋ serif 大標題 ＋ 當前頁 ✦ 標記；動畫只用 opacity/transform（老闆鐵律）。
 */
function DrawerRow({
  to,
  label,
  index,
  active,
  gold,
  delayMs,
  onNavigate,
}: {
  to: string;
  label: string;
  index: number;
  active: boolean;
  gold?: boolean;
  delayMs: number;
  onNavigate: () => void;
}) {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      className="group flex items-baseline gap-4 border-b py-4"
      style={{
        borderColor: 'var(--space-line)',
        animation: `mobile-nav-in 400ms var(--ease-expo) ${delayMs}ms both`,
      }}
    >
      <span
        aria-hidden="true"
        className="font-mono text-[11px] font-medium tracking-[0.2em]"
        style={{ color: gold ? 'rgba(245,197,24,0.85)' : 'rgba(245,197,24,0.45)' }}
      >
        {String(index).padStart(2, '0')}
      </span>
      <span
        className={cn(
          'font-serif-tc text-2xl font-semibold transition-colors',
          active ? 'text-pink-soft' : gold ? '' : 'text-txt-1 group-hover:text-pink-soft',
        )}
        style={gold ? { color: 'var(--gold)' } : undefined}
      >
        {label}
      </span>
      {active && (
        <span aria-hidden="true" className="ml-auto text-sm text-pink-soft">
          ✦
        </span>
      )}
    </NavLink>
  );
}

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  // 手機選單「商品」分類展開狀態（2026-08-07 Glo 要求：選單商品可展開見到分類）
  const [shopExpanded, setShopExpanded] = useState(false);
  const { pathname, search } = useLocation();
  // 當前商品類別（URL ?category=）：分類連結高亮判斷（NavLink 嘅 isActive 唔分 search param，所以要人手計）
  const currentCat = new URLSearchParams(search).get('category') ?? '';
  // 當前直播場次（URL ?liveDate=&liveSession=，F8 2026-09-29）：場次連結高亮判斷
  const currentLiveDate = new URLSearchParams(search).get('liveDate') ?? '';
  const currentLiveSession = new URLSearchParams(search).get('liveSession') ?? '';
  const { user, isStaff, logout } = useAuth();
  // F4：badge 接通真購物車數量（未登入唔好 call，enabled 守住）
  const cartQuery = trpc.cart.list.useQuery(undefined, {
    enabled: !!user,
    refetchOnWindowFocus: false,
  });
  const cartCount = ((cartQuery.data ?? []) as CartLine[]).reduce(
    (sum, line) => sum + line.quantity,
    0,
  );
  // 直播場次（2026-09-29 F8）：商品選單底加「📺 直播場次」區——
  // 日期可展開見場次；冇場次數據就唔顯示呢區。60s stale，導航唔使次次打。
  const liveSessionsQuery = trpc.products.liveSessions.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const liveGroups = liveSessionsQuery.data ?? [];
  // v2.2.13（老闆指令）：場次先按年月分組——一個月30日唔會再排出成條長清單；
  // desktop dropdown 同手機選單共用同一份分組＋展開狀態（一個開另一個跟住開，冇壞處）
  const liveMonths = useMemo(() => groupLiveMonths(liveGroups), [liveGroups]);
  // 邊個月份展開緊（預設自動開最新嗰個月，客人一開就見到近期場次）
  const [liveMonthOpen, setLiveMonthOpen] = useState<string | null>(null);
  // v2.2.42（老闆實測「直播場次收唔埋，按咗都係展開」）：舊 effect 見 null 就自動開返，
  // 客人一撳收埋 → set null → effect 即刻開返，永遠收唔到。
  // 加 ref 記住「自動開過未」——得第一次入數據嗰下先自動開最新月，
  // 之後客人手動收埋就唔再碰佢。
  const liveMonthAutoOpened = useRef(false);
  useEffect(() => {
    if (!liveMonthAutoOpened.current && liveMonths.length > 0) {
      liveMonthAutoOpened.current = true;
      setLiveMonthOpen(liveMonths[0].key);
    }
  }, [liveMonths]);

  // VIP 級別 badge（v2.2.13 老闆指令 bug fix）：同首頁打招呼用同一數據源 auth.me——
  // 後端 publicUser 已用 effectiveVipTier 計好有效級別（過期即 NONE）。
  // 之前導覽列自己 call vip.getMyVip，兩條快取唔同步，搞到「首頁寶寶會員、導覽列金VIP」撞車。
  const vipTier = user ? normalizeVipTier(user.vipTier) : null;
  // v2.2.0 級別格調：chip／色一律由 vipTheme.ts 出（NONE 低調——Navbar 唔出 chip）
  const vipTheme = vipTierTheme(vipTier);

  // 手機選單主組連結（購物核心＋會員中心）；更多資訊三項跟老闆順序擺會員中心下面（見 INFO_LINKS）
  const mobileMainLinks = [
    ...MAIN_LINKS,
    { to: '/cart', label: '購物車' },
    user
      ? { to: '/account', label: `會員中心（${user.name}）` }
      : { to: '/login', label: '會員登入' },
  ];

  return (
    <header
      // v2.2.13 老闆指令——iPhone 狀態列/Dynamic Island 遮住頂欄撳唔到：
      // index.html 係 viewport-fit=cover，一定要配 env(safe-area-inset-top) padding，
      // 內容高度維持 60/72px，外加安全區，內容自然喺安全區之下置中
      className="sticky top-0 z-50 h-[calc(60px+env(safe-area-inset-top))] md:h-[calc(72px+env(safe-area-inset-top))] border-b"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderColor: 'var(--glass-border)',
      }}
    >
      <div className="mx-auto flex h-full max-w-[1280px] items-center justify-between px-5 md:px-8 xl:px-12">
        {/* 左：動態 Logo（v2.2.33 老闆指令：logo 喺左上角，小 Gloria 推 logo→推唔郁→雙手揮手，循環播） */}
        <AnimatedLogo />

        {/* 中：連結（desktop）——v2.2.13 老闆指令：主連結瘦身成四條＋「更多」dropdown，唔再摺行 */}
        <nav className="hidden items-center gap-5 md:flex lg:gap-8" aria-label="主導航">
          {MAIN_LINKS.map((link) =>
            link.to === '/products' ? (
              // 2026-08-07 Glo 要求：「商品」hover／鍵盤 focus 展開分類 dropdown
              <div key={link.to} className="group relative">
                <NavLink
                  to={link.to}
                  className={({ isActive }) =>
                    cn('nav-link inline-flex items-center gap-1', isActive && 'active')
                  }
                >
                  {link.label}
                  <ChevronDown
                    size={13}
                    strokeWidth={2.5}
                    aria-hidden="true"
                    className="transition-transform duration-200 group-hover:rotate-180"
                  />
                </NavLink>
                {/* pt-2 做橋位：mouse 由選單移落 dropdown 唔會閃走；group-focus-within 照顧鍵盤 Tab */}
                <div className="invisible absolute left-1/2 top-full -translate-x-1/2 translate-y-1 pt-2 opacity-0 transition-all duration-150 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100">
                  <div
                    className="min-w-[180px] rounded-2xl border px-1.5 py-2"
                    style={{
                      borderColor: 'var(--glass-border)',
                      background: 'var(--space-1)',
                      boxShadow: '0 14px 36px rgba(0, 0, 0, 0.35)',
                    }}
                  >
                    <Link
                      to="/products"
                      className={cn(
                        'block rounded-xl px-3.5 py-2 text-[13px] font-bold tracking-wide transition-colors hover:bg-space-3',
                        pathname === '/products' && !currentCat ? 'text-pink-soft' : 'text-txt-2',
                      )}
                    >
                      全部商品
                    </Link>
                    {PRODUCT_CATEGORIES.map((c) => (
                      <Link
                        key={c.value}
                        to={`/products?category=${c.value}`}
                        className={cn(
                          'block rounded-xl px-3.5 py-2 text-[13px] font-bold tracking-wide transition-colors hover:bg-space-3',
                          pathname === '/products' && currentCat === c.value
                            ? 'text-pink-soft'
                            : 'text-txt-2',
                        )}
                      >
                        {c.label}
                      </Link>
                    ))}
                    {/* 📺 直播場次（v2.2.13 老闆指令）：年-月 → 日期 → 場次，一個月30日唔會排晒出嚟；有場次貨先顯示 */}
                    {liveMonths.length > 0 && (
                      <>
                        <div className="mx-2 my-1.5 border-t" style={{ borderColor: 'var(--space-line)' }} />
                        <p className="px-3.5 pb-0.5 pt-1 text-[11px] font-bold tracking-[0.18em] text-txt-3">
                          📺 直播場次
                        </p>
                        {liveMonths.map((m) => (
                          <div key={m.key}>
                            <button
                              type="button"
                              onClick={() => setLiveMonthOpen((v) => (v === m.key ? null : m.key))}
                              aria-expanded={liveMonthOpen === m.key}
                              className="flex w-full items-center justify-between rounded-xl px-3.5 py-2 text-left text-[13px] font-bold tracking-wide text-txt-2 transition-colors hover:bg-space-3"
                            >
                              {m.label}
                              <span className="flex items-center gap-1.5">
                                <span className="font-mono text-[10px] font-medium text-txt-disabled">
                                  {m.sessionCount}場
                                </span>
                                <ChevronDown
                                  size={12}
                                  strokeWidth={2.5}
                                  aria-hidden="true"
                                  className="transition-transform duration-200"
                                  style={{ transform: liveMonthOpen === m.key ? 'rotate(180deg)' : 'none' }}
                                />
                              </span>
                            </button>
                            {liveMonthOpen === m.key &&
                              m.days.map((g) => (
                                <div
                                  key={g.liveDate}
                                  className="flex flex-wrap items-center gap-x-2 gap-y-1.5 py-1.5 pl-6 pr-2"
                                >
                                  <span className="w-11 shrink-0 font-mono text-[11px] font-bold" style={{ color: 'var(--gold)' }}>
                                    {Number(g.liveDate.slice(6, 8))}日
                                  </span>
                                  {g.sessions.map((s) => {
                                    const active =
                                      pathname === '/products' &&
                                      currentLiveDate === g.liveDate &&
                                      currentLiveSession === s;
                                    return (
                                      <Link
                                        key={s}
                                        to={`/products?liveDate=${g.liveDate}&liveSession=${encodeURIComponent(s)}`}
                                        className={cn(
                                          'rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-bold transition-colors',
                                          active ? 'text-pink-soft' : 'text-txt-2 hover:text-txt-1',
                                        )}
                                        style={{ borderColor: active ? 'var(--pink)' : 'var(--glass-border)' }}
                                      >
                                        第{s}場
                                      </Link>
                                    );
                                  })}
                                </div>
                              ))}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.to === '/'}
                className={({ isActive }) => cn('nav-link', isActive && 'active')}
              >
                {link.label}
              </NavLink>
            ),
          )}
          {/* v2.2.13（老闆指令）：次級資訊收埋做「更多」hover dropdown——順豐站點查詢／VIP會員制度／關於我們 */}
          <div className="group relative">
            <button
              type="button"
              aria-haspopup="true"
              className={cn(
                'nav-link inline-flex items-center gap-1',
                INFO_LINKS.some((l) => l.to === pathname) && 'active',
              )}
            >
              更多
              <ChevronDown
                size={13}
                strokeWidth={2.5}
                aria-hidden="true"
                className="transition-transform duration-200 group-hover:rotate-180"
              />
            </button>
            {/* pt-2 做橋位：mouse 由選單移落 dropdown 唔會閃走；group-focus-within 照顧鍵盤 Tab */}
            <div className="invisible absolute right-0 top-full translate-y-1 pt-2 opacity-0 transition-all duration-150 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100">
              <div
                className="min-w-[180px] rounded-2xl border px-1.5 py-2"
                style={{
                  borderColor: 'var(--glass-border)',
                  background: 'var(--space-1)',
                  boxShadow: '0 14px 36px rgba(0, 0, 0, 0.35)',
                }}
              >
                {INFO_LINKS.map((l) => (
                  <NavLink
                    key={l.to}
                    to={l.to}
                    className={({ isActive }) =>
                      cn(
                        'block rounded-xl px-3.5 py-2 text-[13px] font-bold tracking-wide transition-colors hover:bg-space-3',
                        isActive ? 'text-pink-soft' : 'text-txt-2',
                      )
                    }
                  >
                    {l.label}
                  </NavLink>
                ))}
              </div>
            </div>
          </div>
        </nav>

        {/* 右：Messenger → WhatsApp → 願望清單 → 購物車 → 會員 */}
        <div className="flex items-center gap-2 md:gap-4">
          {/* Messenger 鈕（2026-08-06 Glo 要求）：icon-only，一撳直開專頁對話 */}
          <a
            href={MESSENGER_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-messenger !px-3 !py-2 text-sm"
            aria-label="Facebook Messenger 聯絡我們"
          >
            <MessengerIcon size={16} />
          </a>

          {/* WhatsApp 玻璃鈕（品牌命脈，手機都唔收埋） */}
          <a
            href={WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-whatsapp !px-4 !py-2 text-sm md:!px-5"
            aria-label="WhatsApp 聯絡我們"
          >
            <MessageCircle size={16} aria-hidden="true" />
            <span className="hidden sm:inline">WhatsApp</span>
          </a>

          {/* 願望清單心心 */}
          <Link
            to="/account"
            className="hidden min-h-11 min-w-11 items-center justify-center rounded-full text-txt-2 transition-colors hover:text-pink-soft md:flex"
            aria-label="願望清單"
          >
            <Heart size={20} aria-hidden="true" />
          </Link>

          {/* 購物車 + 數字 badge */}
          <Link
            to="/cart"
            className="relative flex min-h-11 min-w-11 items-center justify-center rounded-full text-txt-2 transition-colors hover:text-txt-1"
            aria-label="購物車"
          >
            <ShoppingBag size={20} aria-hidden="true" />
            {cartCount > 0 && (
              <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-pink px-1 font-mono text-[10px] font-medium text-space-1">
                <span className="sr-only">購物車有 </span>
                {cartCount}
                <span className="sr-only"> 件商品</span>
              </span>
            )}
          </Link>

          {/* AUTH-SLOT: 已接 useAuth（自訂電話+密碼登入） */}
          {user ? (
            <span className="hidden items-center gap-3 md:flex">
              {isStaff && (
                <Link to="/admin" className="nav-link" style={{ color: 'var(--gold)' }}>
                  後台管理
                </Link>
              )}
              <Link to="/account" className="nav-link">
                {user.name}
              </Link>
              {/* VIP 級別 chip（v2.2.0 統一 vipTheme chipClass；NONE 低調唔出）：撳落去 /vip 會員制度介紹頁 */}
              {vipTier && vipTheme.isVip && (
                <Link to="/vip" aria-label={`會員級別：${vipTheme.label}，了解會員制度`}>
                  <span className={vipTheme.chipClass}>
                    {vipTheme.seal} {vipTheme.shortLabel}
                  </span>
                </Link>
              )}
              <button
                type="button"
                onClick={logout}
                className="text-[13px] text-txt-3 transition-colors hover:text-pink-soft"
              >
                登出
              </button>
            </span>
          ) : (
            <Link to="/login" className="nav-link hidden md:inline">
              會員登入
            </Link>
          )}

          {/* 手機 hamburger */}
          <button
            type="button"
            className="flex min-h-11 min-w-11 items-center justify-center text-txt-1 md:hidden"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? '關閉選單' : '開啟選單'}
          >
            {menuOpen ? <X size={24} aria-hidden="true" /> : <Menu size={24} aria-hidden="true" />}
          </button>
        </div>
      </div>

      {/* 手機全屏玻璃 overlay 選單 —— 用 createPortal 掛去 document.body，
          因為 header 有 backdrop-filter，會令入面嘅 fixed 元素變成相對 header 定位，
          選單會塌落得幾十 px 高兼透出內容變重疊 */}
      {menuOpen &&
        createPortal(
          <nav
            className="flex flex-col gap-2 overflow-y-auto px-8 pb-10 pt-4 md:hidden"
            style={{
              position: 'fixed',
              // v2.2.13：頂欄加咗 safe-area padding，drawer 頂要跟住避開 iPhone 狀態列
              top: 'calc(60px + env(safe-area-inset-top))',
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 100,
              // 近乎實色底：部分手機瀏覽器唔支援 backdrop-filter，
              // 淨用玻璃色會透出內容變重疊，所以用 97% 實色底 + blur 做漸進增強
              background: 'rgba(10, 6, 20, 0.97)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
            }}
            aria-label="手機導航"
          >
          {/* 2026-08-04 Glo 要求：選項上方放個人化時段問候（已登入先顯示） */}
          {user && (
            <p
              className="border-b pb-4 pt-2 font-serif-tc text-xl font-semibold"
              style={{
                borderColor: 'var(--space-line)',
                color: 'var(--gold)',
                animation: 'mobile-nav-in 400ms var(--ease-expo) 0ms both',
              }}
            >
              {user.name}寶寶，{greetingNow()}💕！
            </p>
          )}
          {/* VIP 級別 chip（v2.2.0 vipTheme；NONE 唔出）：手機選單問候下面顯示，撳落去 /vip 介紹頁。
              v2.2.12（老闆指令）：「了解會員制度 →」文字連結刪走——會員制度已經搬咗落目錄選項 */}
          {user && vipTier && vipTheme.isVip && (
            <div
              className="border-b pb-4 pt-3"
              style={{
                borderColor: 'var(--space-line)',
                animation: 'mobile-nav-in 400ms var(--ease-expo) 25ms both',
              }}
            >
              <Link
                to="/vip"
                onClick={() => setMenuOpen(false)}
                className="inline-flex items-center gap-2"
                aria-label={`會員級別：${vipTheme.label}`}
              >
                <span className={vipTheme.chipClass}>
                  {vipTheme.seal} {vipTheme.shortLabel}
                </span>
              </Link>
            </div>
          )}
          {/* v2.2.13（老闆指令）：drawer 重新排順序＋高度美化——
              購物核心（商品/直播/我的訂單/購物車）→ 會員中心 → 更多資訊（順豐→VIP→關於）→ 後台管理。
              每行金色 mono 序號；當前頁 ✦ 標記；分組之間用金線小標隔開。 */}
          {mobileMainLinks.map((link, i) => {
            const index = i + 1;
            const delayMs = i * 45;
            const active = link.to === '/' ? pathname === '/' : pathname.startsWith(link.to);
            if (link.to === '/products') {
              // 2026-08-07 Glo 要求：手機選單「商品」撳箭嘴展開商品分類子列表
              return (
                <div
                  key={link.to}
                  className="border-b"
                  style={{
                    borderColor: 'var(--space-line)',
                    animation: `mobile-nav-in 400ms var(--ease-expo) ${delayMs}ms both`,
                  }}
                >
                  <div className="flex items-center justify-between">
                    <NavLink
                      to={link.to}
                      onClick={() => setMenuOpen(false)}
                      className="flex flex-1 items-baseline gap-4 py-4"
                    >
                      <span
                        aria-hidden="true"
                        className="font-mono text-[11px] font-medium tracking-[0.2em]"
                        style={{ color: 'rgba(245,197,24,0.45)' }}
                      >
                        {String(index).padStart(2, '0')}
                      </span>
                      <span
                        className={cn(
                          'font-serif-tc text-2xl font-semibold',
                          active ? 'text-pink-soft' : 'text-txt-1',
                        )}
                      >
                        {link.label}
                      </span>
                      {active && (
                        <span aria-hidden="true" className="ml-auto text-sm text-pink-soft">
                          ✦
                        </span>
                      )}
                    </NavLink>
                    <button
                      type="button"
                      aria-label={shopExpanded ? '收起商品分類' : '展開商品分類'}
                      aria-expanded={shopExpanded}
                      onClick={() => setShopExpanded((v) => !v)}
                      className="flex min-h-11 min-w-11 items-center justify-center text-txt-2"
                    >
                      <ChevronDown
                        size={22}
                        strokeWidth={2.5}
                        aria-hidden="true"
                        className="transition-transform duration-200"
                        style={{ transform: shopExpanded ? 'rotate(180deg)' : 'none' }}
                      />
                    </button>
                  </div>
                  {shopExpanded && (
                    <div
                      className="mb-3 ml-3 flex flex-col border-l-2 pl-5"
                      style={{ borderColor: 'rgba(245,197,24,0.22)' }}
                    >
                      <Link
                        to="/products"
                        onClick={() => setMenuOpen(false)}
                        className={cn(
                          'py-2 text-lg font-extrabold tracking-wide',
                          pathname === '/products' && !currentCat && !currentLiveDate ? 'text-pink-soft' : 'text-txt-2',
                        )}
                      >
                        全部商品
                      </Link>
                      {PRODUCT_CATEGORIES.map((c) => (
                        <Link
                          key={c.value}
                          to={`/products?category=${c.value}`}
                          onClick={() => setMenuOpen(false)}
                          className={cn(
                            'py-2 text-lg font-extrabold tracking-wide',
                            pathname === '/products' && currentCat === c.value
                              ? 'text-pink-soft'
                              : 'text-txt-2',
                          )}
                        >
                          {c.label}
                        </Link>
                      ))}
                      {/* 📺 直播場次（v2.2.13 老闆指令）：年-月 → 日期 → 場次，一個月30日唔會排晒出嚟；預設開最新月 */}
                      {liveMonths.length > 0 && (
                        <>
                          <p className="flex items-center gap-3 pb-1 pt-3">
                            <span
                              aria-hidden="true"
                              className="h-px w-6"
                              style={{ background: 'linear-gradient(90deg, var(--gold), transparent)' }}
                            />
                            <span className="text-sm font-bold tracking-[0.18em] text-txt-3">📺 直播場次</span>
                          </p>
                          {liveMonths.map((m) => (
                            <div key={m.key}>
                              <button
                                type="button"
                                onClick={() => setLiveMonthOpen((v) => (v === m.key ? null : m.key))}
                                aria-expanded={liveMonthOpen === m.key}
                                className="flex w-full items-center justify-between py-2 text-lg font-extrabold tracking-wide text-txt-2"
                              >
                                {m.label}
                                <span className="flex items-center gap-2">
                                  <span className="font-mono text-[11px] font-medium text-txt-disabled">
                                    {m.sessionCount}場
                                  </span>
                                  <ChevronDown
                                    size={18}
                                    strokeWidth={2.5}
                                    aria-hidden="true"
                                    className="transition-transform duration-200"
                                    style={{ transform: liveMonthOpen === m.key ? 'rotate(180deg)' : 'none' }}
                                  />
                                </span>
                              </button>
                              {liveMonthOpen === m.key && (
                                <div
                                  className="mb-2 ml-1 flex flex-col border-l pl-4"
                                  style={{ borderColor: 'rgba(245,197,24,0.16)' }}
                                >
                                  {m.days.map((g) => (
                                    <div key={g.liveDate} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-1.5">
                                      <span
                                        className="w-10 shrink-0 font-mono text-[13px] font-bold"
                                        style={{ color: 'var(--gold)' }}
                                      >
                                        {Number(g.liveDate.slice(6, 8))}日
                                      </span>
                                      {g.sessions.map((s) => {
                                        const activeChip =
                                          pathname === '/products' &&
                                          currentLiveDate === g.liveDate &&
                                          currentLiveSession === s;
                                        return (
                                          <Link
                                            key={s}
                                            to={`/products?liveDate=${g.liveDate}&liveSession=${encodeURIComponent(s)}`}
                                            onClick={() => setMenuOpen(false)}
                                            className={cn(
                                              'rounded-full border px-3.5 py-1.5 font-mono text-[13px] font-bold transition-colors',
                                              activeChip ? 'text-pink-soft' : 'text-txt-2 hover:text-txt-1',
                                            )}
                                            style={{ borderColor: activeChip ? 'var(--pink)' : 'var(--glass-border)' }}
                                          >
                                            第{s}場
                                          </Link>
                                        );
                                      })}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <DrawerRow
                key={link.to}
                to={link.to}
                label={link.label}
                index={index}
                active={active}
                delayMs={delayMs}
                onNavigate={() => setMenuOpen(false)}
              />
            );
          })}
          {/* 更多資訊（老闆指定順序：順豐站點查詢 → VIP會員制度 → 關於我們，擺會員中心下面） */}
          <p
            className="flex items-center gap-3 pb-1 pt-6"
            style={{ animation: `mobile-nav-in 400ms var(--ease-expo) ${mobileMainLinks.length * 45}ms both` }}
          >
            <span
              aria-hidden="true"
              className="h-px w-7"
              style={{ background: 'linear-gradient(90deg, var(--gold), transparent)' }}
            />
            <span className="font-mono text-[10px] font-bold tracking-[0.32em] text-txt-3">更多資訊 MORE</span>
          </p>
          {INFO_LINKS.map((link, j) => {
            const index = mobileMainLinks.length + j + 1;
            return (
              <DrawerRow
                key={link.to}
                to={link.to}
                label={link.label}
                index={index}
                active={pathname.startsWith(link.to)}
                delayMs={(index - 1) * 45}
                onNavigate={() => setMenuOpen(false)}
              />
            );
          })}
          {isStaff && (
            <DrawerRow
              to="/admin"
              label="後台管理"
              index={mobileMainLinks.length + INFO_LINKS.length + 1}
              active={pathname.startsWith('/admin')}
              gold
              delayMs={(mobileMainLinks.length + INFO_LINKS.length) * 45}
              onNavigate={() => setMenuOpen(false)}
            />
          )}
          {/* 2026-08-04 Glo 要求：手機選單加登出（desktop 頂欄一早有，呢度補返） */}
          {user && (
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                logout();
              }}
              className="border-b py-4 text-left font-serif-tc text-2xl font-semibold text-txt-3"
              style={{
                borderColor: 'var(--space-line)',
                animation: `mobile-nav-in 400ms var(--ease-expo) ${(mobileMainLinks.length + INFO_LINKS.length + (isStaff ? 1 : 0)) * 45}ms both`,
              }}
            >
              登出
            </button>
          )}
            <style>{`@keyframes mobile-nav-in { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }`}</style>
          </nav>,
          document.body,
        )}
    </header>
  );
}
