import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink } from 'react-router';
import { Menu, MessageCircle, ShoppingCart, X } from 'lucide-react';
import { useCart } from '@/hooks/useCart';
import { useAuth } from '@/hooks/useAuth';

/**
 * 全站頂欄（design-system.md §P1 + react-dev.md Navbar positioning contract）
 * - sticky top-0 z-50 放喺 normal flow；頁面唔使自己補 nav 高度
 * - 高 60px（md 72px）＝ --nav-h；logo 左、導航中、icon 右
 * - 右上角：員工內部系統連結（md 起顯示）＋ WhatsApp 按鈕＋購物車 badge
 * - 手機：漢堡掣開全屏玻璃 overlay 選單（createPortal 掛 body，見下面註解）
 */

// TODO: 換返 RedCode 真 WhatsApp 號碼
const WHATSAPP_URL = 'https://wa.me/85254835368';
// 員工內部系統（Render 託管）
const STAFF_URL = 'https://red-code-wms.onrender.com/';

const NAV_LINKS = [
  { to: '/', label: '首頁' },
  { to: '/products', label: '商品' },
  { to: '/live', label: '直播' },
  { to: '/about', label: '關於我們' },
];

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { totalCount } = useCart();
  const { user } = useAuth();

  return (
    <header
      className="sticky top-0 z-50"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderBottom: '1px solid var(--glass-border)',
      }}
    >
      <nav className="mx-auto flex h-[60px] max-w-[1280px] items-center justify-between gap-4 px-5 md:h-[72px] md:px-8 xl:px-12">
        {/* 左：logo */}
        <Link to="/" aria-label="RedCode 首頁" className="shrink-0">
          <img src="/logo.png" alt="RedCode Fashion Design" className="h-10 w-auto md:h-14" />
        </Link>

        {/* 中：桌機導航（hover 無底線；粉紅底線只喺當前頁出現） */}
        <div className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === '/'}
              className="relative py-1 text-[15px] font-medium text-txt-2 transition-colors hover:text-pink-tint"
              style={({ isActive }) =>
                isActive
                  ? {
                      color: 'var(--pink-tint)',
                      borderBottom: '1px solid var(--pink)',
                      paddingBottom: '3px',
                    }
                  : undefined
              }
            >
              {link.label}
            </NavLink>
          ))}
          {user?.role === 'admin' || user?.role === 'staff' ? (
            <NavLink
              to="/admin"
              className="relative py-1 text-[15px] font-medium text-gold transition-colors hover:text-gold"
              style={({ isActive }) =>
                isActive
                  ? {
                      borderBottom: '1px solid var(--gold)',
                      paddingBottom: '3px',
                    }
                  : undefined
              }
            >
              員工後台
            </NavLink>
          ) : null}
        </div>

        {/* 右：員工內部系統＋WhatsApp 按鈕＋購物車 badge＋手機漢堡 */}
        <div className="flex items-center gap-3 md:gap-4">
          <a
            href={STAFF_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden font-mono text-xs tracking-wider text-txt-3 transition-colors hover:text-gold md:inline"
          >
            員工內部系統
          </a>
          <a
            href={WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="WhatsApp 聯絡我哋"
            className="btn btn-whatsapp !px-4 !py-2 text-sm"
          >
            <MessageCircle size={16} aria-hidden="true" />
            <span className="hidden lg:inline">WhatsApp</span>
          </a>
          <Link
            to="/cart"
            aria-label="購物車"
            className="relative flex h-9 w-9 items-center justify-center rounded-full text-txt-2 transition-colors hover:text-pink-tint"
          >
            <ShoppingCart size={20} aria-hidden="true" />
            {totalCount > 0 && (
              <span
                aria-label={`購物車有 ${totalCount} 件商品`}
                className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 font-mono text-[10px] font-medium text-space-1"
              >
                {totalCount > 99 ? '99+' : totalCount}
              </span>
            )}
          </Link>
          <button
            type="button"
            aria-label={menuOpen ? '關閉選單' : '開啟選單'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-txt-1 transition-colors hover:text-pink-tint md:hidden"
          >
            {menuOpen ? (
              <X size={22} aria-hidden="true" />
            ) : (
              <Menu size={22} aria-hidden="true" />
            )}
          </button>
        </div>
      </nav>

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
            {NAV_LINKS.map((link, i) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.to === '/'}
                onClick={() => setMenuOpen(false)}
                className="border-b py-5 font-serif-tc text-2xl font-semibold text-txt-1 transition-colors hover:text-pink-tint"
                style={({ isActive }) => ({
                  borderColor: 'var(--space-line)',
                  color: isActive ? 'var(--pink-tint)' : undefined,
                  animation: `mobile-nav-in 600ms var(--ease-expo) both`,
                  animationDelay: `${i * 60}ms`,
                })}
              >
                {link.label}
              </NavLink>
            ))}
            <NavLink
              to="/cart"
              onClick={() => setMenuOpen(false)}
              className="border-b py-5 font-serif-tc text-2xl font-semibold text-txt-1 transition-colors hover:text-pink-tint"
              style={({ isActive }) => ({
                borderColor: 'var(--space-line)',
                color: isActive ? 'var(--pink-tint)' : undefined,
                animation: 'mobile-nav-in 600ms var(--ease-expo) both',
                animationDelay: `${NAV_LINKS.length * 60}ms`,
              })}
            >
              購物車
            </NavLink>
            {user?.role === 'admin' || user?.role === 'staff' ? (
              <NavLink
                to="/admin"
                onClick={() => setMenuOpen(false)}
                className="border-b py-5 font-serif-tc text-2xl font-semibold text-gold"
                style={{
                  borderColor: 'var(--space-line)',
                  animation: 'mobile-nav-in 600ms var(--ease-expo) both',
                  animationDelay: `${(NAV_LINKS.length + 1) * 60}ms`,
                }}
              >
                員工後台
              </NavLink>
            ) : null}
            <a
              href={STAFF_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 font-mono text-sm tracking-wider text-txt-3 transition-colors hover:text-gold"
            >
              員工內部系統 →
            </a>
            <style>{`@keyframes mobile-nav-in { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }`}</style>
          </nav>,
          document.body,
        )}
    </header>
  );
}
