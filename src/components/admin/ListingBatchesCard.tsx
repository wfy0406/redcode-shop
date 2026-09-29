import { useState } from 'react';
import { ClipboardList, X } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { productCategoryLabel } from '@contracts/types';
import { fmtDateTime, fmtHKD } from './format';
import { LoadingBlock } from './WishingStar';

/**
 * WMS 上架紀錄卡（2026-09-29 F8）—— products.listingBatches（staff 唯讀）
 * 內部系統（WMS）批量上架推落官網嘅紀錄：邊個申請、邊個批、每件貨成功/失敗都齊。
 * 撳一行開詳情 modal：逐件縮圖＋貨號＋品名＋價錢＋類別＋結果；rejected 批顯示拒絕原因。
 * 掛喺 Admin「商品」view（ProductManager 下面）。
 */

/** listingBatches 行（同 db/schema.ts $inferSelect 一致）＋逐件結果 */
type BatchItemRow = {
  id: number;
  batchId: number;
  sku: string;
  name: string | null;
  price: number | null;
  discountPrice: number | null;
  stock: number | null;
  sizes: string | null;
  category: string | null;
  imageUrl: string | null;
  productId: number | null;
  status: string; // 'created' | 'updated' | 'failed' | 'pending'（rejected 批留 pending）
  error: string | null;
  createdAt: Date;
};

type BatchRow = {
  id: number;
  batchNo: string;
  liveDate: string | null; // YYYYMMDD
  liveSession: string | null; // '1','2'…
  status: string; // 'approved' | 'rejected'
  itemCount: number;
  requestedBy: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  items: BatchItemRow[];
};

/** YYYYMMDD → M月D日（冇日期就「—」） */
function fmtLive(yyyymmdd: string | null): string {
  if (!yyyymmdd || yyyymmdd.length !== 8) return '—';
  return `${Number.parseInt(yyyymmdd.slice(4, 6), 10)}月${Number.parseInt(yyyymmdd.slice(6, 8), 10)}日`;
}

/** 批次狀態 badge：approved 綠 / rejected 紅 / 其他灰 */
function BatchStatusBadge({ status }: { status: string }) {
  const approved = status === 'approved';
  const rejected = status === 'rejected';
  return (
    <span
      className="shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-bold"
      style={{
        borderColor: approved ? 'rgba(52,211,153,0.45)' : rejected ? 'rgba(251,113,133,0.45)' : 'var(--glass-border)',
        background: approved ? 'rgba(52,211,153,0.12)' : rejected ? 'rgba(251,113,133,0.12)' : 'var(--glass-bg)',
        color: approved ? '#34D399' : rejected ? '#FB7185' : 'var(--text-3)',
      }}
    >
      {approved ? '已上架' : rejected ? '已拒絕' : status}
    </span>
  );
}

/** 逐件結果 chip：created 新建（綠）/ updated 更新（薰衣草）/ failed 失敗（紅）/ pending 未處理（灰） */
function ItemStatusChip({ status }: { status: string }) {
  const meta =
    status === 'created'
      ? { label: '新建', color: '#34D399', border: 'rgba(52,211,153,0.45)', bg: 'rgba(52,211,153,0.12)' }
      : status === 'updated'
        ? { label: '更新', color: 'var(--lavender)', border: 'var(--glass-border)', bg: 'var(--glass-bg)' }
        : status === 'failed'
          ? { label: '失敗', color: '#FB7185', border: 'rgba(251,113,133,0.45)', bg: 'rgba(251,113,133,0.12)' }
          : { label: '未處理', color: 'var(--text-3)', border: 'var(--glass-border)', bg: 'var(--glass-bg)' };
  return (
    <span
      className="shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold"
      style={{ borderColor: meta.border, background: meta.bg, color: meta.color }}
    >
      {meta.label}
    </span>
  );
}

export default function ListingBatchesCard() {
  const listQuery = trpc.products.listingBatches.useQuery(undefined, { staleTime: 30_000 });
  const [openBatch, setOpenBatch] = useState<BatchRow | null>(null);

  const batches = (listQuery.data ?? []) as BatchRow[];

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
        <ClipboardList size={16} aria-hidden="true" className="text-lavender" />
        WMS 上架紀錄
      </h3>
      <p className="mt-1.5 text-[13px] text-txt-3">
        內部系統批量上架推落官網嘅紀錄（唯讀）：邊個申請、邊個批、每件貨成功定失敗。撳一行睇逐件詳情。
      </p>

      <div className="mt-4">
        {listQuery.isLoading ? (
          <LoadingBlock text="載入上架紀錄中…" />
        ) : batches.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-txt-3">暫時未有 WMS 上架紀錄。</p>
        ) : (
          <ul className="space-y-2.5">
            {batches.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => setOpenBatch(b)}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border px-4 py-3 text-left transition-colors hover:border-pink"
                  style={{ borderColor: 'var(--glass-border)', background: 'var(--space-2)' }}
                >
                  <span className="font-mono text-[13px] font-bold text-txt-1">{b.batchNo}</span>
                  <BatchStatusBadge status={b.status} />
                  <span className="text-[12px] text-txt-3">
                    📺 {fmtLive(b.liveDate)}
                    {b.liveSession ? `·第${b.liveSession}場` : ''} · {b.itemCount} 件
                  </span>
                  <span className="text-[12px] text-txt-3">
                    申請：{b.requestedBy ?? '—'}
                    {b.reviewedBy ? ` · 審批：${b.reviewedBy}` : ''}
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-txt-disabled">
                    {fmtDateTime(b.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 批次詳情 modal（唯讀） */}
      {openBatch && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(5,6,18,0.72)' }}
          role="dialog"
          aria-modal="true"
          aria-label={`批次 ${openBatch.batchNo} 詳情`}
          onClick={() => setOpenBatch(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-[720px] overflow-y-auto rounded-2xl border p-5 backdrop-blur-xl md:p-6"
            style={{ borderColor: 'var(--glass-border)', background: 'var(--space-1)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-[15px] font-bold text-txt-1">{openBatch.batchNo}</p>
                <p className="mt-1 text-[12px] text-txt-3">
                  📺 {fmtLive(openBatch.liveDate)}
                  {openBatch.liveSession ? `·第${openBatch.liveSession}場` : ''} · {openBatch.itemCount} 件 ·{' '}
                  {fmtDateTime(openBatch.createdAt)}
                </p>
                <p className="mt-0.5 text-[12px] text-txt-3">
                  申請：{openBatch.requestedBy ?? '—'}
                  {openBatch.reviewedBy ? ` · 審批：${openBatch.reviewedBy}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <BatchStatusBadge status={openBatch.status} />
                <button
                  type="button"
                  onClick={() => setOpenBatch(null)}
                  aria-label="關閉詳情"
                  className="rounded-lg border p-1.5 text-txt-3 transition-colors hover:border-pink hover:text-txt-1"
                  style={{ borderColor: 'var(--glass-border)' }}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
            </div>

            {/* rejected 批：顯示拒絕原因 */}
            {openBatch.status === 'rejected' && openBatch.reviewNote && (
              <p
                className="mt-3 rounded-xl border px-4 py-2.5 text-[13px] leading-[1.6]"
                style={{
                  borderColor: 'rgba(251,113,133,0.4)',
                  background: 'rgba(251,113,133,0.08)',
                  color: '#FB7185',
                }}
              >
                拒絕原因：{openBatch.reviewNote}
              </p>
            )}

            <ul className="mt-4 space-y-2.5">
              {openBatch.items.map((it) => (
                <li
                  key={it.id}
                  className="flex items-center gap-3 rounded-xl border px-3.5 py-2.5"
                  style={{ borderColor: 'var(--glass-border)', background: 'var(--space-2)' }}
                >
                  {it.imageUrl ? (
                    <img
                      src={it.imageUrl}
                      alt=""
                      className="h-12 w-12 shrink-0 rounded-lg border object-cover"
                      style={{ borderColor: 'var(--glass-border)', background: 'var(--space-0)' }}
                      loading="lazy"
                    />
                  ) : (
                    <div
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border text-[16px]"
                      style={{ borderColor: 'var(--glass-border)', background: 'var(--space-0)' }}
                      aria-hidden="true"
                    >
                      👗
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-bold text-txt-1">{it.name ?? '（未命名）'}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-txt-3">
                      {it.sku}
                      {it.category ? ` · ${productCategoryLabel(it.category)}` : ''}
                      {it.price != null && (
                        <>
                          {' · '}
                          {it.discountPrice != null ? fmtHKD(it.discountPrice) : fmtHKD(it.price)}
                          {it.discountPrice != null && (
                            <span className="ml-1.5 line-through">{fmtHKD(it.price)}</span>
                          )}
                        </>
                      )}
                    </p>
                    {it.status === 'failed' && it.error && (
                      <p className="mt-1 text-[11px] leading-[1.5]" style={{ color: '#FB7185' }}>
                        {it.error}
                      </p>
                    )}
                  </div>
                  <ItemStatusChip status={it.status} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
