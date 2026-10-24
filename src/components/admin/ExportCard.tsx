import { useState } from 'react';
import { Download } from 'lucide-react';
import { trpc } from '@/providers/trpc';

/**
 * 每日數據導出卡（F-F）—— date input 預設今日 HKT +「導出 Excel」掣
 * P2-4（2026-10 安全修復）：唔再將 JWT 放 URL query（會留 server log／瀏覽器歷史）。
 * 改兩步：先 call trpc.analytics.exportDailyTicket 攞 60 秒一次性 ticket，
 * 再帶 ticket 去 /api/export/daily?date=...&ticket=...（ticket 用一次即棄）。
 * M4（2026-10-24 安全覆核）：唔喺 async onSuccess 先 window.open——Safari 會當佢
 * 係非手勢彈窗靜靜雞擋咗。改 programmatic <a download> 同頁觸發下載；
 * server 回 Content-Disposition: attachment，唔會跳走現有頁面。
 * staff 喺 OrderList view 底見到、admin 喺業務分析（AnalyticsManager）底都見到。
 */

/** 今日日期（HKT UTC+8），YYYY-MM-DD */
function todayHKT(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export default function ExportCard() {
  const [date, setDate] = useState(todayHKT);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const ticketMutation = trpc.analytics.exportDailyTicket.useMutation({
    onSuccess: (r, d) => {
      // M4：programmatic <a download> 同頁下載（Safari 唔會擋）；一次性 ticket 照舊，JWT 唔入 URL
      const a = document.createElement('a');
      a.href = `/api/export/daily?date=${d.date}&ticket=${encodeURIComponent(r.ticket)}`;
      a.download = `RedCode-ops-${d.date}.xlsx`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    onError: (err) => setErrorMsg(err.message || '導出準備失敗，請再試'),
  });

  const exportExcel = () => {
    if (!date) return;
    setErrorMsg(null);
    ticketMutation.mutate({ date });
  };

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
        <Download size={16} aria-hidden="true" className="text-lavender" />
        每日數據導出
      </h3>
      <p className="mt-1.5 text-[13px] text-txt-3">
        導出指定日期（香港時間）嘅營運數據 Excel，已取消／已拒絕嘅訂單唔會包括在內。
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label="導出日期"
          className="h-11 rounded-xl border border-space-line bg-space-2 px-4 font-mono text-[14px] text-txt-1 focus:border-pink"
        />
        <button
          type="button"
          onClick={exportExcel}
          disabled={!date || ticketMutation.isPending}
          className="btn btn-primary !px-6 !py-2.5 text-[14px] disabled:opacity-60"
        >
          <Download size={15} aria-hidden="true" />
          {ticketMutation.isPending ? '準備中…' : '導出 Excel'}
        </button>
      </div>
      {errorMsg ? (
        <p className="mt-3 text-[14px] text-red-300" role="alert">
          {errorMsg}
        </p>
      ) : null}
    </section>
  );
}
