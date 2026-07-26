import { useState } from 'react';
import { Download } from 'lucide-react';
import { getToken } from '@/lib/auth';

/**
 * 每日數據導出卡（F-F）—— date input 預設今日 HKT +「導出 Excel」掣
 * 經 window.open 打開 /api/export/daily?date=...&token=...（<a download> 加唔到 header，
 * 所以後端唔單止睇 Authorization Bearer，都睇 ?token= query；後端 route 係 staff+admin）。
 * staff 喺 OrderList view 底見到、admin 喺業務分析（AnalyticsManager）底都見到。
 */

/** 今日日期（HKT UTC+8），YYYY-MM-DD */
function todayHKT(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export default function ExportCard() {
  const [date, setDate] = useState(todayHKT);

  const exportExcel = () => {
    if (!date) return;
    window.open(`/api/export/daily?date=${date}&token=${getToken() ?? ''}`, '_blank');
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
          disabled={!date}
          className="btn btn-primary !px-6 !py-2.5 text-[14px] disabled:opacity-60"
        >
          <Download size={15} aria-hidden="true" />
          導出 Excel
        </button>
      </div>
    </section>
  );
}
