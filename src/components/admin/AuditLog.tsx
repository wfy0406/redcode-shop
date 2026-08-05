import { useState } from "react";
import { trpc } from "../../trpc";
import { useAuth } from "../../hooks/useAuth";

// 操作日誌分頁大細
const PAGE_SIZE = 50;

const ACTION_GROUPS = [
  { key: "", label: "全部" },
  { key: "order", label: "訂單" },
  { key: "member", label: "會員" },
  { key: "product", label: "商品" },
  { key: "promo", label: "優惠碼" },
  { key: "praise", label: "打卡牆" },
  { key: "settings", label: "網站設定" },
  { key: "staff", label: "員工帳號" },
  { key: "approval", label: "審批" },
] as const;

function formatTime(iso: string | Date): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function roleBadge(role: string) {
  if (role === "admin") return { text: "管理員", cls: "bg-red-100 text-red-700" };
  if (role === "supervisor") return { text: "主管", cls: "bg-blue-100 text-blue-700" };
  if (role === "staff") return { text: "員工", cls: "bg-amber-100 text-amber-700" };
  if (role === "member") return { text: "會員", cls: "bg-green-100 text-green-700" };
  return { text: role, cls: "bg-stone-100 text-stone-600" };
}

export default function AuditLog() {
  const { isAdmin } = useAuth();
  const [actionPrefix, setActionPrefix] = useState("");
  const [page, setPage] = useState(0);
  const listQ = trpc.audit.list.useQuery(
    { limit: PAGE_SIZE, offset: page * PAGE_SIZE, actionPrefix: actionPrefix || undefined },
    { enabled: isAdmin },
  );

  if (!isAdmin) {
    return (
      <div className="py-20 text-center text-stone-400">只有最高管理員可以睇操作日誌</div>
    );
  }

  const rows = listQ.data ?? [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {ACTION_GROUPS.map((g) => (
          <button
            key={g.key}
            onClick={() => {
              setActionPrefix(g.key);
              setPage(0);
            }}
            className={`rounded-full px-3 py-1 text-sm ${
              actionPrefix === g.key
                ? "bg-stone-900 text-white"
                : "bg-stone-100 text-stone-600 hover:bg-stone-200"
            }`}
          >
            {g.label}
          </button>
        ))}
        <button
          onClick={() => listQ.refetch()}
          className="ml-auto rounded-lg border border-stone-200 px-3 py-1 text-sm text-stone-500 hover:bg-stone-50"
        >
          重新整理
        </button>
      </div>

      {listQ.isLoading ? (
        <div className="py-20 text-center text-stone-400">載入中…</div>
      ) : rows.length === 0 ? (
        <div className="py-20 text-center text-stone-400">暫時冇紀錄</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-stone-200">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-stone-50 text-left text-stone-500">
              <tr>
                <th className="px-3 py-2 font-medium">時間</th>
                <th className="px-3 py-2 font-medium">操作者</th>
                <th className="px-3 py-2 font-medium">動作</th>
                <th className="px-3 py-2 font-medium">內容</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {rows.map((r) => {
                const badge = roleBadge(r.actorRole);
                return (
                  <tr key={r.id} className="hover:bg-stone-50">
                    <td className="whitespace-nowrap px-3 py-2 text-stone-500">
                      {formatTime(r.createdAt)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className="mr-1 font-medium text-stone-800">{r.actorName}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${badge.cls}`}>
                        {badge.text}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-stone-600">
                      {r.action}
                    </td>
                    <td className="px-3 py-2 text-stone-700">{r.detail ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <button
          disabled={page === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          className="rounded-lg border border-stone-200 px-3 py-1 text-sm text-stone-600 disabled:opacity-40"
        >
          ← 上一頁
        </button>
        <span className="text-sm text-stone-400">第 {page + 1} 頁</span>
        <button
          disabled={rows.length < PAGE_SIZE}
          onClick={() => setPage((p) => p + 1)}
          className="rounded-lg border border-stone-200 px-3 py-1 text-sm text-stone-600 disabled:opacity-40"
        >
          下一頁 →
        </button>
      </div>
    </div>
  );
}
