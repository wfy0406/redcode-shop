import { useState } from "react";
import { trpc } from "../../trpc";
import { useAuth } from "../../hooks/useAuth";

/** 已同意推廣會員數（後台促銷電郵卡用，2026-08-05 Glo 要求） */
function useOptedInCount(enabled: boolean) {
  return trpc.members.list.useQuery(undefined, {
    enabled,
    select: (rows) => rows.filter((r) => r.marketingOptIn).length,
  });
}

/**
 * 促銷電郵卡（2026-08-05 Glo 要求）：寄推廣電郵畀已同意接收嘅會員。
 * PDPO 第 6 部：只寄 marketingOptIn=true 兼有 email 嘅會員；寄之前會顯示收件人數，
 * 並彈確認窗（首次用預覽模式拎數）。冇設 RESEND_API_KEY 後端會 FORBIDDEN。
 */
export default function MarketingEmailCard({ toast }: { toast: (msg: string) => void }) {
  const { isAdmin, isSupervisor } = useAuth();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const optedInQ = useOptedInCount(open);

  const sendMut = trpc.promo.sendMarketingEmail.useMutation({
    onSuccess: (r) => {
      // 員工操作需審批（2026-08-06 Glo 要求）：staff 會收到 pendingApproval＋requestId
      if ("pendingApproval" in r && r.pendingApproval) {
        toast(`已提交審批（#${r.requestId}），等主管/管理員批准後先會寄出`);
        setSubject("");
        setBody("");
        setOpen(false);
        return;
      }
      if ("sent" in r) {
        toast(
          r.failed > 0
            ? `已寄出 ${r.sent}/${r.recipientCount} 封（${r.failed} 封失敗）`
            : `已成功寄出 ${r.sent} 封促銷電郵`,
        );
        setSubject("");
        setBody("");
        setOpen(false);
      }
    },
    onError: (e) => toast(`寄出失敗：${e.message}`),
  });

  // 只有管理員＋主管見到（後端 adminProcedure 照擋）
  if (!isAdmin && !isSupervisor) return null;

  const recipientCount = optedInQ.data ?? 0;

  return (
    <div className="mb-6 rounded-xl border border-pink-200 bg-pink-50/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-stone-800">促銷電郵</h3>
          <p className="mt-0.5 text-xs text-stone-500">
            只會寄畀已同意接收推廣嘅會員（而家 {recipientCount} 人），每封附退訂方法，符合 PDPO 要求
          </p>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg bg-pink-500 px-4 py-2 text-sm font-medium text-white hover:bg-pink-400"
        >
          {open ? "收起" : "撰寫促銷電郵"}
        </button>
      </div>

      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (
              window.confirm(
                `確定寄出畀 ${recipientCount} 個已同意會員？\n主旨：${subject}`,
              )
            ) {
              sendMut.mutate({ subject, body });
            }
          }}
          className="mt-4 space-y-3"
        >
          <div>
            <label className="mb-1 block text-xs font-medium text-stone-600">主旨</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required
              maxLength={120}
              placeholder="例如：Red Code 夏日新貨上架 全單 95 折"
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-stone-600">
              內容（支援簡單換行；會自動加公司署名同退訂說明）
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              required
              rows={6}
              maxLength={5000}
              placeholder={"例如：\n親愛嘅顧客：\n\n今個星期新貨上架，全單 95 折，優惠碼 SUMMER95，今個星期日截單！\n\nRed Code 敬上"}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={sendMut.isPending || recipientCount === 0}
              className="rounded-lg bg-pink-500 px-4 py-2 text-sm font-medium text-white hover:bg-pink-400 disabled:opacity-50"
            >
              {sendMut.isPending ? "寄出中…" : `寄出畀 ${recipientCount} 個會員`}
            </button>
            {recipientCount === 0 && (
              <span className="text-xs text-stone-500">暫時冇已同意接收推廣嘅會員</span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
