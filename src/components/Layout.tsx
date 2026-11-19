import { useEffect } from 'react';
import { Outlet, useLocation, useNavigationType } from 'react-router';
import { MessageCircle } from 'lucide-react';
import Starfield from '@/components/Starfield';
import Meteors from '@/components/Meteors';
import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import MessengerIcon from '@/components/MessengerIcon';
import MarketingConsentModal from '@/components/MarketingConsentModal';
import PrizeWinModal from '@/components/PrizeWinModal';
import InstallBanner from '@/components/InstallBanner';
import GlobalFairyGuide from '@/components/GlobalFairyGuide';
import {
  clearProductReturn,
  readProductReturn,
  resolveScrollIntent,
} from '@/lib/productReturn';

/**
 * 全站 Layout —— Nested-route pattern（react-dev.md Pattern B）：
 * Layout render <Outlet/>，App.tsx 用巢狀 <Route>。
 *
 * 包含：星野 canvas（單實例）+ 星雲層（§3.3）+ 玻璃導航 + 頁尾 + 右下 WhatsApp 浮鈕（§3.6/§5）
 * 2026-08-06（Glo 要求）：WhatsApp 浮鈕上面加 Messenger 浮鈕，一撳直開 m.me 對話。
 * 2026-08-06：mount 推廣同意一次性彈窗（舊會員未表態逼揀一次）。
 */

// TODO: 換返 RedCode 真 WhatsApp 號碼
const WHATSAPP_URL = 'https://wa.me/85254835368';
// Facebook Messenger 深層連結：撳咗直開 RedCode 專頁對話
const MESSENGER_URL = 'https://m.me/redcodexhk';

export default function Layout() {
  const { pathname, search } = useLocation();
  const navigationType = useNavigationType();
  // 管理員工作台係數據密集頁：唔要星空/流星/星雲動效（用戶要求全站有、唯獨 admin 冇）
  const isAdmin = pathname.startsWith('/admin');
  // /cart /checkout /guest-checkout /guest-payment 手機版有底部 sticky 結帳欄：WA 浮鈕抬高唔好騎住佢
  const hasBottomBar =
    pathname === '/cart' || pathname === '/checkout' || pathname === '/guest-checkout' || pathname === '/guest-payment';

  // SPA 路由轉換捲動（U01，單一決策點 resolveScrollIntent）：
  // - PUSH/REPLACE（正常撳連結轉頁）→ 照舊捲返頁頂；
  // - POP（自製返回掣／原生 browser/OS back）＋ sessionStorage 來源記錄 URL 對得上
  //   → 等來源頁商品卡渲染好（真資料＋固定比例圖框），先 restore 原本 scrollY
  //   兼 focus 返嗰張卡（preventScroll，唔會搶走啱啱 restore 嘅位置）；
  // - POP 但冇記錄／URL 唔對 → 交俾瀏覽器原生 scroll restoration，
  //   唔准好似舊版咁硬 scrollTo(0) 搶走返頁位置。
  useEffect(() => {
    const entry = readProductReturn();
    const intent = resolveScrollIntent(navigationType, entry, pathname, search);
    if (intent === 'top') {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
      return;
    }
    if (intent !== 'restore-product' || !entry) return;

    const POLL_MS = 120;
    const TIMEOUT_MS = 2500;
    let elapsed = 0;
    let stopped = false;
    let timer = 0;
    let stableTicks = 0;
    let focused = false;

    // 收斂式 restore：瀏覽器原生 POP scroll restoration／圖片字型載入可能喺我哋
    // restore 之後先落地，所以唔係「set 一次就算」——每拍檢查，未到位就重設；
    // scroll 連續兩拍企穩而且卡已出現，先 focus（preventScroll）兼收手，
    // 唔會長期霸住用戶捲動。搵唔到卡都至少保住 scroll 位置，timeout 收手。
    const tick = () => {
      if (stopped) return;
      const card = document.querySelector<HTMLElement>(`[data-product-card="${entry.productId}"]`);
      if (Math.abs(window.scrollY - entry.scrollY) > 1) {
        window.scrollTo({ top: entry.scrollY, left: 0, behavior: 'instant' as ScrollBehavior });
        stableTicks = 0;
      } else {
        stableTicks += 1;
      }
      if (card && !focused) {
        try {
          card.focus({ preventScroll: true });
        } catch {
          /* 舊瀏覽器 focus 失敗唔阻：scroll 經已 restore 咗 */
        }
        focused = true;
      }
      if (card && stableTicks >= 2) {
        clearProductReturn();
        return;
      }
      elapsed += POLL_MS;
      if (elapsed >= TIMEOUT_MS) {
        window.scrollTo({ top: entry.scrollY, left: 0, behavior: 'instant' as ScrollBehavior });
        clearProductReturn();
        return;
      }
      timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, 60);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [pathname, search, navigationType]);

  return (
    <div className="relative min-h-[100dvh] bg-space-1 text-txt-1">
      {/* 無障礙 skip link（2026-10）：鍵盤/讀屏用戶一 Tab 直達主要內容，平時 visually-hidden */}
      <a
        href="#main-content"
        className="sr-only z-[100] rounded-lg bg-gold px-5 py-3 text-base font-bold text-space-1 focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        跳到主要內容
      </a>

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

      <main id="main-content" className="relative z-10">
        <Outlet />
      </main>

      <Footer />

      {/* Messenger 浮鈕（2026-08-06 Glo 要求）：同 WhatsApp 一樣一撳直開對話，排喺佢上面 */}
      <a
        href={MESSENGER_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={`btn btn-messenger fixed right-6 z-50 !h-14 !w-14 !rounded-full !p-0 ${
          hasBottomBar ? 'bottom-40' : 'bottom-[5.5rem]'
        }`}
        aria-label="Facebook Messenger 聯絡 Glo Glo 團隊"
      >
        <MessengerIcon size={24} />
      </a>

      {/* §3.6/§5 右下 WhatsApp 浮鈕（全站最重要轉化鈕） */}
      <a
        href={WHATSAPP_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={`btn btn-whatsapp fixed right-6 z-50 !h-14 !w-14 !rounded-full !p-0 ${
          hasBottomBar ? 'bottom-24' : 'bottom-6'
        }`}
        aria-label="WhatsApp 聯絡 Glo Glo 團隊"
      >
        <MessageCircle size={24} aria-hidden="true" />
      </a>

      {/* PWA 安裝提示（2026-10）：原位可收起 banner，唔係彈窗；已安裝／14日內揀過「暫時唔使」唔顯示 */}
      <InstallBanner />

      {/* 推廣同意一次性彈窗（2026-08-06 Glo 要求）：舊會員未表態先會彈，揀完唔再彈 */}
      <MarketingConsentModal />
      {/* v2.2.46（直播抽獎）：中獎賀卡全域彈窗——首次登入／已登入一見有 pending 中獎就彈
          （煙花＋小精靈 Glo Glo 飛入；揀「請寄送」揀順豐站點 → 0 元訂單飛 WMS） */}
      <PrizeWinModal />

      {/* 全域小精靈導覽（2026-10-26）：全站唯一實例，唔准再喺其他頁各自掛。
          組件內部用 useLocation 判路由：/admin* 自動回避（跟全站動效慣例），
          /try-on 五步帶路、/ 首頁帶去 AI 試穿 CTA、其他頁通用幫助。 */}
      <GlobalFairyGuide />
    </div>
  );
}
