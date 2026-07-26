import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import './index.css'
import { TRPCProvider } from "@/providers/trpc"
import { AuthProvider } from "@/hooks/useAuth"
import App from './App.tsx'

// react-dev.md：唔好包 <React.StrictMode>（會令 canvas effects 行兩次）
// HashRouter：純靜態預覽（任何子路徑/重新整理）同 Render production 都穩定工作，
// 唔受 SPA fallback 同相對 asset 路徑限制
createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <TRPCProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </TRPCProvider>
  </HashRouter>,
)
