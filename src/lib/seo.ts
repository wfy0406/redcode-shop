import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { formatLiveDateLabel, liveSharePath, normalizeLiveShare } from './liveShare';

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
    // 2026-10-27（老闆批准文案）：AI 試穿賣點入公開 SEO copy（網站本身有 /try-on 功能，屬實）
    description:
      'RedCode Fashion Design 官方購物網站 — 香港女裝直播，主播 Glo Glo 每晚為你揀選星空下最閃嘅衫。AI 試穿：影張相即刻試穿，即刻睇到著上身效果。直播專屬優惠、直播重溫、順豐站自取，VIP 會員尊享禮遇。',
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
    // 2026-10-27（老闆批准文案）：同 api/lib/vite.ts ROUTE_SEO['/about'] 保持一致
    description:
      'RedCode Fashion Design 係香港女裝直播網店，主播 Glo Glo 每晚直播揀衫，為你帶嚟星空下最閃嘅款式。網站設 AI 試穿——影張相即刻試穿，即刻睇到著上身效果。',
  },
  '/web-design': {
    title: '香港網站設計｜前台、後台及逐項 SEO｜RedCode',
    description:
      'RedCode 網站設計：一頁式前台或前台＋後台，逐項列明香港市場對照價、折扣及 SEO 驗證項目；可網上落單、上載付款截圖及自助查詢進度。',
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
  '/faq': {
    title: '常見問題｜RedCode Fashion Design',
    description:
      'RedCode 常見問題——訪客結帳、付款、出貨、退換貨、順豐自取、AI 試穿、手機 APP 安裝及開播通知教學。',
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
  '/guest-checkout': {
    title: '訪客快速結帳｜RedCode Fashion Design',
    description: 'RedCode 訪客快速結帳——填寫收件資料，完成網上付款。',
  },
  '/guest-payment': {
    title: '訪客訂單付款｜RedCode Fashion Design',
    description: 'RedCode 訪客訂單付款及狀態查詢。',
  },
  '/wallet-topup': {
    title: '購物金充值｜RedCode Fashion Design',
    description: 'RedCode 會員購物金充值及入帳紀錄。',
  },
  '/try-on': {
    title: 'AI 試穿｜RedCode Fashion Design',
    description:
      'RedCode AI 試穿——上載全身相，揀選 RedCode 商品，生成 AI 穿著效果預覽，支援前後對照、下載及分享；會員登入後使用。',
  },
  '/try-on/history': {
    title: '我嘅 AI 試穿紀錄｜RedCode Fashion Design',
    description: 'RedCode 會員私人 AI 試穿紀錄、下載及分享管理。',
  },
  '/try-on/shared/:publicId': {
    title: 'AI 試穿分享｜RedCode Fashion Design',
    description: 'RedCode 有時限 AI 試穿效果分享及公開商品資料。',
  },
  '/privacy': {
    title: '私隱政策｜RedCode Fashion Design',
    description: 'RedCode Fashion Design 私隱政策——我哋點樣收集、使用同保障你嘅個人資料。',
  },
  '/terms': {
    title: '服務條款｜RedCode Fashion Design',
    description: 'RedCode Fashion Design 服務條款——購物、退換貨同會員制度嘅使用細則。',
  },
  // 2026-10-06：退換貨政策頁（Google Merchant Center 免費刊登要求網站公開退貨政策）
  '/returns': {
    title: '退換貨政策｜RedCode Fashion Design',
    description:
      'RedCode 退換貨政策——收貨 7 天內：貨品破損包換包退（寄出前拍照紀錄），尺寸不合原則上可換貨。',
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
  '/lucky-results': {
    title: '中獎公告｜RedCode Fashion Design',
    description: 'RedCode 直播抽獎中獎公告——即場抽出嘅真實幸運兒名單，下一個可能係你。',
  },
  // v2.5.8：公開中獎公告（動態段 /lucky-results/:eventId）
  // 2026-10-27（Search Console duplicate title 修正）：呢條係單場活動嘅中獎名單詳情頁
  // （LuckyResults → LuckyResultsEvent），唔係公告總頁；title 用頁面自己嘅用字
  // 「中獎名單」同總頁「中獎公告」區分，兩條 route 唔再共用同一 title。
  '/lucky-results/:eventId': {
    title: '中獎名單｜RedCode Fashion Design',
    description: 'RedCode 直播抽獎中獎公告——即場抽出嘅真實幸運兒名單，下一個可能係你。',
  },
  // 2026-11-08：公開查劵頁只供持有活動連結嘅客人自助查詢；resolveSeo 有 title/description，
  // isNoIndexPath 保持預設 noindex/nofollow，唔加入公開收錄白名單。
  '/lucky-tickets/:eventId': {
    title: '抽獎劵查詢｜RedCode Fashion Design',
    description: 'RedCode 公開抽獎劵查詢——輸入完整姓名查自己有幾張抽獎劵；呢頁唔會公開參加者名單。',
  },
};

export const NOT_FOUND_SEO = {
  title: '搵唔到呢頁｜RedCode Fashion Design',
  description: '呢個網址唔存在，返回 RedCode 首頁或去全部貨品睇最新直播精選女裝。',
};

/** 按 pathname＋有效直播 query 攞 SEO；未知路由要有自己嘅 404 文案，唔再冒充首頁。 */
export function resolveSeo(pathname: string, search = ''): { title: string; description: string } {
  if (pathname === '/products') {
    const params = new URLSearchParams(search);
    const live = normalizeLiveShare(params.get('liveDate') ?? '', params.get('liveSession'));
    if (live) {
      const date = formatLiveDateLabel(live.liveDate);
      return {
        title: live.liveSession
          ? `${date} 第${live.liveSession}場直播商品｜RedCode Fashion Design`
          : `${date} 全日直播商品｜RedCode Fashion Design`,
        description: live.liveSession
          ? `RedCode ${date} 第${live.liveSession}場直播商品——呢一場主播推介嘅女裝款式即睇直播商品、睇中即刻落單，直播優惠價發售，順豐站自取。`
          : `RedCode ${date} 直播全日全部場次嘅精選女裝，一頁睇晒當日所有直播商品，直播優惠價發售，順豐站自取。`,
      };
    }
  }
  if (/^\/products\/\d+/.test(pathname)) return PAGE_SEO['/products/:id'];
  if (/^\/receipt\//.test(pathname)) return PAGE_SEO['/receipt/:orderId'];
  if (/^\/lucky-results\/\d+/.test(pathname)) return PAGE_SEO['/lucky-results/:eventId'];
  if (/^\/lucky-tickets\/\d+/.test(pathname)) return PAGE_SEO['/lucky-tickets/:eventId'];
  if (/^\/try-on\/shared\/[^/]+/.test(pathname)) return PAGE_SEO['/try-on/shared/:publicId'];
  const exactPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return PAGE_SEO[exactPath] ?? NOT_FOUND_SEO;
}

const PUBLIC_EXACT_PATHS = new Set([
  '/',
  '/products',
  '/live',
  '/about',
  '/web-design',
  '/vip',
  '/sf-stations',
  '/faq',
  '/returns',
  '/try-on',
  '/lucky-results',
  '/privacy',
  '/terms',
]);

/** 私人、有時限分享、後台及未知路由一律 noindex；公開動態商品／活動頁例外。 */
export function isNoIndexPath(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (PUBLIC_EXACT_PATHS.has(normalized)) return false;
  if (/^\/products\/\d+$/.test(normalized)) return false;
  if (/^\/lucky-results\/\d+$/.test(normalized)) return false;
  return true;
}

/** SPA 轉頁後都要維持 canonical host；私人／404 頁回 null，唔再沿用首頁 canonical。 */
export function resolveCanonicalPath(pathname: string, search = ''): string | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (normalized === '/products') {
    const params = new URLSearchParams(search);
    const live = normalizeLiveShare(params.get('liveDate') ?? '', params.get('liveSession'));
    return live ? liveSharePath(live) : '/products';
  }
  if (PUBLIC_EXACT_PATHS.has(normalized)) return normalized;
  if (/^\/products\/\d+$/.test(normalized)) return normalized;
  if (/^\/lucky-results\/\d+$/.test(normalized)) return normalized;
  // 查劵頁雖然 noindex，server 本來就用 self canonical，前後保持一致。
  if (/^\/lucky-tickets\/\d+$/.test(normalized)) return normalized;
  return null;
}

/** null＝移除錯誤嘅首頁 canonical／og:url；否則一律寫 HTTPS apex canonical URL。 */
export function setCanonicalPath(path: string | null): void {
  if (typeof document === 'undefined') return;
  const existing = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (path === null) {
    existing?.remove();
    ogUrl?.remove();
    return;
  }
  const href = `https://redcode.red${path}`;
  const link = existing ?? document.createElement('link');
  link.setAttribute('rel', 'canonical');
  link.setAttribute('href', href);
  if (!existing) document.head.appendChild(link);
  ogUrl?.setAttribute('content', href);
}

/** 掛喺 Router 之下，每次轉頁或更改有效直播篩選即時更新 title、description、robots 同 canonical。 */
export function SeoManager() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    const seo = resolveSeo(pathname, search);
    document.title = seo.title;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', seo.description);
    document
      .querySelector('meta[name="robots"]')
      ?.setAttribute('content', isNoIndexPath(pathname) ? 'noindex, nofollow' : 'index, follow');
    setCanonicalPath(resolveCanonicalPath(pathname, search));
  }, [pathname, search]);
  return null;
}
