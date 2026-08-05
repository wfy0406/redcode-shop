import { useMemo, useState } from "react";
import { trpc } from "../../trpc";
import { useAuth } from "../../hooks/useAuth";
import { ORDER_STATUS_LABELS, ORDER_STATUS_BADGE } from "../../lib/orderStatus";
import MarketingOptInBadge from "./MarketingOptInBadge";

type MemberRow = {
  id: number;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  birthMonth: number | null;
  createdAt: string | Date;
  googleLinked: boolean;
  marketingOptIn: boolean;
  marketingPromptedAt: string | Date | null;
  orderCount: number;
  totalSpent: number;
};

type MemberDetail = {
  user: {
    id: number;
    name: string;
    phone: string;
    email: string | null;
    address: string | null;
    age: number | null;
    birthMonth: number | null;
    createdAt: string | Date;
    googleLinked: boolean;
    googleEmail: string | null;
    googleName: string | null;
    marketingOptIn: boolean;
    marketingOptInAt: string | Date | null;
    marketingPromptedAt: string | Date | null;
  };
  orderCount: number;
  totalSpent: number;
  recentOrders: {
    id: number;
    orderNo: string;
    status: keyof typeof ORDER_STATUS_LABELS;
    total: number;
    deliveryMethod: string;
    createdAt: string | Date;
  }[];
};

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

function formatTime(iso: string | Date): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 修改會員資料彈窗（員工＋管理員，2026-07-29；員工提交會轉審批 2026-08-06 Glo 要求） */
function EditMemberModal({
  member,
  onClose,
  toast,
}: {
  member: MemberDetail["user"];
  onClose: () => void;
  toast: (msg: string) => void;
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState(member.name);
  const [phone, setPhone] = useState(member.phone);
  const [email, setEmail] = useState(member.email ?? "");
  const [address, setAddress] = useState(member.address ?? "");
  const [age, setAge] = useState(member.age != null ? String(member.age) : "");
  const [birthMonth, setBirthMonth] = useState(
    member.birthMonth != null ? String(member.birthMonth) : "",
  );
  const [marketingOptIn, setMarketingOptIn] = useState(member.marketingOptIn);
  const [error, setError] = useState("");

  const updateMut = trpc.members.update.useMutation({
    onSuccess: (r) => {
      // 員工操作需審批（2026-08-06 Glo 要求）：staff 會收到 pendingApproval＋requestId
      if ("pendingApproval" in r && r.pendingApproval) {
        toast(`已提交審批（#${r.requestId}），等主管/管理員批准`);
      } else {
        toast("會員資料已更新");
      }
      void utils.members.list.invalidate();
      void utils.members.detail.invalidate({ id: member.id });
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-lg font-bold text-stone-800">修改會員資料</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            updateMut.mutate({
              id: member.id,
              name,
              phone,
              email: email.trim() ? email.trim() : null,
              address: address.trim() ? address.trim() : null,
              age: age.trim() ? Number(age) : null,
              birthMonth: birthMonth.trim() ? Number(birthMonth) : null,
              marketingOptIn,
            });
          }}
          className="space-y-3"
        >
          <div>
            <label className="mb-1 block text-xs font-medium text-stone-600">名稱</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-stone-600">電話</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-stone-600">Email（選填）</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-stone-600">地址（選填）</label>
            <textarea
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-stone-600">年齡（選填）</label>
              <input
                value={age}
                onChange={(e) => setAge(e.target.value)}
                type="number"
                min="0"
                max="150"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-stone-600">
                生日月份（選填）
              </label>
              <select
                value={birthMonth}
                onChange={(e) => setBirthMonth(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
              >
                <option value="">未填</option>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>
                    {m} 月
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-stone-700">
            <input
              type="checkbox"
              checked={marketingOptIn}
              onChange={(e) => setMarketingOptIn(e.target.checked)}
            />
            同意接收推廣資訊（人手設定＝已表態，會員唔會再見到彈窗）
          </label>
          {error && <div className="text-sm text-red-500">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-stone-200 px-4 py-2 text-sm text-stone-600 hover:bg-stone-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={updateMut.isPending}
              className="rounded-lg bg-stone-900 px-4 py-2 text-sm text-white hover:bg-stone-700 disabled:opacity-50"
            >
              {updateMut.isPending ? "儲存中…" : "儲存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** 重設密碼彈窗（2026-08-03 加；員工幫唔記得密碼嘅會員即時重設） */
function ResetPasswordModal({
  member,
  onClose,
  toast,
}: {
  member: MemberDetail["user"];
  onClose: () => void;
  toast: (msg: string) => void;
}) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState("");

  const resetMut = trpc.members.resetPassword.useMutation({
    onSuccess: () => {
      toast(`已重設「${member.name}」嘅密碼`);
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-lg font-bold text-stone-800">重設密碼</h3>
        <p className="mb-4 text-sm text-stone-500">
          幫「{member.name}」設新密碼，即時生效，唔使舊密碼。
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            if (pw !== pw2) {
              setError("兩次輸入嘅密碼唔一樣");
              return;
            }
            resetMut.mutate({ id: member.id, newPassword: pw });
          }}
          className="space-y-3"
        >
          <input
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            type="password"
            required
            minLength={6}
            placeholder="新密碼（至少 6 位）"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
          />
          <input
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            type="password"
            required
            minLength={6}
            placeholder="再輸入一次新密碼"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
          />
          {error && <div className="text-sm text-red-500">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-stone-200 px-4 py-2 text-sm text-stone-600 hover:bg-stone-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={resetMut.isPending}
              className="rounded-lg bg-stone-900 px-4 py-2 text-sm text-white hover:bg-stone-700 disabled:opacity-50"
            >
              {resetMut.isPending ? "重設中…" : "重設密碼"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** 會員詳情彈窗：基本資料＋訂單統計＋最近 10 張訂單（2026-07-28） */
function MemberDetailModal({
  memberId,
  onClose,
  toast,
}: {
  memberId: number;
  onClose: () => void;
  toast: (msg: string) => void;
}) {
  const { isAdmin } = useAuth();
  const detailQ = trpc.members.detail.useQuery({ id: memberId });
  const utils = trpc.useUtils();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showResetPw, setShowResetPw] = useState(false);

  const removeMut = trpc.members.remove.useMutation({
    onSuccess: () => {
      toast("會員已刪除");
      void utils.members.list.invalidate();
      onClose();
    },
    onError: (e) => toast(`刪除失敗：${e.message}`),
  });

  const d: MemberDetail | undefined = detailQ.data;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {detailQ.isLoading || !d ? (
          <div className="py-20 text-center text-stone-400">載入中…</div>
        ) : (
          <>
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h3 className="text-xl font-bold text-stone-800">{d.user.name}</h3>
                <div className="mt-1 text-sm text-stone-500">
                  註冊於 {formatTime(d.user.createdAt)}
                </div>
              </div>
              <button
                onClick={onClose}
                className="rounded-full p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
              >
                ✕
              </button>
            </div>

            <dl className="mb-4 grid grid-cols-1 gap-x-6 gap-y-2 rounded-xl bg-stone-50 p-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-stone-400">電話</dt>
                <dd className="text-stone-800">{d.user.phone}</dd>
              </div>
              <div>
                <dt className="text-stone-400">Email</dt>
                <dd className="text-stone-800">{d.user.email ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-stone-400">地址</dt>
                <dd className="text-stone-800">{d.user.address ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-stone-400">年齡</dt>
                <dd className="text-stone-800">{d.user.age != null ? `${d.user.age} 歲` : "—"}</dd>
              </div>
              <div>
                <dt className="text-stone-400">生日月份</dt>
                <dd className="text-stone-800">
                  {d.user.birthMonth != null ? `${d.user.birthMonth} 月` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-stone-400">Google 帳號</dt>
                <dd className="text-stone-800">
                  {d.user.googleLinked ? (
                    <>
                      <span className="mr-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
                        已連結
                      </span>
                      {d.user.googleEmail ?? ""}
                      {d.user.googleName ? `（${d.user.googleName}）` : ""}
                    </>
                  ) : (
                    <span className="text-stone-400">未連結</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-stone-400">推廣資訊</dt>
                <dd>
                  <MarketingOptInBadge
                    optIn={d.user.marketingOptIn}
                    promptedAt={d.user.marketingPromptedAt}
                    createdAt={d.user.createdAt}
                  />
                  {d.user.marketingOptIn && d.user.marketingOptInAt && (
                    <span className="ml-1 text-xs text-stone-400">
                      （{formatTime(d.user.marketingOptInAt)} 同意）
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-stone-400">累積訂單</dt>
                <dd className="text-stone-800">
                  {d.orderCount} 張（{formatMoney(d.totalSpent)}）
                </dd>
              </div>
            </dl>

            <h4 className="mb-2 text-sm font-semibold text-stone-700">最近訂單</h4>
            {d.recentOrders.length === 0 ? (
              <div className="mb-4 rounded-xl border border-dashed border-stone-200 py-6 text-center text-sm text-stone-400">
                暫時冇訂單
              </div>
            ) : (
              <div className="mb-4 overflow-x-auto rounded-xl border border-stone-200">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="bg-stone-50 text-left text-stone-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">訂單號</th>
                      <th className="px-3 py-2 font-medium">狀態</th>
                      <th className="px-3 py-2 font-medium">金額</th>
                      <th className="px-3 py-2 font-medium">取貨</th>
                      <th className="px-3 py-2 font-medium">時間</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {d.recentOrders.map((o) => (
                      <tr key={o.id} className="hover:bg-stone-50">
                        <td className="px-3 py-2 font-mono text-xs text-stone-700">{o.orderNo}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${ORDER_STATUS_BADGE[o.status] ?? "bg-stone-100 text-stone-600"}`}
                          >
                            {ORDER_STATUS_LABELS[o.status] ?? o.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-stone-700">{formatMoney(o.total)}</td>
                        <td className="px-3 py-2 text-stone-600">
                          {o.deliveryMethod === "address"
                            ? "送貨"
                            : o.deliveryMethod === "sf_station"
                              ? "順豐站"
                              : "智能櫃"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-stone-500">
                          {formatTime(o.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-2">
                <button
                  onClick={() => setShowEdit(true)}
                  className="rounded-lg border border-stone-200 px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-50"
                >
                  修改資料
                </button>
                <button
                  onClick={() => setShowResetPw(true)}
                  className="rounded-lg border border-stone-200 px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-50"
                >
                  重設密碼
                </button>
              </div>
              {isAdmin && (
                <div>
                  {confirmDelete ? (
                    <span className="flex items-center gap-2 text-sm">
                      <span className="text-red-600">
                        {d.orderCount > 0
                          ? `會連埋 ${d.orderCount} 張訂單一齊刪除，確定？`
                          : "確定刪除呢個會員？"}
                      </span>
                      <button
                        onClick={() =>
                          removeMut.mutate({ id: d.user.id, alsoDeleteOrders: d.orderCount > 0 })
                        }
                        className="rounded-lg bg-red-500 px-3 py-1.5 text-white hover:bg-red-400"
                      >
                        確定刪除
                      </button>
                      <button
                        onClick={() => setConfirmDelete(false)}
                        className="rounded-lg border border-stone-200 px-3 py-1.5 text-stone-600"
                      >
                        取消
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-500 hover:bg-red-50"
                    >
                      刪除會員
                    </button>
                  )}
                </div>
              )}
            </div>

            {showEdit && (
              <EditMemberModal member={d.user} onClose={() => setShowEdit(false)} toast={toast} />
            )}
            {showResetPw && (
              <ResetPasswordModal
                member={d.user}
                onClose={() => setShowResetPw(false)}
                toast={toast}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 會員列表（員工＋管理員）
 * 2026-07-28：搜尋（名或電話）＋地址欄＋撳行睇詳情彈窗
 */
export default function MemberList({ toast }: { toast: (msg: string) => void }) {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [detailId, setDetailId] = useState<number | null>(null);
  const listQ = trpc.members.list.useQuery(search ? { q: search } : undefined);

  const rows = useMemo(() => (listQ.data ?? []) as MemberRow[], [listQ.data]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-stone-800">會員</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(q.trim());
          }}
          className="ml-auto flex gap-2"
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜尋名稱或電話"
            className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm"
          />
          <button
            type="submit"
            className="rounded-lg bg-stone-900 px-3 py-1.5 text-sm text-white hover:bg-stone-700"
          >
            搜尋
          </button>
          {search && (
            <button
              type="button"
              onClick={() => {
                setQ("");
                setSearch("");
              }}
              className="rounded-lg border border-stone-200 px-3 py-1.5 text-sm text-stone-500 hover:bg-stone-50"
            >
              清除
            </button>
          )}
        </form>
      </div>

      {listQ.isLoading ? (
        <div className="py-20 text-center text-stone-400">載入中…</div>
      ) : rows.length === 0 ? (
        <div className="py-20 text-center text-stone-400">
          {search ? `搵唔到「${search}」相關嘅會員` : "暫時冇會員"}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-stone-200">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-stone-50 text-left text-stone-500">
              <tr>
                <th className="px-3 py-2 font-medium">名稱</th>
                <th className="px-3 py-2 font-medium">電話</th>
                <th className="px-3 py-2 font-medium">地址</th>
                <th className="px-3 py-2 font-medium">Google</th>
                <th className="px-3 py-2 font-medium">推廣</th>
                <th className="px-3 py-2 font-medium">訂單</th>
                <th className="px-3 py-2 font-medium">消費</th>
                <th className="px-3 py-2 font-medium">註冊時間</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {rows.map((m) => (
                <tr
                  key={m.id}
                  onClick={() => setDetailId(m.id)}
                  className="cursor-pointer hover:bg-stone-50"
                >
                  <td className="px-3 py-2 font-medium text-stone-800">{m.name}</td>
                  <td className="px-3 py-2 text-stone-600">{m.phone}</td>
                  <td className="max-w-[220px] truncate px-3 py-2 text-stone-600">
                    {m.address ?? <span className="text-stone-300">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {m.googleLinked ? (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
                        已連結
                      </span>
                    ) : (
                      <span className="text-xs text-stone-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <MarketingOptInBadge
                      optIn={m.marketingOptIn}
                      promptedAt={m.marketingPromptedAt}
                      createdAt={m.createdAt}
                    />
                  </td>
                  <td className="px-3 py-2 text-stone-600">{m.orderCount}</td>
                  <td className="px-3 py-2 text-stone-600">{formatMoney(m.totalSpent)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-stone-500">
                    {formatTime(m.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detailId !== null && (
        <MemberDetailModal memberId={detailId} onClose={() => setDetailId(null)} toast={toast} />
      )}
    </div>
  );
}
