import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Clock3, Globe, Search, Send, Smartphone, X } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { fmtDateTime } from './format';
import { LoadingBlock } from './WishingStar';

/**
 * v2.2.43（老闆指令）：後台「綁定手機清單」——
 * 全店已訂閱直播推送嘅裝置一覽：客戶名／幾時綁定／裝置廠牌／用咩瀏覽器。
 * v2.2.44（老闆指令）升級：
 * - Android 廠牌用 sec-ch-ua-model（Chrome 凍結咗 UA 型號）；有型號喺廠牌下細字顯示
 * - 撳任何一行彈方塊睇該機推送紀錄（成功／失敗＋原因），50 筆一頁
 * v2.2.45（老闆截圖嫌醜）：手機卡重排——名＋格式化電話做主行、廠牌/瀏覽器改
 * icon chip、時間加 icon、右邊 chevron 提示可以撳；電話 HK 格式 XXXX XXXX。
 * 純唯讀；訂閱敏感內容（endpoint/keys）後端根本唔會回嚟。
 */

/** 香港電話格式化：8 位 → XXXX XXXX；852 開頭 11 位 → 852 XXXX XXXX；其他原樣 */
function fmtPhone(p: string | null): string {
  if (!p) return '';
  const d = p.replace(/\D/g, '');
  if (/^852\d{8}$/.test(d)) return `852 ${d.slice(3, 7)} ${d.slice(7)}`;
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)} ${d.slice(4)}`;
  return p;
}

type BoundDeviceRow = {
  id: number;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  brand: string;
  browser: string;
  model: string | null;
  boundAt: string;
  lastSentAt: string | null;
};

type DeliveryRow = {
  id: number;
  ok: boolean;
  reason: string | null;
  sentAt: string;
  // v2.2.49（老闆指令）：中獎推送都落 pushDeliveries（campaignId null）——三欄可 null
  campaignTitle: string | null;
  liveDate: string | null;
  liveSession: string | null;
};

type DeliveryPage = {
  page: number;
  pageSize: number;
  hasMore: boolean;
  rows: DeliveryRow[];
};

/** 失敗原因類別 → 中文（後端淨落類別：gone／http_<code>／unknown） */
function reasonLabel(reason: string | null): string {
  if (!reason) return '失敗';
  if (reason === 'gone') return '訂閱失效（已自動停用）';
  if (reason.startsWith('http_')) return `發送失敗（HTTP ${reason.slice(5)}）`;
  return '發送失敗（未知錯誤）';
}

function DeviceDeliveriesModal({
  device,
  onClose,
}: {
  device: BoundDeviceRow;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const query = trpc.members.adminListDeviceDeliveries.useQuery(
    { deviceId: device.id, page },
    { retry: false, placeholderData: (prev) => prev },
  );
  const data = query.data as DeliveryPage | undefined;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: 'rgba(4,2,10,0.82)' }}
      onClick={onClose}
      role="dialog"
      aria-label={`${device.customerName} 嘅裝置推送紀錄`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[82vh] w-full max-w-lg flex-col rounded-2xl border backdrop-blur-xl"
        style={{ borderColor: 'var(--glass-border)', background: 'var(--space-2)' }}
      >
        {/* 頭：客戶＋裝置資料 */}
        <div className="flex items-start justify-between gap-3 border-b p-5 pb-4" style={{ borderColor: 'var(--space-line)' }}>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-bold text-txt-1">{device.customerName}</p>
            <p className="mt-0.5 text-[13px] text-txt-2">
              {device.brand}
              {device.model ? `（${device.model}）` : ''}・{device.browser}
            </p>
            <p className="mt-0.5 font-mono text-[12px] text-txt-3">
              綁定於 {fmtDateTime(device.boundAt)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="收返"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-txt-2 transition-colors hover:text-txt-1"
            style={{ borderColor: 'var(--space-line)' }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {/* 身：推送紀錄（最新排前） */}
        <div className="min-h-[120px] flex-1 overflow-y-auto px-5 py-3">
          {query.isLoading ? (
            <LoadingBlock text="許願星搬緊推送紀錄…" />
          ) : query.isError ? (
            <p className="py-8 text-center text-[14px] text-pink-soft">
              載入失敗：{query.error.message}
            </p>
          ) : !data || data.rows.length === 0 ? (
            <p className="py-8 text-center text-[14px] text-txt-3">
              未有推送紀錄。（紀錄由功能上線後開始計）
            </p>
          ) : (
            <ul className="divide-y" style={{ borderColor: 'var(--space-line)' }}>
              {data.rows.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-txt-1">
                      {r.campaignTitle === null ? '🎉 中獎通知' : `${r.liveDate} 第${r.liveSession}場`}
                    </p>
                    <p className="mt-0.5 font-mono text-[12px] text-txt-3">
                      {fmtDateTime(r.sentAt)}
                    </p>
                  </div>
                  {r.ok ? (
                    <span
                      className="shrink-0 rounded-full border px-2.5 py-0.5 text-[12px] font-bold"
                      style={{ borderColor: 'rgba(52,211,153,0.4)', color: '#34D399' }}
                    >
                      成功
                    </span>
                  ) : (
                    <span
                      className="shrink-0 rounded-full border px-2.5 py-0.5 text-[12px] font-bold"
                      style={{ borderColor: 'rgba(255,0,84,0.4)', color: 'var(--pink-tint)' }}
                      title={reasonLabel(r.reason)}
                    >
                      {reasonLabel(r.reason)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 腳：50 筆一頁分頁 */}
        <div
          className="flex items-center justify-between border-t px-5 py-3"
          style={{ borderColor: 'var(--space-line)' }}
        >
          <button
            type="button"
            disabled={page <= 1 || query.isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-[13px] text-txt-2 transition-colors hover:text-txt-1 disabled:opacity-35"
            style={{ borderColor: 'var(--space-line)' }}
          >
            <ChevronLeft size={14} aria-hidden="true" />
            上一頁
          </button>
          <span className="font-mono text-[12px] text-txt-3">
            第 {page} 頁・每頁 50 筆
          </span>
          <button
            type="button"
            disabled={!data?.hasMore || query.isFetching}
            onClick={() => setPage((p) => p + 1)}
            className="inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-[13px] text-txt-2 transition-colors hover:text-txt-1 disabled:opacity-35"
            style={{ borderColor: 'var(--space-line)' }}
          >
            下一頁
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function BoundDeviceList() {
  const [q, setQ] = useState('');
  const [openDevice, setOpenDevice] = useState<BoundDeviceRow | null>(null);
  const listQuery = trpc.members.adminListPushDevices.useQuery(undefined, {
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const rows = (listQuery.data ?? []) as BoundDeviceRow[];

  const kw = q.trim().toLowerCase();
  const filtered = kw
    ? rows.filter((r) =>
        [r.customerName, r.customerPhone ?? '', r.customerEmail ?? '']
          .join(' ')
          .toLowerCase()
          .includes(kw),
      )
    : rows;

  // 概要：總綁定裝置數 ＋ 覆蓋客戶數（同名同電話當同一客）
  const customerCount = new Set(rows.map((r) => `${r.customerName}|${r.customerPhone ?? ''}`)).size;

  // 行撳落去開推送紀錄彈窗（跟 MemberList 慣例：tr onClick＋cursor-pointer）
  const rowClass = 'cursor-pointer transition-colors hover:bg-white/5';

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
        已開啟「直播開播通知」嘅裝置一覽——客戶名、綁定時間、裝置廠牌、瀏覽器。撳任何一行睇該機推送紀錄。
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
          {/* 桌面版：表格（行可撳開推送紀錄） */}
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
                  <tr
                    key={r.id}
                    onClick={() => setOpenDevice(r)}
                    className={`border-t ${rowClass}`}
                    style={{ borderColor: 'var(--space-line)' }}
                    title="撳落去睇推送紀錄"
                  >
                    <td className="py-2.5 pr-3">
                      <span className="font-medium text-txt-1">{r.customerName}</span>
                      <span className="mt-0.5 block font-mono text-[12px] text-txt-3">
                        {fmtPhone(r.customerPhone) || r.customerEmail || '—'}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-txt-1">
                      {r.brand}
                      {r.model && (
                        <span className="mt-0.5 block font-mono text-[11px] text-txt-3">
                          {r.model}
                        </span>
                      )}
                    </td>
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

          {/* 手機版：逐部一卡（可撳）。v2.2.45 重排：avatar＋名/電話主行、
              廠牌/瀏覽器 icon chip、時間 icon 行、右邊 chevron 提示可撳 */}
          <ul className="mt-4 space-y-3 lg:hidden">
            {filtered.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpenDevice(r)}
                  className="w-full cursor-pointer rounded-2xl border p-4 text-left transition-colors hover:bg-white/5"
                  style={{ borderColor: 'var(--space-line)', background: 'rgba(255,255,255,0.02)' }}
                  aria-label={`睇 ${r.customerName} 呢部裝置嘅推送紀錄`}
                >
                  {/* 主行：名＋電話 */}
                  <span className="flex items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-[15px] font-bold"
                      style={{
                        borderColor: 'var(--glass-border)',
                        background: 'var(--space-1)',
                        color: 'var(--gold-soft)',
                      }}
                    >
                      {r.customerName.trim().charAt(0) || '客'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold text-txt-1">
                        {r.customerName}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[12px] text-txt-3">
                        {fmtPhone(r.customerPhone) || r.customerEmail || '—'}
                      </span>
                    </span>
                    <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-txt-3" />
                  </span>

                  {/* 裝置 chips：廠牌（＋型號細字）／瀏覽器 */}
                  <span className="mt-3 flex flex-wrap items-center gap-2">
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium text-txt-1"
                      style={{ borderColor: 'var(--glass-border)' }}
                    >
                      <Smartphone size={12} aria-hidden="true" className="text-lavender" />
                      {r.brand}
                    </span>
                    {r.model && (
                      <span className="font-mono text-[11px] text-txt-3">{r.model}</span>
                    )}
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] text-txt-2"
                      style={{ borderColor: 'var(--space-line)' }}
                    >
                      <Globe size={12} aria-hidden="true" className="text-txt-3" />
                      {r.browser}
                    </span>
                  </span>

                  {/* 時間行 */}
                  <span className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2.5 font-mono text-[11.5px] text-txt-3" style={{ borderColor: 'var(--space-line)' }}>
                    <span className="inline-flex items-center gap-1.5">
                      <Clock3 size={12} aria-hidden="true" />
                      綁定 {fmtDateTime(r.boundAt)}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Send size={11} aria-hidden="true" />
                      {r.lastSentAt ? `最近推送 ${fmtDateTime(r.lastSentAt)}` : '未推過'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {openDevice && (
        <DeviceDeliveriesModal device={openDevice} onClose={() => setOpenDevice(null)} />
      )}
    </section>
  );
}
