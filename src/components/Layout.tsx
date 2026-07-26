import { Outlet, useLocation } from 'react-router';
import { MessageCircle } from 'lucide-react';
import Starfield from '@/components/Starfield';
import Meteors from '@/components/Meteors';
import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';

/**
 * 全站 Layout —— Nested-route pattern（react-dev.md Pattern B）：
 * Layout render <Outlet/>，App.tsx 用巢狀 <Route>。
 *
 * 包含：星野 canvas（單實例）+ 星雲層（§3.3）+ 玻璃導航 + 頁尾 + 右下 WhatsApp 浮鈕（§3.6/§5）
 */

// TODO: 換返 RedCode 真 WhatsApp 號碼
const WHATSAPP_URL = 'https://wa.me/85254835368';

export default function Layout() {
  const { pathname } = useLocation();
  // 管理員工作台係數據密集頁：唔要星空/流星/星雲動效（用戶要求全站有、唯獨 admin 冇）
  const isAdmin = pathname.startsWith('/admin');

  return (
    <div className="relative min-h-[100dvh] bg-space-1 text-txt-1">
      {/* §3.2 星空 canvas（fixed, z-index -2） */}
      {!isAdmin && <Starfield />}

      {/* 流星動效層（z-index 0：星空之上、內容之下；reduced-motion 時唔渲染） */}
      {!isAdmin && <Meteors />}

      {/* §3.3 星雲漸變層（z-index -1，星之上內容之下） */}
      {!isAdmin && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 overflow-hidden"
          style={{ zIndex: -1 }}
        >
          <div className="nebula nebula-1" style={{ filter: 'blur(80px)' }} />
          <div className="nebula nebula-2" style={{ filter: 'blur(80px)' }} />
          <div className="nebula nebula-3" style={{ filter: 'blur(80px)' }} />
        </div>
      )}

      <Navbar />

      <main className="relative z-10">
        <Outlet />
      </main>

      <Footer />

      {/* §3.6/§5 右下 WhatsApp 浮鈕（全站最重要轉化鈕） */}
      <a
        href={WHATSAPP_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-whatsapp fixed bottom-6 right-6 z-50 !h-14 !w-14 !rounded-full !p-0"
        aria-label="WhatsApp 聯絡 Glo Glo 團隊"
      >
        <MessageCircle size={24} aria-hidden="true" />
      </a>
    </div>
  );
}
