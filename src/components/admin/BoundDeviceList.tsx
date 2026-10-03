import { useMemo, useState } from 'react';
import { Search, Smartphone, X } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { fmtDateTime } from './format';
import { LoadingBlock } from './WishingStar';

/**
 * v2.2.43（老闆指令）：後台「綁定手機清單」——
 * 全店已訂閱直播推送嘅裝置一覽：客戶名／幾時綁定／裝置廠牌／用咩瀏覽器，
 * 唔使逐個會員入詳情先睇到。數據：trpc.members.adminListPushDevices。
 * 純唯讀清單（冇任何修改動作）；訂閱內容（endpoint/keys）後端根本唔會回嚟。
 * 搜尋係 client-side 即時篩（清單 ≤500 行，唔使打 server）。
 */

type BoundDeviceRow = {
  id: number;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  brand: string;
  browser: string;
  boundAt: string;
  lastSentAt: string | null;
};

export default function BoundDeviceList() {
  const [q, setQ] = useState('');
  const listQuery = trpc.members.adminListPushDevices.useQuery(undefined, {
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const rows = useMemo(() => (listQuery.data ?? []) as BoundDeviceRow[], [listQuery.data]);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return rows;
    return rows.filter((r) =>
      [r.customerName, r.customerPhone ?? '', r.customerEmail ?? '']
        .join(' ')
        .toLowerCase()
        .includes(kw),
    );
  }, [rows, q]);

  // 概要：總綁定裝置數 ＋ 覆蓋客戶數（同名同電話當同一客）
  const customerCount = useMemo(
    () => new Set(rows.map((r) => `${r.customerName}|${r.customerPhone ?? ''}`)).size,
    [rows],
  );

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
        <Smartphone size={16} aria-hidden="true" className="text-lavender" />
        綁定手機
        {!listQuery.isLoading && !listQuery.isError && (
          <span className="font-mono text-[13px] font-normal text-txt-3">
            （{rows.length} 部裝置・{customerCount} 位客戶{q ? `・${filtered.length} 個結果` : ''}）
          </span>
        )}
      </h3>
      <p className="mt-1 text-[12px] text-txt-3">
        已開啟「直播開播通知」嘅裝置一覽——客戶名、綁定時間、裝置廠牌、瀏覽器。
      </p>

      {/* 搜尋：名、電話或 email */}
      <div className="relative mt-3">
        <Search
          size={15}
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-txt-3"
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="輸入客戶名、電話或 email 搜尋…"
          aria-label="搜尋綁定裝置（客戶名、電話或 email）"
          className="w-full rounded-xl border bg-transparent py-2 pl-9 pr-9 text-[14px] text-txt-1 outline-none transition-colors placeholder:text-txt-3 focus:border-lavender"
          style={{ borderColor: 'var(--space-line)' }}
        />
        {q && (
          <button
            type="button"
            onClick={() => setQ('')}
            aria-label="清除搜尋"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-txt-3 transition-colors hover:text-txt-1"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {listQuery.isLoading ? (
        <LoadingBlock text="許願星搬緊綁定清單…" />
      ) : listQuery.isError ? (
        <p className="py-8 text-center text-[14px] text-pink-soft">
          載入失敗：{listQuery.error.message}
        </p>
      ) : filtered.length === 0 ? (
        <p className="py-8 text-center text-[14px] text-txt-3">
          {q ? '搵唔到符合嘅綁定裝置。' : '暫時未有客戶綁定手機。'}
        </p>
      ) : (
        <>
          {/* 桌面版：表格 */}
          <div className="mt-4 hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[760px] border-collapse text-[14px]">
              <thead>
                <tr className="text-left text-[12px] tracking-[0.08em] text-txt-3">
                  <th className="py-2 pr-3 font-normal">客戶</th>
                  <th className="py-2 pr-3 font-normal">裝置廠牌</th>
                  <th className="py-2 pr-3 font-normal">瀏覽器</th>
                  <th className="py-2 pr-3 font-normal">綁定時間</th>
                  <th className="py-2 font-normal">最近推送</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="border-t" style={{ borderColor: 'var(--space-line)' }}>
                    <td className="py-2.5 pr-3">
                      <span className="font-medium text-txt-1">{r.customerName}</span>
                      <span className="mt-0.5 block font-mono text-[12px] text-txt-3">
                        {r.customerPhone || r.customerEmail || '—'}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-txt-1">{r.brand}</td>
                    <td className="py-2.5 pr-3 text-txt-2">{r.browser}</td>
                    <td className="py-2.5 pr-3 font-mono text-[13px] text-txt-2">
                      {fmtDateTime(r.boundAt)}
                    </td>
                    <td className="py-2.5 font-mono text-[13px] text-txt-3">
                      {r.lastSentAt ? fmtDateTime(r.lastSentAt) : '未推過'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 手機版：逐部一卡 */}
          <ul className="mt-4 space-y-3 lg:hidden">
            {filtered.map((r) => (
              <li
                key={r.id}
                className="rounded-xl border p-3.5"
                style={{ borderColor: 'var(--space-line)' }}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-txt-1">{r.customerName}</span>
                  <span className="font-mono text-[12px] text-txt-3">
                    {r.customerPhone || r.customerEmail || ''}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                  <span className="text-txt-1">{r.brand}</span>
                  <span className="text-txt-2">{r.browser}</span>
                </div>
                <div className="mt-2 font-mono text-[12px] text-txt-3">
                  綁定 {fmtDateTime(r.boundAt)}
                  {r.lastSentAt ? `・最近推送 ${fmtDateTime(r.lastSentAt)}` : '・未推過'}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
