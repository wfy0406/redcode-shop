import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink } from 'react-router';
import { Heart, Menu, MessageCircle, ShoppingBag, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { trpc } from '@/providers/trpc';
import type { CartLine } from '@/components/cart/types';
import MessengerIcon from '@/components/MessengerIcon';

/**
 * RedCode 設計系統 §4.2 —— 玻璃導航
 * sticky top-0 z-50（react-dev.md navbar contract：唔用 fixed，Layout 唔使 offset bookkeeping）
 * 高度 72px（手機 60px）、glass-bg + blur 16px、底邊 1px glass-border
 * 2026-08-06（Glo 要求）：WhatsApp 掣左邊加 Messenger 掣，一撳直開 m.me 對話。
 * 2026-08-06（Glo 要求）：刪走選單入面嘅「後台管理」連結（desktop＋手機選單）——
 * 唔俾外部見到員工入口，員工自己記住 /admin 網址直接用。
 */

// TODO: 換返 RedCode 真 WhatsApp 號碼
const WHATSAPP_URL = 'https://wa.me/85254835368';
// Facebook Messenger 深層連結：撳咗直開 RedCode 專頁對話
const MESSENGER_URL = 'https://m.me/redcodexhk';

/** 員工內部系統（倉庫/HR，Render 託管） */
const STAFF_SYSTEM_URL = 'https://red-code-wms.onrender.com/';

/** 時段問候（2026-08-04 Glo 要求；跟客人裝置本地時間）：早晨 05–12／午安 12–18／晚上好 18–05 */
function greetingNow(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return '早晨';
  if (h >= 12 && h < 18) return '午安';
  return '晚上好';
}

const NAV_LINKS = [
  { to: '/', label: '首頁' },
  { to: '/products', label: '商品' },
  { to: '/live', label: '直播' },
  { to: '/about', label: '關於我們' },
  // 2026-07-30：有客人唔識入會員中心搵訂單 → 主選單直接放「我的訂單」；
  // 未登入撳入去會見到「請先登入」提示，登入後自動返訂單頁
  { to: '/orders', label: '我的訂單' },
];

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { user, logout } = useAuth();
  // F4：badge 接通真購物車數量（未登入唔好 call，enabled 守住）
  const cartQuery = trpc.cart.list.useQuery(undefined, {
    enabled: !!user,
    refetchOnWindowFocus: false,
  });
  const cartCount = ((cartQuery.data ?? []) as CartLine[]).reduce(
    (sum, line) => sum + line.quantity,
    0,
  );

  // 手機選單連結（2026-08-04 抽出嚟：問候語＋登出掣嘅動畫 delay 要跟佢長度計）
  const mobileLinks = [
    ...NAV_LINKS,
    { to: '/cart', label: '購物車' },
    user
      ? { to: '/account', label: `會員中心（${user.name}）` }
      : { to: '/login', label: '會員登入' },
  ];

  return (
    <header
      className="sticky top-0 z-50 h-[60px] md:h-[72px] border-b"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderColor: 'var(--glass-border)',
      }}
    >
      <div className="mx-auto flex h-full max-w-[1280px] items-center justify-between px-5 md:px-8 xl:px-12">
        {/* 左：Logo */}
        <Link to="/" aria-label="RedCode Fashion Design 首頁" className="flex shrink-0 items-center">
          <img src="/logo.png" alt="RedCode Fashion Design" className="h-10 w-auto md:h-14" />
        </Link>

        {/* 中：連結（desktop） */}
        <nav className="hidden items-center gap-8 md:flex" aria-label="主導航">
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === '/'}
              className={({ isActive }) => cn('nav-link', isActive && 'active')}
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        {/* 右：Messenger → WhatsApp → 願望清單 → 購物車 → 會員 → 員工內部系統 */}
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
              <Link to="/account" className="nav-link">
                {user.name}
              </Link>
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

          {/* 員工內部系統：最右、低調但搵得到（連去 Render 倉庫系統） */}
          <a
            href={STAFF_SYSTEM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden items-center gap-2 text-[13px] text-txt-3 transition-colors hover:text-lavender lg:flex"
          >
            <span className="inline-block h-1.5 w-1.5 bg-gold" aria-hidden="true" />
            員工內部系統
          </a>

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
              top: 60,
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
          {mobileLinks.map(
            (link, i) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.to === '/'}
                onClick={() => setMenuOpen(false)}
                className="border-b py-4 font-serif-tc text-2xl font-semibold text-txt-1"
                style={{
                  borderColor: 'var(--space-line)',
                  animation: `mobile-nav-in 400ms var(--ease-expo) ${i * 50}ms both`,
                }}
              >
                {link.label}
              </NavLink>
            ),
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
                animation: `mobile-nav-in 400ms var(--ease-expo) ${mobileLinks.length * 50}ms both`,
              }}
            >
              登出
            </button>
          )}
          <a
            href={STAFF_SYSTEM_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setMenuOpen(false)}
            className="mt-6 flex items-center gap-2 text-[13px] text-txt-3"
          >
            <span className="inline-block h-1.5 w-1.5 bg-gold" aria-hidden="true" />
            員工內部系統
          </a>
            <style>{`@keyframes mobile-nav-in { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }`}</style>
          </nav>,
          document.body,
        )}
    </header>
  );
}
