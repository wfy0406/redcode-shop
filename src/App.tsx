import { Suspense, lazy, useEffect, useRef } from 'react';
import { Routes, Route, useLocation } from 'react-router';
import Layout from '@/components/Layout';
import Home from '@/pages/Home';
import { SeoManager } from '@/lib/seo';
import {
  adoptGloGuidePrerender,
  discardGloGuidePrerender,
  hasGloGuidePrerender,
  removeNonGuidePrerenderBlocks,
} from '@/components/glo-guide/prerender';

// Code splitting（v2.2.20 SEO/效能）：Home 同 Layout/Navbar/Footer 保持 eager（LCP 考量），
// 其餘頁面全部 React.lazy 按需載入；Admin 一定 lazy（一般人唔會入，唔好拖慢首屏）。
const Products = lazy(() => import('@/pages/Products'));
const ProductDetail = lazy(() => import('@/pages/ProductDetail'));
const GloGuideList = lazy(() => import('@/pages/GloGuideList'));
const GloGuideDetail = lazy(() => import('@/pages/GloGuideDetail'));
const Live = lazy(() => import('@/pages/Live'));
const About = lazy(() => import('@/pages/About'));
const Login = lazy(() => import('@/pages/Login'));
const Register = lazy(() => import('@/pages/Register'));
const Cart = lazy(() => import('@/pages/Cart'));
const Checkout = lazy(() => import('@/pages/Checkout'));
const Account = lazy(() => import('@/pages/Account'));
const MyOrders = lazy(() => import('@/pages/MyOrders'));
const Payment = lazy(() => import('@/pages/Payment'));
const Receipt = lazy(() => import('@/pages/Receipt'));
const Privacy = lazy(() => import('@/pages/Privacy'));
const Terms = lazy(() => import('@/pages/Terms'));
const Admin = lazy(() => import('@/pages/Admin'));
const Vip = lazy(() => import('@/pages/Vip')); // v2.1.0：會員制度介紹頁
const VipVerify = lazy(() => import('@/pages/VipVerify')); // v2.2.0：公開會員證書驗證頁
const SfStations = lazy(() => import('@/pages/SfStations')); // v2.2.0：公開順豐站點查詢頁
const Faq = lazy(() => import('@/pages/Faq')); // 常見問題 FAQ（接收通知教學＋Q&A 手風琴）
const Returns = lazy(() => import('@/pages/Returns')); // 2026-10-06：退換貨政策頁（配合 Google Merchant Center 免費刊登要求）
const GuestCheckout = lazy(() => import('@/pages/GuestCheckout')); // 2026-10-09：訪客快速結帳（唔使開帳號）
const GuestPayment = lazy(() => import('@/pages/GuestPayment')); // 2026-10-09：訪客付款／狀態頁（倒數＋Airwallex 回跳）
const WalletTopup = lazy(() => import('@/pages/WalletTopup')); // v2.5.0：會員購物金充值（套票＋批核入帳）
const TryOn = lazy(() => import('@/pages/TryOn')); // AI 試穿／Mix & Match 私人工作枱
const TryOnHistory = lazy(() => import('@/pages/TryOnHistory')); // 客戶專屬 24 小時試穿紀錄
const TryOnShared = lazy(() => import('@/pages/TryOnShared')); // 有時限分享頁（只回生成圖及公開商品資料）
const LuckyResults = lazy(() => import('@/pages/LuckyResults')); // v2.5.8：公開中獎公告頁（唔使登入）
const LuckyTicketLookup = lazy(() => import('@/pages/LuckyTicketLookup')); // 2026-11-08：公開抽獎劵查詢頁（noindex）
const WebDesignPage = lazy(() => import('@/pages/WebDesignPage')); // 2026-11-09：獨立網站設計銷售頁（唔共用星空 Layout）
const WebDesignPublicBillPage = lazy(() => import('@/pages/WebDesignPublicBillPage')); // v2026.11.13.1（SPEC §9）：公開單據頁（唔共用 Layout，乾淨 path 直達）
const NotFound = lazy(() => import('@/pages/NotFound')); // 未知網址：人類用戶 404 頁

/**
 * Lazy 頁載入中嘅全屏 fallback：品牌色底 #0A0614＋粉紅 #FE017E「載入中…」，
 * 呼吸動畫淨用 opacity（鐵律：動畫只准 opacity/transform，唔准藍紫漸變）。
 */
function PageLoading() {
  return (
    <div
      role="status"
      aria-label="頁面載入中"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0A0614',
        zIndex: 40,
      }}
    >
      <style>{`@keyframes rc-page-loading-breathe{0%,100%{opacity:.45}50%{opacity:1}}`}</style>
      <span
        style={{
          color: '#FE017E',
          fontSize: '15px',
          fontWeight: 700,
          letterSpacing: '0.2em',
          animation: 'rc-page-loading-breathe 1.6s ease-in-out infinite',
        }}
      >
        載入中…
      </span>
    </div>
  );
}

/**
 * v2026.11.16（公開 QA CLS 修正第二部）：Glo Guide route-level fallback 專用。
 * PageLoading 係 fixed 定位、outlet 實際高度 0，Footer 初始會出現喺首屏，
 * 真內容載入後被推晒出 viewport（實測 CLS 0.56–0.82）。呢層 minHeight:100dvh
 * 令 loading 期間 outlet 已經撐足一屏，Footer 由一開始就喺首屏以下。
 * PageLoading 本身原樣重用；淨係 glo-guide 兩條 route 用，其他 routes 唔郁。
 *
 * 2026-11-19（R01）：入口首口 HTML 已含真文章（glo-guide prerender）時，
 * 唔好用不透明全屏 loading 冚住佢——將區塊搬入 outlet 原位，chunk 載入期間
 * 客人可以照讀（慢網絡無全版消失）；頁面真資料 commit 後由頁面自己清走。
 * 冇 prerender（SPA 轉入）→ 沿用原 100dvh loading fallback。
 */
function GuideRouteLoading() {
  if (hasGloGuidePrerender()) {
    return (
      <div
        ref={(el) => {
          if (el) adoptGloGuidePrerender(el);
        }}
      />
    );
  }
  return (
    <div style={{ minHeight: '100dvh' }}>
      <PageLoading />
    </div>
  );
}

/**
 * Routing contract：Nested-route pattern（react-dev.md Pattern B）
 * Layout render <Outlet/>，所以呢度用巢狀 <Route>，唔好溝 children pattern。
 * 2026-08-05：加 /privacy（私隱政策）＋ /terms（服務條款），頁尾 Footer 有連結。
 * SeoManager 要喺 BrowserRouter 之下（main.tsx 包咗），每次轉頁更新 title/description。
 */
export default function App() {
  const location = useLocation();
  // 入口路徑：首口 prerender 只屬於呢個 path；之後任何 SPA 轉頁都要清剩餘區塊
  const entryPath = useRef(location.pathname);

  useEffect(() => {
    // Server 首口 HTML 嘅公開內容只係無 JS／crawler fallback。非 glo-guide 注入
    // （首頁／公開頁摘要等）對應 eager 頁面，React 成功 mount 即移除，避免重複；
    // glo-guide 文章區塊（data-redcode-prerender="glo-guide"）留俾對應頁面喺
    // 真資料＋真 H1 commit 後先清（見 components/glo-guide/prerender.ts），
    // 慢網絡下唔會全版消失。#root 自始至終由 React 管理，白屏自救唔受影響。
    removeNonGuidePrerenderBlocks();
  }, []);

  useEffect(() => {
    // SPA 轉頁／notFound：離開入口路徑即清 glo-guide prerender（包括被領養中嘅），
    // 其他頁唔會留低舊文；入口路徑重渲染（同 path）唔郁。
    if (location.pathname !== entryPath.current) discardGloGuidePrerender();
  }, [location.pathname]);

  return (
    <>
      <SeoManager />
      <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route path="web-design" element={<WebDesignPage />} />
          {/* SPEC §9：公開單據 https://redcode.red/web-design-bill/<token> 直達（唔准 iframe/redirect） */}
          <Route path="web-design-bill/:token" element={<WebDesignPublicBillPage />} />
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="products" element={<Products />} />
            <Route path="products/:id" element={<ProductDetail />} />
            {/* v2026.11.16（公開 QA CLS 修正）：Glo Guide 兩條 route 各自用 route-level Suspense
                包住 lazy element —— chunk 載入時只有 outlet 內容落 GuideRouteLoading，外層 Layout（Navbar/Footer）
                保持 mounted，唔再成棵卸走再還原；fallback 用 100dvh 撐高 outlet，Footer 唔會先出現喺首屏
                再被推走（直開 detail 實測 CLS 0.55→0.82 就係呢兩層因）。其他 routes 繼續用外層共用 Suspense，唔郁。 */}
            <Route path="glo-guide" element={<Suspense fallback={<GuideRouteLoading />}><GloGuideList /></Suspense>} />
            <Route path="glo-guide/:slug" element={<Suspense fallback={<GuideRouteLoading />}><GloGuideDetail /></Suspense>} />
            <Route path="live" element={<Live />} />
            <Route path="about" element={<About />} />
            <Route path="vip" element={<Vip />} />
            <Route path="/vip-verify" element={<VipVerify />} />
            <Route path="/sf-stations" element={<SfStations />} />
            <Route path="faq" element={<Faq />} />
            <Route path="login" element={<Login />} />
            <Route path="register" element={<Register />} />
            <Route path="cart" element={<Cart />} />
            <Route path="checkout" element={<Checkout />} />
            <Route path="guest-checkout" element={<GuestCheckout />} />
            <Route path="guest-payment" element={<GuestPayment />} />
            <Route path="account" element={<Account />} />
            <Route path="orders" element={<MyOrders />} />
            <Route path="payment" element={<Payment />} />
            <Route path="wallet-topup" element={<WalletTopup />} />
            <Route path="try-on" element={<TryOn />} />
            <Route path="try-on/history" element={<TryOnHistory />} />
            <Route path="try-on/shared/:publicId" element={<TryOnShared />} />
            <Route path="lucky-results" element={<LuckyResults />} />
            <Route path="lucky-results/:eventId" element={<LuckyResults />} />
            <Route path="lucky-tickets/:eventId" element={<LuckyTicketLookup />} />
            <Route path="receipt/:orderId" element={<Receipt />} />
            <Route path="privacy" element={<Privacy />} />
            <Route path="terms" element={<Terms />} />
            <Route path="returns" element={<Returns />} />
            <Route path="admin" element={<Admin />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
    </>
  );
}
