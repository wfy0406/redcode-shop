import { useState } from "react";
import { trpc } from "../../trpc";
import { useAuth } from "../../hooks/useAuth";

type PromoForm = {
  code: string;
  kind: "percent" | "fixed";
  value: string;
  minSpend: string;
  usageLimit: string;
  perUserLimit: string;
  expiresAt: string;
};

const EMPTY_FORM: PromoForm = {
  code: "",
  kind: "percent",
  value: "",
  minSpend: "",
  usageLimit: "",
  perUserLimit: "",
  expiresAt: "",
};

function formatDate(d: string | Date | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export default function PromoManager({ toast }: { toast: (msg: string) => void }) {
  const { user } = useAuth();
  const listQ = trpc.promo.adminList.useQuery();
  const utils = trpc.useUtils();

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<PromoForm>(EMPTY_FORM);

  const createMut = trpc.promo.create.useMutation({
    onSuccess: (r) => {
      // 員工操作需審批（2026-08-06 Glo 要求）：staff 會收到 pendingApproval＋requestId
      if ("pendingApproval" in r && r.pendingApproval) {
        toast(`已提交審批（#${r.requestId}），等主管/管理員批准`);
      } else {
        toast("優惠碼已建立");
      }
      setShowCreate(false);
      setForm(EMPTY_FORM);
      void utils.promo.adminList.invalidate();
    },
    onError: (e) => toast(`建立失敗：${e.message}`),
  });

  const updateMut = trpc.promo.update.useMutation({
    onSuccess: (r) => {
      if ("pendingApproval" in r && r.pendingApproval) {
        toast(`已提交審批（#${r.requestId}），等主管/管理員批准`);
      } else {
        toast("已更新");
      }
      void utils.promo.adminList.invalidate();
    },
    onError: (e) => toast(`更新失敗：${e.message}`),
  });

  const removeMut = trpc.promo.remove.useMutation({
    onSuccess: () => {
      toast("已刪除");
      void utils.promo.adminList.invalidate();
    },
    onError: (e) => toast(`刪除失敗：${e.message}`),
  });

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-stone-800">優惠碼</h2>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="rounded-lg bg-stone-900 px-4 py-2 text-sm text-white hover:bg-stone-700"
        >
          {showCreate ? "取消" : "＋ 新增優惠碼"}
        </button>
      </div>

      {showCreate && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createMut.mutate({
              code: form.code,
              kind: form.kind,
              value:
                form.kind === "percent"
                  ? Number(form.value)
                  : Math.round(Number(form.value) * 100),
              minSpend: form.minSpend ? Math.round(Number(form.minSpend) * 100) : 0,
              usageLimit: form.usageLimit ? Number(form.usageLimit) : null,
              perUserLimit: form.perUserLimit ? Number(form.perUserLimit) : null,
              expiresAt: form.expiresAt ? new Date(form.expiresAt) : null,
            });
          }}
          className="mb-6 space-y-3 rounded-xl border border-stone-200 bg-stone-50 p-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              placeholder="優惠碼（例如 SUMMER95）"
              required
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as "percent" | "fixed" })}
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            >
              <option value="percent">百分比折扣（% off）</option>
              <option value="fixed">固定金額折扣（$ off）</option>
            </select>
            <input
              value={form.value}
              onChange={(e) => setForm({ ...form, value: e.target.value })}
              placeholder={form.kind === "percent" ? "折扣 %（例如 5 ＝ 95 折）" : "折扣金額（$）"}
              type="number"
              min="1"
              step={form.kind === "percent" ? "1" : "0.01"}
              required
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
            <input
              value={form.minSpend}
              onChange={(e) => setForm({ ...form, minSpend: e.target.value })}
              placeholder="最低消費（$，選填）"
              type="number"
              min="0"
              step="0.01"
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
            <input
              value={form.usageLimit}
              onChange={(e) => setForm({ ...form, usageLimit: e.target.value })}
              placeholder="總使用次數上限（選填）"
              type="number"
              min="1"
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
            <input
              value={form.perUserLimit}
              onChange={(e) => setForm({ ...form, perUserLimit: e.target.value })}
              placeholder="每人限用次數（選填）"
              type="number"
              min="1"
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
            <input
              value={form.expiresAt}
              onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
              type="date"
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={createMut.isPending}
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm text-white hover:bg-stone-700 disabled:opacity-50"
          >
            {createMut.isPending ? "建立中…" : "建立優惠碼"}
          </button>
        </form>
      )}

      {listQ.isLoading ? (
        <div className="py-20 text-center text-stone-400">載入中…</div>
      ) : (listQ.data ?? []).length === 0 ? (
        <div className="py-20 text-center text-stone-400">暫時冇優惠碼</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-stone-200">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-stone-50 text-left text-stone-500">
              <tr>
                <th className="px-3 py-2 font-medium">優惠碼</th>
                <th className="px-3 py-2 font-medium">折扣</th>
                <th className="px-3 py-2 font-medium">最低消費</th>
                <th className="px-3 py-2 font-medium">使用情況</th>
                <th className="px-3 py-2 font-medium">到期日</th>
                <th className="px-3 py-2 font-medium">狀態</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {(listQ.data ?? []).map((p) => (
                <tr key={p.id} className="hover:bg-stone-50">
                  <td className="px-3 py-2 font-mono font-medium text-stone-800">{p.code}</td>
                  <td className="px-3 py-2 text-stone-600">
                    {p.kind === "percent" ? `${p.value}% off` : `減 $${(p.value / 100).toFixed(0)}`}
                  </td>
                  <td className="px-3 py-2 text-stone-600">
                    {p.minSpend > 0 ? `$${(p.minSpend / 100).toFixed(0)}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-stone-600">
                    {p.usedCount}
                    {p.usageLimit !== null ? ` / ${p.usageLimit}` : ""}
                    {p.perUserLimit !== null ? `（每人限 ${p.perUserLimit}）` : ""}
                  </td>
                  <td className="px-3 py-2 text-stone-600">{formatDate(p.expiresAt)}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${p.isActive ? "bg-green-100 text-green-700" : "bg-stone-100 text-stone-500"}`}
                    >
                      {p.isActive ? "啟用中" : "已停用"}
                    </span>
                  </td>
                  <td className="space-x-2 px-3 py-2">
                    <button
                      onClick={() => updateMut.mutate({ id: p.id, isActive: !p.isActive })}
                      className="text-xs text-stone-500 hover:underline"
                    >
                      {p.isActive ? "停用" : "啟用"}
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm(`確定刪除優惠碼「${p.code}」？`)) {
                          removeMut.mutate({ id: p.id });
                        }
                      }}
                      className="text-xs text-red-500 hover:underline"
                    >
                      刪除
                    </button>
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
