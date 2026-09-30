import { useEffect } from 'react';
import { useLocation } from 'react-router';

/**
 * SEO（v2.2.20）：逐頁 title / description 管理。
 * HashRouter 下全部頁共用同一份 index.html，所以呢度按 pathname 動態改
 * document.title 同 meta[name=description]（客人睇分頁標籤、搜尋結果都會啱）。
 * 鐵律：可見文案（h1、按鈕字）一字唔郁，呢度淨係改 meta 層。
 * `/products/:id` 喺 ProductDetail 載入商品後會再覆寫做商品名，呢度嘅係未載入前嘅過渡版。
 */
export const PAGE_SEO: Record<string, { title: string; description: string }> = {
  '/': {
    title: 'RedCode Fashion Design｜香港女裝直播網店',
    description:
      'RedCode Fashion Design 官方購物網站 — 香港女裝直播，主播 Glo Glo 每晚為你揀選星空下最閃嘅衫。直播專屬優惠、直播重溫、順豐站自取，VIP 會員尊享禮遇。',
  },
  '/products': {
    title: '全部貨品｜RedCode Fashion Design',
    description:
      'RedCode 直播精選女裝全部貨品，直播優惠價發售，順豐站/自提點/智能櫃自取，香港女裝網購。',
  },
  '/live': {
    title: '直播重溫｜RedCode Fashion Design',
    description: '錯過直播唔緊要，RedCode 直播重溫隨時睇，直播優惠繼續生效，睇中即刻落單。',
  },
  '/about': {
    title: '關於我們｜RedCode Fashion Design',
    description:
      'RedCode Fashion Design 係香港女裝直播網店，主播 Glo Glo 每晚直播揀衫，為你帶嚟星空下最閃嘅款式。',
  },
  '/vip': {
    title: 'VIP 會員｜RedCode Fashion Design',
    description: 'RedCode VIP 會員專享折扣同禮遇，消費累積升級，直播粉絲專屬福利。',
  },
  '/vip-verify': {
    title: 'VIP 會員證書驗證｜RedCode Fashion Design',
    description: 'RedCode VIP 會員證書網上驗證，輸入證書編號即時查證會員資格真偽。',
  },
  '/sf-stations': {
    title: '順豐自取點｜RedCode Fashion Design',
    description: '搜尋全港順豐站、自提點同智能櫃，落單揀最近嘅自取點，香港女裝網購取貨更方便。',
  },
  '/login': {
    title: '會員登入｜RedCode Fashion Design',
    description: '登入 RedCode 會員帳戶，睇訂單、追蹤 VIP 進度、享受直播專屬優惠。',
  },
  '/register': {
    title: '會員註冊｜RedCode Fashion Design',
    description: '免費註冊 RedCode 會員，直播優先購、消費累積升 VIP，專享會員禮遇。',
  },
  '/cart': {
    title: '購物車｜RedCode Fashion Design',
    description: 'RedCode 購物車——確認你揀選嘅直播商品，準備結帳。',
  },
  '/checkout': {
    title: '結帳｜RedCode Fashion Design',
    description: 'RedCode 安全結帳，支援順豐站自取同網上付款，香港女裝直播網店。',
  },
  '/account': {
    title: '會員中心｜RedCode Fashion Design',
    description: 'RedCode 會員中心——管理個人資料、VIP 級別、訂單同收件資料。',
  },
  '/orders': {
    title: '我的訂單｜RedCode Fashion Design',
    description: '查詢 RedCode 訂單狀態、付款同取貨進度。',
  },
  '/payment': {
    title: '訂單付款｜RedCode Fashion Design',
    description: 'RedCode 訂單付款頁——上傳付款截圖或網上即時付款。',
  },
  '/privacy': {
    title: '私隱政策｜RedCode Fashion Design',
    description: 'RedCode Fashion Design 私隱政策——我哋點樣收集、使用同保障你嘅個人資料。',
  },
  '/terms': {
    title: '服務條款｜RedCode Fashion Design',
    description: 'RedCode Fashion Design 服務條款——購物、退換貨同會員制度嘅使用細則。',
  },
  '/admin': {
    title: '管理後台｜RedCode Fashion Design',
    description: 'RedCode 店舖管理後台（內部使用）。',
  },
  // 動態段路由：SeoManager 用 pattern 對返呢兩條
  '/products/:id': {
    title: '商品詳情｜RedCode Fashion Design',
    description: 'RedCode 直播精選女裝商品詳情，直播優惠價發售，順豐站自取。',
  },
  '/receipt/:orderId': {
    title: '訂單收據｜RedCode Fashion Design',
    description: 'RedCode 訂單收據——訂單詳情同付款紀錄。',
  },
};

/** 按 pathname 攞 SEO；未知路由 fallback 首頁 */
function resolveSeo(pathname: string): { title: string; description: string } {
  if (/^\/products\/\d+/.test(pathname)) return PAGE_SEO['/products/:id'];
  if (/^\/receipt\//.test(pathname)) return PAGE_SEO['/receipt/:orderId'];
  return PAGE_SEO[pathname] ?? PAGE_SEO['/'];
}

/** 掛喺 Router 之下（App.tsx），每次轉頁即時更新 title 同 description */
export function SeoManager() {
  const { pathname } = useLocation();
  useEffect(() => {
    const seo = resolveSeo(pathname);
    document.title = seo.title;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', seo.description);
  }, [pathname]);
  return null;
}
