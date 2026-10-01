import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import { TRPCProvider } from "@/providers/trpc"
import { AuthProvider } from "@/hooks/useAuth"
import App from './App.tsx'

// react-dev.md：唔好包 <React.StrictMode>（會令 canvas effects 行兩次）
// BrowserRouter：正式路徑利 SEO（Google 對 # 後面嘅路徑永遠當一頁）；
// server 側 app.notFound 已係 SPA fallback（非資源副檔名 GET 一律回 index.html），
// 直接開 /live、/products/:id 都頂到。
//
// 舊 hash 連結收容：舊 hash 路由時代出咗街嘅書籤/分享/證書 QR（例如
// https://redcode.red/#/products/12、/#/vip-verify?c=…&s=…），開機時喺 render 之前
// 用 replaceState 轉做對應正式路徑（保留 hash 入面嘅 query），BrowserRouter 一開就喺正確頁。
// 純錨點 hash（例如 #tiers，唔係 '#/' 開頭）唔郁。
if (window.location.hash.startsWith('#/')) {
  window.history.replaceState(null, '', window.location.hash.slice(1) + window.location.search);
}
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <TRPCProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </TRPCProvider>
  </BrowserRouter>,
)
