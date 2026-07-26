import { useMemo } from 'react';
import { BarChart3 } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { fmtHKD } from './format';
import { LoadingBlock } from './WishingStar';
import ExportCard from './ExportCard';
import SettingsCard from './SettingsCard';
import type { ToastKind } from './useToasts';

/**
 * 業務分析（F-G，admin only）—— 純 CSS 圖表，零新 dependency
 * - KPI 卡列：今日訂單／今日營業額／累計營業額／待審批／待出貨／已完成／會員數／優惠碼使用
 * - 近 14 日營收 + 訂單雙系列 CSS bar chart（每柱 title 顯示日期+數字）
 * - 熱賣商品 Top 8 表（排名/品名/貨號/件數/金額）
 * - 每日數據導出卡（F-F）+ 商品頁介紹設定卡（F-C）
 * 後端 analyticsRouter 未 merge 前 tsc 會報 does not exist（預期），本地型別同 spec §B3 契約一致。
 */

/** analyticsRouter 未 merge 前嘅本地型別（同 spec §B3 契約一致） */
type AnalyticsSummary = {
  todayOrders: number;
  todayRevenue: number;
  totalOrders: number;
  totalRevenue: number;
  pendingReview: number;
  toShip: number;
  doneCount: number;
  cancelledCount: number;
  rejectedCount: number;
  memberCount: number;
  promoUsedCount: number;
};

type DailyPoint = { date: string; orders: number; revenue: number };

type TopProductRow = { productId: number; name: string; sku: string; units: number; revenue: number };

const cardStyle = {
  borderColor: 'var(--glass-border)',
  background: 'var(--glass-bg)',
} as const;

export default function AnalyticsManager({
  toast,
}: {
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const summaryQuery = trpc.analytics.summary.useQuery(undefined);
  const seriesQuery = trpc.analytics.dailySeries.useQuery({ days: 14 });
  const topQuery = trpc.analytics.topProducts.useQuery({ limit: 8 });

  const summary = summaryQuery.data as AnalyticsSummary | undefined;
  const series = useMemo(
    () => (seriesQuery.data ?? []) as DailyPoint[],
    [seriesQuery.data],
  );
  const topProducts = useMemo(
    () => (topQuery.data ?? []) as TopProductRow[],
    [topQuery.data],
  );

  const maxRevenue = useMemo(() => Math.max(1, ...series.map((d) => d.revenue)), [series]);
  const maxOrders = useMemo(() => Math.max(1, ...series.map((d) => d.orders)), [series]);

  const KPIS: { label: string; value: string; color: string }[] = summary
    ? [
        { label: '今日訂單', value: String(summary.todayOrders), color: 'var(--starlight)' },
        { label: '今日營業額', value: fmtHKD(summary.todayRevenue), color: 'var(--pink)' },
        { label: '累計營業額', value: fmtHKD(summary.totalRevenue), color: 'var(--pink-soft)' },
        { label: '待審批', value: String(summary.pendingReview), color: 'var(--gold)' },
        { label: '待出貨', value: String(summary.toShip), color: 'var(--lavender)' },
        { label: '已完成', value: String(summary.doneCount), color: 'var(--success)' },
        { label: '會員數', value: String(summary.memberCount), color: 'var(--starlight)' },
        { label: '優惠碼使用', value: String(summary.promoUsedCount), color: 'var(--gold)' },
      ]
    : [];

  return (
    <div className="flex flex-col gap-6">
      {/* KPI 卡列 */}
      <section
        className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
        style={cardStyle}
        aria-label="業務指標"
      >
        <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
          <BarChart3 size={16} aria-hidden="true" className="text-pink" />
          業務概覽
        </h3>
        {summaryQuery.isLoading ? (
          <LoadingBlock text="許願星搬緊數據…" />
        ) : summaryQuery.isError ? (
          <p className="py-8 text-center text-[14px] text-pink-soft">
            載入業務數據失敗：{summaryQuery.error.message}
          </p>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            {KPIS.map((k) => (
              <div
                key={k.label}
                className="rounded-xl border px-4 py-3.5"
                style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
              >
                <p className="text-[12px] text-txt-3">{k.label}</p>
                <p
                  className="mt-1 truncate font-mono text-[20px] leading-none md:text-[24px]"
                  style={{ color: k.color }}
                >
                  {k.value}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 近 14 日趨勢（純 CSS 雙系列 bar chart） */}
      <section className="rounded-2xl border p-5 backdrop-blur-xl md:p-6" style={cardStyle}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[15px] font-bold text-txt-1">近 14 日趨勢</h3>
          <p className="flex items-center gap-4 text-[12px] text-txt-3">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: 'var(--pink)' }} aria-hidden="true" />
              營業額
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: 'var(--lavender)' }} aria-hidden="true" />
              訂單
            </span>
          </p>
        </div>
        {seriesQuery.isLoading ? (
          <LoadingBlock text="許願星搬緊趨勢…" />
        ) : seriesQuery.isError ? (
          <p className="py-8 text-center text-[14px] text-pink-soft">
            載入趨勢失敗：{seriesQuery.error.message}
          </p>
        ) : series.length === 0 ? (
          <p className="py-8 text-center text-[14px] text-txt-3">近 14 日冇訂單數據。</p>
        ) : (
          <div className="mt-5">
            <div className="flex h-44 items-end gap-1 md:gap-1.5" role="img" aria-label="近 14 日營業額同訂單量柱狀圖">
              {series.map((d) => (
                <div
                  key={d.date}
                  className="flex h-full min-w-0 flex-1 items-end justify-center gap-0.5"
                  title={`${d.date} · 訂單 ${d.orders} 張 · 營業額 ${fmtHKD(d.revenue)}`}
                >
                  <div
                    className="w-1/2 rounded-t-sm"
                    style={{
                      height: `${Math.max((d.revenue / maxRevenue) * 100, d.revenue > 0 ? 2 : 0)}%`,
                      background: 'var(--pink)',
                      minHeight: d.revenue > 0 ? 2 : 0,
                    }}
                  />
                  <div
                    className="w-1/2 rounded-t-sm"
                    style={{
                      height: `${Math.max((d.orders / maxOrders) * 100, d.orders > 0 ? 2 : 0)}%`,
                      background: 'var(--lavender)',
                      minHeight: d.orders > 0 ? 2 : 0,
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-1.5 flex gap-1 md:gap-1.5" aria-hidden="true">
              {series.map((d) => (
                <p key={d.date} className="min-w-0 flex-1 truncate text-center font-mono text-[10px] text-txt-3">
                  {d.date.slice(5)}
                </p>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 熱賣商品 Top 8 */}
      <section className="rounded-2xl border p-5 backdrop-blur-xl md:p-6" style={cardStyle}>
        <h3 className="text-[15px] font-bold text-txt-1">熱賣商品 Top 8</h3>
        {topQuery.isLoading ? (
          <LoadingBlock text="許願星搬緊熱賣榜…" />
        ) : topQuery.isError ? (
          <p className="py-8 text-center text-[14px] text-pink-soft">
            載入熱賣商品失敗：{topQuery.error.message}
          </p>
        ) : topProducts.length === 0 ? (
          <p className="py-8 text-center text-[14px] text-txt-3">暫時冇銷售數據。</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-[14px]">
              <thead>
                <tr className="border-b text-left text-[12px] text-txt-3" style={{ borderColor: 'var(--space-line)' }}>
                  <th className="w-12 py-2 pr-3 font-normal">排名</th>
                  <th className="py-2 pr-3 font-normal">品名</th>
                  <th className="py-2 pr-3 font-normal">貨號</th>
                  <th className="w-16 py-2 pr-3 text-right font-normal">件數</th>
                  <th className="w-28 py-2 text-right font-normal">金額</th>
                </tr>
              </thead>
              <tbody>
                {topProducts.map((p, i) => (
                  <tr
                    key={p.productId}
                    className="border-b last:border-0"
                    style={{ borderColor: 'var(--space-line)' }}
                  >
                    <td className="py-2.5 pr-3 font-mono text-[13px]" style={{ color: i < 3 ? 'var(--gold)' : 'var(--text-3)' }}>
                      {i + 1}
                    </td>
                    <td className="max-w-0 truncate py-2.5 pr-3 text-txt-1">{p.name}</td>
                    <td className="py-2.5 pr-3 font-mono text-[13px] text-txt-3">{p.sku}</td>
                    <td className="py-2.5 pr-3 text-right font-mono text-[13px] text-txt-2">{p.units}</td>
                    <td className="py-2.5 text-right font-mono text-[13px] text-pink">{fmtHKD(p.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 每日數據導出（F-F） */}
      <ExportCard />

      {/* 商品頁介紹設定（F-C） */}
      <SettingsCard toast={toast} />
    </div>
  );
}
