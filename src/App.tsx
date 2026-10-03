import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router';
import Layout from '@/components/Layout';
import Home from '@/pages/Home';
import { SeoManager } from '@/lib/seo';

// Code splitting（v2.2.20 SEO/效能）：Home 同 Layout/Navbar/Footer 保持 eager（LCP 考量），
// 其餘頁面全部 React.lazy 按需載入；Admin 一定 lazy（一般人唔會入，唔好拖慢首屏）。
const Products = lazy(() => import('@/pages/Products'));
const ProductDetail = lazy(() => import('@/pages/ProductDetail'));
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
 * Routing contract：Nested-route pattern（react-dev.md Pattern B）
 * Layout render <Outlet/>，所以呢度用巢狀 <Route>，唔好溝 children pattern。
 * 2026-08-05：加 /privacy（私隱政策）＋ /terms（服務條款），頁尾 Footer 有連結。
 * SeoManager 要喺 HashRouter 之下（main.tsx 包咗），每次轉頁更新 title/description。
 */
export default function App() {
  return (
    <>
      <SeoManager />
      <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="products" element={<Products />} />
            <Route path="products/:id" element={<ProductDetail />} />
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
            <Route path="account" element={<Account />} />
            <Route path="orders" element={<MyOrders />} />
            <Route path="payment" element={<Payment />} />
            <Route path="receipt/:orderId" element={<Receipt />} />
            <Route path="privacy" element={<Privacy />} />
            <Route path="terms" element={<Terms />} />
            <Route path="admin" element={<Admin />} />
          </Route>
        </Routes>
      </Suspense>
    </>
  );
}
