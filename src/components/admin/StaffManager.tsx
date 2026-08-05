import { useState } from "react";
import { trpc } from "../../trpc";
import { useAuth } from "../../hooks/useAuth";

/**
 * 員工帳號管理（admin 專用）
 * 列表＋開新帳號＋改權限＋刪除；會員帳號喺「會員」頁管，呢度淨係員工＋管理員
 */
// 三級員工制（2026-08-06 Glo 要求）：staff 員工（敏感操作需審批）／supervisor 主管／admin 管理員
const ROLE_LABELS: Record<"member" | "staff" | "supervisor" | "admin", string> = {
  member: "會員",
  staff: "員工",
  supervisor: "主管",
  admin: "管理員",
};

const ROLE_BADGE: Record<"member" | "staff" | "supervisor" | "admin", string> = {
  member: "bg-green-100 text-green-700",
  staff: "bg-amber-100 text-amber-700",
  supervisor: "bg-blue-100 text-blue-700",
  admin: "bg-red-100 text-red-700",
};

export default function StaffManager({ toast }: { toast: (msg: string) => void }) {
  const { user } = useAuth();
  const listQ = trpc.users.list.useQuery();
  const utils = trpc.useUtils();

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"staff" | "supervisor" | "admin">("staff");

  const createMut = trpc.users.create.useMutation({
    onSuccess: () => {
      toast("帳號已建立");
      setShowCreate(false);
      setName("");
      setPhone("");
      setPassword("");
      setRole("staff");
      void utils.users.list.invalidate();
    },
    onError: (e) => toast(`建立失敗：${e.message}`),
  });

  const roleMut = trpc.users.updateRole.useMutation({
    onSuccess: () => {
      toast("權限已更新");
      void utils.users.list.invalidate();
    },
    onError: (e) => toast(`更新失敗：${e.message}`),
  });

  const removeMut = trpc.users.remove.useMutation({
    onSuccess: () => {
      toast("帳號已刪除");
      void utils.users.list.invalidate();
    },
    onError: (e) => toast(`刪除失敗：${e.message}`),
  });

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-stone-800">員工帳號</h2>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="rounded-lg bg-stone-900 px-4 py-2 text-sm text-white hover:bg-stone-700"
        >
          {showCreate ? "取消" : "＋ 開新帳號"}
        </button>
      </div>

      {showCreate && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createMut.mutate({ name, phone, password, role });
          }}
          className="mb-6 space-y-3 rounded-xl border border-stone-200 bg-stone-50 p-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="名稱"
              required
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="電話（登入用）"
              required
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="密碼（至少 6 位）"
              type="password"
              required
              minLength={6}
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "staff" | "supervisor" | "admin")}
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            >
              <option value="staff">員工（敏感操作需審批）</option>
              <option value="supervisor">主管（原有員工權限＋審批）</option>
              <option value="admin">管理員（全部權限）</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={createMut.isPending}
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm text-white hover:bg-stone-700 disabled:opacity-50"
          >
            {createMut.isPending ? "建立中…" : "建立帳號"}
          </button>
        </form>
      )}

      {listQ.isLoading ? (
        <div className="py-20 text-center text-stone-400">載入中…</div>
      ) : (listQ.data ?? []).length === 0 ? (
        <div className="py-20 text-center text-stone-400">暫時冇員工帳號</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-stone-200">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-stone-50 text-left text-stone-500">
              <tr>
                <th className="px-3 py-2 font-medium">名稱</th>
                <th className="px-3 py-2 font-medium">電話</th>
                <th className="px-3 py-2 font-medium">權限</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {(listQ.data ?? []).map((s) => (
                <tr key={s.id} className="hover:bg-stone-50">
                  <td className="px-3 py-2 font-medium text-stone-800">
                    {s.name}
                    {s.id === user?.id && (
                      <span className="ml-1 text-xs text-stone-400">（你）</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-stone-600">{s.phone}</td>
                  <td className="px-3 py-2">
                    {s.id === user?.id ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${ROLE_BADGE[s.role as keyof typeof ROLE_BADGE] ?? ""}`}
                      >
                        {ROLE_LABELS[s.role as keyof typeof ROLE_LABELS] ?? s.role}
                      </span>
                    ) : (
                      <select
                        value={s.role}
                        onChange={(e) =>
                          roleMut.mutate({
                            id: s.id,
                            role: e.target.value as "member" | "staff" | "supervisor" | "admin",
                          })
                        }
                        className={`rounded-full border-0 px-2 py-0.5 text-xs ${ROLE_BADGE[s.role as keyof typeof ROLE_BADGE] ?? "bg-stone-100 text-stone-600"}`}
                      >
                        <option value="member">會員</option>
                        <option value="staff">員工</option>
                        <option value="supervisor">主管</option>
                        <option value="admin">管理員</option>
                      </select>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {s.id !== user?.id && (
                      <button
                        onClick={() => {
                          if (window.confirm(`確定刪除帳號「${s.name}」？`)) {
                            removeMut.mutate({ id: s.id });
                          }
                        }}
                        className="text-xs text-red-500 hover:underline"
                      >
                        刪除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
