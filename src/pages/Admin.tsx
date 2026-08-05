import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "../hooks/useAuth";
import MemberList from "../components/admin/MemberList";
import ProductManager from "../components/admin/ProductManager";
import OrderList from "../components/admin/OrderList";
import PraiseManager from "../components/admin/PraiseManager";
import PromoManager from "../components/admin/PromoManager";
import SettingsPanel from "../components/admin/SettingsPanel";
import Analytics from "../components/admin/Analytics";
import StaffManager from "../components/admin/StaffManager";
import AuditLog from "../components/admin/AuditLog";
import MarketingEmailCard from "../components/admin/MarketingEmailCard";
import ApprovalCenter from "../components/admin/ApprovalCenter";

// 三級員工制（2026-08-06 Glo 要求）：staff 員工／supervisor 主管／admin 管理員都可以入後台；
// admin-only 頁面（營運數據/網站設定/員工帳號/日誌）喺 NAV 已鎅走，employee 頁 supervisor/admin 先見到
const NAV = [
  { key: "dashboard", label: "概覽", minRole: "staff" },
  { key: "orders", label: "訂單", minRole: "staff" },
  { key: "products", label: "商品", minRole: "staff" },
  { key: "members", label: "會員", minRole: "staff" },
  { key: "praise", label: "打卡牆", minRole: "staff" },
  { key: "promo", label: "優惠碼", minRole: "staff" },
  { key: "approvals", label: "審批中心", minRole: "supervisor" },
  { key: "analytics", label: "營運數據", minRole: "admin" },
  { key: "settings", label: "網站設定", minRole: "admin" },
  { key: "staff", label: "員工帳號", minRole: "admin" },
  { key: "audit", label: "日誌", minRole: "admin" },
] as const;

type NavKey = (typeof NAV)[number]["key"];

export default function Admin() {
  const { user, isStaff, isSupervisor, isAdmin } = useAuth();
  const [view, setView] = useState<NavKey>("dashboard");
  const [toast, setToast] = useState("");

  if (!isStaff) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <div className="mb-4 text-5xl">🔒</div>
        <h1 className="mb-2 text-xl font-bold text-stone-800">員工專區</h1>
        <p className="mb-6 text-stone-500">呢一頁只限員工登入。</p>
        <Link href="/login" className="text-pink-500 underline">
          去登入
        </Link>
      </div>
    );
  }

  const pushToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 3000);
  };

  // 每個角色見到嘅導航：staff 見基本 6 頁；supervisor 加審批中心；admin 全部
  const visibleNav = NAV.filter((n) => {
    if (n.minRole === "admin") return isAdmin;
    if (n.minRole === "supervisor") return isSupervisor;
    return true;
  });

  const viewBody: Record<NavKey, React.ReactNode> = {
    dashboard: <DashboardHome setView={setView} isSupervisor={isSupervisor} />,
    orders: <OrderList toast={pushToast} />,
    products: <ProductManager toast={pushToast} />,
    members: <MemberList toast={pushToast} />,
    praise: <PraiseManager toast={pushToast} />,
    promo: (
      <>
        <MarketingEmailCard toast={pushToast} />
        <PromoManager toast={pushToast} />
      </>
    ),
    approvals: isSupervisor ? <ApprovalCenter toast={pushToast} /> : null,
    analytics: isAdmin ? <Analytics /> : null,
    settings: isAdmin ? <SettingsPanel toast={pushToast} /> : null,
    staff: isAdmin ? <StaffManager toast={pushToast} /> : null,
    audit: isAdmin ? <AuditLog /> : null,
  };

  // 如果而家企咗喺冇權睇嘅頁（例如降權之後），弹返去概覽
  const effectiveView = viewBody[view] ? view : "dashboard";

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {toast && (
        <div className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-full bg-stone-900 px-5 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-stone-800">
          後台管理
          <span className="ml-2 align-middle text-sm font-normal text-stone-400">
            {user?.name}（{user?.role === "admin" ? "管理員" : user?.role === "supervisor" ? "主管" : "員工"}）
          </span>
        </h1>
        <Link href="/" className="text-sm text-stone-500 hover:text-stone-800">
          ← 返去商店
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {visibleNav.map((n) => (
          <button
            key={n.key}
            onClick={() => setView(n.key)}
            className={`rounded-full px-4 py-1.5 text-sm ${
              effectiveView === n.key
                ? "bg-stone-900 text-white"
                : "bg-stone-100 text-stone-600 hover:bg-stone-200"
            }`}
          >
            {n.label}
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-stone-200 bg-white p-5">
        {viewBody[effectiveView]}
      </div>
    </div>
  );
}

function DashboardHome({
  setView,
  isSupervisor,
}: {
  setView: (v: NavKey) => void;
  isSupervisor: boolean;
}) {
  return (
    <div className="py-8 text-center text-stone-500">
      <p className="mb-4 text-lg">👋 歡迎返嚟後台</p>
      <p className="mb-6 text-sm">揀上面嘅分頁開始工作：訂單、商品、會員、打卡牆、優惠碼{isSupervisor ? "、審批中心" : ""}。</p>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          onClick={() => setView("orders")}
          className="rounded-full bg-pink-500 px-4 py-2 text-sm text-white hover:bg-pink-400"
        >
          去睇訂單
        </button>
        <button
          onClick={() => setView("products")}
          className="rounded-full bg-stone-900 px-4 py-2 text-sm text-white hover:bg-stone-700"
        >
          去管商品
        </button>
      </div>
    </div>
  );
}
