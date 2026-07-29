import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import './index.css'
import { TRPCProvider } from "@/providers/trpc"
import { AuthProvider } from "@/hooks/useAuth"
import App from './App.tsx'

// react-dev.md：唔好包 <React.StrictMode>（會令 canvas effects 行兩次）
// HashRouter：純靜態預覽（任何子路徑/重新整理）同 Render production 都穩定工作，
// 唔受 SPA fallback 同相對 asset 路徑限制
//
// 商品分享連結橋：分享出街嘅連結係正式路徑 /products/123（等 Facebook crawler
// 讀到 server 注入嘅商品 OG 預覽圖）；人類訪客撳入嚟，即刻轉返 hash 路由，
// HashRouter 照常顯示商品頁，網址列都會變返 /#/products/123。
if (/^\/products\/\d+\/?$/.test(window.location.pathname) && !window.location.hash) {
  window.history.replaceState(null, '', `/#${window.location.pathname}`);
}
createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <TRPCProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </TRPCProvider>
  </HashRouter>,
)
