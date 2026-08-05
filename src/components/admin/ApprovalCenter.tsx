import { useState } from "react";
import { trpc } from "../../trpc";
import { useAuth } from "../../hooks/useAuth";

type ApprovalRow = {
  id: number;
  requesterId: number;
  action: string;
  payload: { input: Record<string, unknown>; before?: unknown };
  summary: string;
  status: string;
  reviewerId: number | null;
  reviewNote: string | null;
  createdAt: string | Date;
  reviewedAt: string | Date | null;
  requesterName: string;
  reviewerName: string | null;
};

function formatTime(iso: string | Date | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 欄位中文名（審批預覽用） */
const FIELD_LABELS: Record<string, string> = {
  name: "名稱",
  phone: "電話",
  email: "Email",
  address: "地址",
  age: "年齡",
  birthMonth: "生日月份",
  marketingOptIn: "接收推廣",
  sku: "SKU",
  description: "描述",
  image: "圖片",
  photos: "相簿",
  price: "價錢",
  discountPrice: "優惠價",
  sizes: "尺寸",
  sizeEnabled: "尺寸開關",
  delistEnabled: "定時下架開關",
  delistAt: "定時下架時間",
  note: "備註",
  category: "分類",
  stock: "庫存",
  caption: "說明",
  sortOrder: "排序",
  isActive: "上架中",
  code: "優惠碼",
  kind: "折扣類型",
  value: "折扣值",
  minSpend: "最低消費",
  usageLimit: "總使用次數上限",
  perUserLimit: "每人限用次數",
  expiresAt: "到期日",
  subject: "主旨",
  body: "內容",
  id: "ID",
};

/** 預覽時唔顯示嘅內部欄位 */
const HIDDEN_FIELDS = new Set(["id", "createdAt", "listedDate", "googleSub", "googleEmail", "googleName", "passwordHash", "role", "marketingOptInAt", "marketingPromptedAt", "dryRun", "usedCount"]);

function fieldLabel(k: string): string {
  return FIELD_LABELS[k] ?? k;
}

function formatValue(k: string, v: unknown): string {
  if (v === null || v === undefined) return "（空）";
  if (typeof v === "boolean") {
    if (k === "marketingOptIn") return v ? "接受" : "唔接受";
    if (k === "isActive" || k === "sizeEnabled" || k === "delistEnabled") return v ? "開" : "關";
    return v ? "係" : "否";
  }
  if (typeof v === "number") {
    // 金額欄位（分為單位）
    if (["price", "discountPrice", "minSpend"].includes(k)) return `$${(v / 100).toFixed(0)}`;
    if (k === "value") return String(v);
    return String(v);
  }
  if (typeof v === "string") {
    // 日期字串
    if ((k === "delistAt" || k === "expiresAt") && v) {
      return formatTime(v);
    }
    return v;
  }
  if (Array.isArray(v)) return v.join("、");
  return JSON.stringify(v);
}

/** 審批預覽（2026-08-06 Glo 要求：批准前要完整預覽將會執行嘅內容） */
function RequestPreview({ req }: { req: ApprovalRow }) {
  const p = req.payload;
  const input = (p?.input ?? {}) as Record<string, unknown>;
  const before = (p?.before ?? null) as Record<string, unknown> | null;

  // 刪除類：完整顯示現有資料（將會刪除嘅內容）
  const isRemove = req.action.endsWith(".remove");
  // 修改類：before vs after 對照
  const isUpdate = req.action.endsWith(".update") && before;

  if (isRemove && before) {
    return (
      <div className="mt-2 rounded-lg bg-red-50 p-3">
        <div className="mb-1 text-xs font-semibold text-red-600">將會刪除嘅完整資料：</div>
        <dl className="space-y-0.5 text-xs">
          {Object.entries(before)
            .filter(([k]) => !HIDDEN_FIELDS.has(k))
            .map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="w-24 shrink-0 text-stone-500">{fieldLabel(k)}</dt>
                <dd className="break-all text-stone-800">{formatValue(k, v)}</dd>
              </div>
            ))}
        </dl>
      </div>
    );
  }

  if (isUpdate) {
    const changedKeys = Object.keys(input).filter((k) => k !== "id" && !HIDDEN_FIELDS.has(k));
    return (
      <div className="mt-2 rounded-lg bg-amber-50 p-3">
        <div className="mb-1 text-xs font-semibold text-amber-700">改動對照（改前 → 改後）：</div>
        <dl className="space-y-1 text-xs">
          {changedKeys.map((k) => (
            <div key={k} className="flex gap-2">
              <dt className="w-24 shrink-0 text-stone-500">{fieldLabel(k)}</dt>
              <dd className="break-all">
                <span className="text-stone-400 line-through">{formatValue(k, before[k])}</span>
                <span className="mx-1 text-stone-400">→</span>
                <span className="font-medium text-stone-800">{formatValue(k, input[k])}</span>
              </dd>
            </div>
          ))}
          {changedKeys.length === 0 && (
            <div className="text-stone-400">（冇實際改動欄位）</div>
          )}
        </dl>
      </div>
    );
  }

  // 新增／寄電郵類：顯示將會建立／執行嘅完整內容
  const entries = Object.entries(input).filter(([k]) => k !== "id" && !HIDDEN_FIELDS.has(k));
  return (
    <div className="mt-2 rounded-lg bg-green-50 p-3">
      <div className="mb-1 text-xs font-semibold text-green-700">
        {req.action === "promo.sendMarketingEmail" ? "將會寄出嘅電郵內容：" : "將會新增嘅完整資料："}
      </div>
      <dl className="space-y-0.5 text-xs">
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="w-24 shrink-0 text-stone-500">{fieldLabel(k)}</dt>
            <dd className="whitespace-pre-wrap break-all text-stone-800">{formatValue(k, v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** 單張審批單（待審批列表用） */
function PendingCard({
  req,
  onDone,
  toast,
}: {
  req: ApprovalRow;
  onDone: () => void;
  toast: (msg: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState("");
  const utils = trpc.useUtils();

  const approveMut = trpc.approvals.approve.useMutation({
    onSuccess: () => {
      toast(`已批准 #${req.id}，操作已執行`);
      void utils.approvals.invalidate();
      onDone();
    },
    onError: (e) => toast(`批准失敗：${e.message}`),
  });

  const rejectMut = trpc.approvals.reject.useMutation({
    onSuccess: () => {
      toast(`已拒絕 #${req.id}`);
      void utils.approvals.invalidate();
      onDone();
    },
    onError: (e) => toast(`拒絕失敗：${e.message}`),
  });

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <span className="font-mono text-xs text-stone-400">#{req.id}</span>
          <span className="ml-2 font-medium text-stone-800">{req.summary}</span>
          <div className="mt-1 text-xs text-stone-500">
            {req.requesterName} 提交於 {formatTime(req.createdAt)}
          </div>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="rounded-lg border border-stone-200 px-3 py-1 text-xs text-stone-600 hover:bg-stone-50"
        >
          {expanded ? "收起預覽" : "完整預覽"}
        </button>
      </div>

      {expanded && <RequestPreview req={req} />}

      {expanded && (
        <div className="mt-3 space-y-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="備註（拒絕必填原因，選填）"
            maxLength={200}
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              disabled={approveMut.isPending || rejectMut.isPending}
              onClick={() => {
                if (window.confirm(`確定批准並執行「${req.summary}」？`)) {
                  approveMut.mutate({ id: req.id, note: note || undefined });
                }
              }}
              className="rounded-lg bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-500 disabled:opacity-50"
            >
              {approveMut.isPending ? "執行中…" : "✓ 批准並執行"}
            </button>
            <button
              disabled={approveMut.isPending || rejectMut.isPending}
              onClick={() => {
                if (!note.trim()) {
                  toast("拒絕要填原因");
                  return;
                }
                if (window.confirm(`確定拒絕「${req.summary}」？`)) {
                  rejectMut.mutate({ id: req.id, note: note.trim() });
                }
              }}
              className="rounded-lg bg-red-500 px-4 py-2 text-sm text-white hover:bg-red-400 disabled:opacity-50"
            >
              {rejectMut.isPending ? "處理中…" : "✕ 拒絕"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 審批中心（2026-08-06 Glo 要求）：主管／管理員專用。
 * 員工（staff）喺後台做五類敏感操作時會喺度排隊等批准；
 * approve＝以審批人身份即時執行原操作；reject＝唔執行，原因話返俾員工知。
 */
export default function ApprovalCenter({ toast }: { toast: (msg: string) => void }) {
  const { isSupervisor } = useAuth();
  const [tab, setTab] = useState<"pending" | "history">("pending");

  const pendingQ = trpc.approvals.pendingList.useQuery(undefined, {
    enabled: isSupervisor,
    refetchInterval: 30000,
  });
  const historyQ = trpc.approvals.history.useQuery(undefined, {
    enabled: isSupervisor && tab === "history",
  });

  if (!isSupervisor) {
    return <div className="py-20 text-center text-stone-400">只有主管或管理員可以睇審批中心</div>;
  }

  const pending = (pendingQ.data ?? []) as ApprovalRow[];
  const history = (historyQ.data ?? []) as ApprovalRow[];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-stone-800">審批中心</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setTab("pending")}
            className={`rounded-full px-4 py-1.5 text-sm ${tab === "pending" ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"}`}
          >
            待審批（{pending.length}）
          </button>
          <button
            onClick={() => setTab("history")}
            className={`rounded-full px-4 py-1.5 text-sm ${tab === "history" ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"}`}
          >
            處理紀錄
          </button>
          <button
            onClick={() => {
              void pendingQ.refetch();
              if (tab === "history") void historyQ.refetch();
            }}
            className="rounded-lg border border-stone-200 px-3 py-1 text-sm text-stone-500 hover:bg-stone-50"
          >
            重新整理
          </button>
        </div>
      </div>

      {tab === "pending" ? (
        pendingQ.isLoading ? (
          <div className="py-20 text-center text-stone-400">載入中…</div>
        ) : pending.length === 0 ? (
          <div className="py-20 text-center text-stone-400">暫時冇待審批嘅請求 🎉</div>
        ) : (
          <div className="space-y-3">
            {pending.map((r) => (
              <PendingCard key={r.id} req={r} toast={toast} onDone={() => void pendingQ.refetch()} />
            ))}
          </div>
        )
      ) : historyQ.isLoading ? (
        <div className="py-20 text-center text-stone-400">載入中…</div>
      ) : history.length === 0 ? (
        <div className="py-20 text-center text-stone-400">暫時冇處理紀錄</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-stone-200">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-stone-50 text-left text-stone-500">
              <tr>
                <th className="px-3 py-2 font-medium">單號</th>
                <th className="px-3 py-2 font-medium">內容</th>
                <th className="px-3 py-2 font-medium">請求人</th>
                <th className="px-3 py-2 font-medium">結果</th>
                <th className="px-3 py-2 font-medium">審批人</th>
                <th className="px-3 py-2 font-medium">時間</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {history.map((r) => (
                <tr key={r.id} className="hover:bg-stone-50">
                  <td className="px-3 py-2 font-mono text-xs text-stone-400">#{r.id}</td>
                  <td className="px-3 py-2 text-stone-700">
                    {r.summary}
                    {r.reviewNote && (
                      <div className="mt-0.5 text-xs text-stone-400">備註：{r.reviewNote}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-stone-600">{r.requesterName}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${r.status === "approved" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}
                    >
                      {r.status === "approved" ? "已批准" : "已拒絕"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-stone-600">{r.reviewerName ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-stone-500">{formatTime(r.reviewedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
