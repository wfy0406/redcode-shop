import { Link } from 'react-router';
import { Facebook, Mail, MessageCircle } from 'lucide-react';

/**
 * 頁尾（§5 全頁共用）：--space-0 底 + 花體 slogan + FB/E-Mail/WhatsApp 連結 + 員工入口
 * 公司名：RedCode HK Limited
 * 2026-08-04（Glo 要求）：「搵我哋」刪走 Instagram（即將推出），加 E-Mail 服務支援
 */

// TODO: 換返 RedCode 真 WhatsApp 號碼
const WHATSAPP_URL = 'https://wa.me/85254835368';
const FACEBOOK_URL = 'https://www.facebook.com/redcodexhk';
const SUPPORT_EMAIL = 'service.support@ows.redcode.red';

export default function Footer() {
  return (
    <footer className="relative z-10 mt-24 border-t bg-space-0" style={{ borderColor: 'var(--space-line)' }}>
      <div className="mx-auto max-w-[1280px] px-5 py-16 md:px-8 xl:px-12">
        <div className="grid gap-12 md:grid-cols-[1.4fr_1fr_1fr]">
          {/* 品牌欄 */}
          <div>
            <img src="/logo.png" alt="RedCode Fashion Design" className="h-12 w-auto" />
            <p className="script mt-4 text-2xl">Every order is a little wish come true ✦</p>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-txt-3">
              香港女裝直播品牌，主播 Glo Glo 每晚喺 Facebook 直播同你揀衫。
              睇啱就落單，有咩唔明 WhatsApp 搵我哋。
            </p>
          </div>

          {/* 網站連結 */}
          <nav aria-label="頁尾導航">
            <h2 className="font-serif-tc text-lg font-semibold text-txt-1">網站</h2>
            <ul className="mt-4 space-y-3 text-sm">
              <li><Link to="/products" className="text-txt-2 transition-colors hover:text-pink-soft">全部商品</Link></li>
              <li><Link to="/live" className="text-txt-2 transition-colors hover:text-pink-soft">直播專區</Link></li>
              <li><Link to="/about" className="text-txt-2 transition-colors hover:text-pink-soft">關於我們</Link></li>
              <li><Link to="/account" className="text-txt-2 transition-colors hover:text-pink-soft">會員中心</Link></li>
            </ul>
          </nav>

          {/* 聯絡 */}
          <div>
            <h2 className="font-serif-tc text-lg font-semibold text-txt-1">搵我哋</h2>
            <ul className="mt-4 space-y-3 text-sm">
              <li>
                <a
                  href={WHATSAPP_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-txt-2 transition-colors hover:text-success"
                >
                  <MessageCircle size={16} aria-hidden="true" /> WhatsApp 落單查詢
                </a>
              </li>
              <li>
                <a
                  href={FACEBOOK_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-txt-2 transition-colors hover:text-pink-soft"
                >
                  <Facebook size={16} aria-hidden="true" /> Facebook 直播專頁
                </a>
              </li>
              <li>
                <a
                  href={`mailto:${SUPPORT_EMAIL}`}
                  className="inline-flex items-center gap-2 text-txt-2 transition-colors hover:text-gold"
                >
                  <Mail size={16} aria-hidden="true" /> E-Mail 服務支援
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div
          className="mt-12 flex flex-col items-start justify-between gap-4 border-t pt-6 text-[13px] text-txt-3 md:flex-row md:items-center"
          style={{ borderColor: 'var(--space-line)' }}
        >
          <p>© {new Date().getFullYear()} RedCode HK Limited. All rights reserved.</p>
          {/* 員工入口（低調，連去 Render 倉庫系統） */}
          <a
            href="https://red-code-wms.onrender.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 transition-colors hover:text-lavender"
          >
            <span className="inline-block h-1.5 w-1.5 bg-gold" aria-hidden="true" />
            員工內部系統
          </a>
        </div>
      </div>
    </footer>
  );
}
