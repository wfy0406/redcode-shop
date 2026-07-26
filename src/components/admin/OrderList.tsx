import { useMemo, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { AdminOrder, OrderStatus, ReviewHandler, StatusHandler } from './types';
import { fmtDateTime, fmtHKD } from './format';
import StatusBadge from './StatusBadge';
import { STATUS_FILTERS } from './statusMeta';
import ProofSection from './ProofSection';
import WishingStar from './WishingStar';

/**
 * 全部訂單列表 —— status 篩選 tabs + 單號搜尋 + 點入行展開詳情
 * 詳情：items / 優惠碼折扣行 / 地址 / 備註 / 付款截圖審批 / 訂單狀態操作
 */

interface OrderListProps {
  orders: AdminOrder[];
  onReview: ReviewHandler;
  reviewingProofId: number | null;
  onStatus: StatusHandler;
  statusBusyId: number | null;
  onOpenLightbox: (src: string) => void;
}

/** 可以取消嘅狀態（完成/已取消除外） */
const CANCELLABLE: OrderStatus[] = [
  'pending_payment',
  'payment_review',
  'approved',
  'rejected',
  'shipped',
];

export default function OrderList({
  orders,
  onReview,
  reviewingProofId,
  onStatus,
  statusBusyId,
  onOpenLightbox,
}: OrderListProps) {
  const [tab, setTab] = useState<OrderStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<number | null>(null);

  const counts = useMemo(() => {
    const map = new Map<OrderStatus, number>();
    for (const o of orders) map.set(o.status, (map.get(o.status) ?? 0) + 1);
    return map;
  }, [orders]);

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (tab !== 'all' && o.status !== tab) return false;
      if (kw && !o.orderNo.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [orders, tab, search]);

  return (
    <div>
      {/* 篩選 pills + 單號搜尋 */}
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((f) => {
          const active = tab === f.key;
          const count = f.key === 'all' ? orders.length : (counts.get(f.key) ?? 0);
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setTab(f.key)}
              aria-pressed={active}
              className="inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-[13px] transition-colors"
              style={
                active
                  ? { background: 'var(--pink)', borderColor: 'var(--pink)', color: 'var(--space-1)', fontWeight: 700 }
                  : { borderColor: 'var(--space-line)', color: 'var(--text-2)', background: 'transparent' }
              }
            >
              {f.label}
              <span className="font-mono text-[11px]" style={{ opacity: 0.75 }}>
                {count}
              </span>
            </button>
          );
        })}
        <label
          className="ml-auto flex h-10 items-center gap-2 rounded-full border px-4"
          style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
        >
          <Search size={15} className="shrink-0 text-txt-3" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜尋單號"
            aria-label="搜尋訂單編號"
            className="w-36 bg-transparent font-mono text-[13px] text-txt-1 placeholder:text-txt-disabled focus:outline-none"
          />
        </label>
      </div>

      {/* 訂單行 */}
      {filtered.length === 0 ? (
        <p className="py-14 text-center text-[14px] text-txt-3">冇符合條件嘅訂單。</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {filtered.map((order) => {
            const expanded = expandedId === order.id;
            const busy = statusBusyId === order.id;
            return (
              <li
                key={order.id}
                className="overflow-hidden rounded-2xl border"
                style={{
                  borderColor: expanded ? 'var(--pink)' : 'var(--space-line)',
                  background: 'var(--space-2)',
                }}
              >
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : order.id)}
                  aria-expanded={expanded}
                  className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 text-left transition-colors hover:bg-space-4 md:flex-nowrap"
                >
                  <span className="font-mono text-[14px] text-txt-1">{order.orderNo}</span>
                  <span className="min-w-0 truncate text-[14px] text-txt-2">
                    {order.user.name}
                    <span className="ml-2 font-mono text-[13px] text-txt-3">{order.user.phone}</span>
                  </span>
                  <span className="ml-auto font-mono text-[15px] text-pink md:ml-auto">
                    {fmtHKD(order.total)}
                  </span>
                  <StatusBadge status={order.status} />
                  <span className="hidden font-mono text-[12px] text-txt-3 lg:inline">
                    {fmtDateTime(order.createdAt)}
                  </span>
                  <ChevronDown
                    size={16}
                    aria-hidden="true"
                    className="shrink-0 text-txt-3 transition-transform"
                    style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
                  />
                </button>

                {expanded && (
                  <div
                    className="border-t px-4 py-5 md:px-6"
                    style={{ borderColor: 'var(--space-line)' }}
                  >
                    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                      {/* 明細 + 地址 + 備註 */}
                      <div>
                        <h4 className="text-[13px] font-bold tracking-[0.08em] text-lavender">
                          訂單明細
                        </h4>
                        <ul className="mt-3 flex flex-col gap-2">
                          {order.items.map((item) => (
                            <li
                              key={item.id}
                              className="flex items-baseline justify-between gap-3 text-[14px]"
                            >
                              <span className="min-w-0 truncate text-txt-1">
                                {item.productName}
                                {item.size && (
                                  <span className="ml-2 font-mono text-[12px] text-txt-3">
                                    {item.size}
                                  </span>
                                )}
                                <span className="ml-2 font-mono text-[12px] text-txt-3">
                                  ×{item.quantity}
                                </span>
                              </span>
                              <span className="shrink-0 font-mono text-[13px] text-txt-2">
                                {fmtHKD(item.price * item.quantity)}
                              </span>
                            </li>
                          ))}
                        </ul>
                        {/* 優惠碼折扣行（total 已係折後價） */}
                        {order.discountAmount > 0 && (
                          <div className="mt-2 flex items-baseline justify-between gap-3 text-[13px]">
                            <span className="text-gold">
                              優惠碼 <span className="font-mono">{order.promoCode}</span>
                            </span>
                            <span className="shrink-0 font-mono text-gold">
                              −{fmtHKD(order.discountAmount)}
                            </span>
                          </div>
                        )}
                        <dl className="mt-4 flex flex-col gap-2 border-t pt-4" style={{ borderColor: 'var(--space-line)' }}>
                          <div className="flex gap-2 text-[14px]">
                            <dt className="w-16 shrink-0 text-txt-3">收件地址</dt>
                            <dd className="text-txt-2">{order.address || order.user.address || '—'}</dd>
                          </div>
                          <div className="flex gap-2 text-[14px]">
                            <dt className="w-16 shrink-0 text-txt-3">備註</dt>
                            <dd className="text-txt-2">{order.note || '—'}</dd>
                          </div>
                          <div className="flex gap-2 text-[14px]">
                            <dt className="w-16 shrink-0 text-txt-3">落單時間</dt>
                            <dd className="font-mono text-[13px] text-txt-2">
                              {fmtDateTime(order.createdAt)}
                            </dd>
                          </div>
                        </dl>

                        {/* 訂單狀態操作 */}
                        <div className="mt-5 flex flex-wrap gap-3">
                          {order.status === 'approved' && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => onStatus(order.id, 'shipped')}
                              className="btn btn-secondary !px-5 !py-2.5 text-[13px] disabled:opacity-60"
                            >
                              {busy ? <WishingStar size={14} /> : null}
                              標記已寄出
                            </button>
                          )}
                          {order.status === 'shipped' && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => onStatus(order.id, 'completed')}
                              className="btn !px-5 !py-2.5 text-[13px] disabled:opacity-60"
                              style={{
                                background: 'var(--success)',
                                color: 'var(--space-1)',
                                boxShadow: '0 8px 24px rgba(94, 224, 160, 0.25)',
                              }}
                            >
                              {busy ? <WishingStar size={14} /> : null}
                              標記完成
                            </button>
                          )}
                          {CANCELLABLE.includes(order.status) &&
                            (confirmCancelId === order.id ? (
                              <>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    onStatus(order.id, 'cancelled');
                                    setConfirmCancelId(null);
                                  }}
                                  className="btn btn-primary !px-5 !py-2.5 text-[13px] disabled:opacity-60"
                                >
                                  {busy ? <WishingStar size={14} /> : null}
                                  確認取消呢張單？
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmCancelId(null)}
                                  className="btn btn-secondary !px-5 !py-2.5 text-[13px]"
                                >
                                  算數
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => setConfirmCancelId(order.id)}
                                className="btn !border !px-5 !py-2.5 text-[13px] disabled:opacity-60"
                                style={{
                                  borderColor: 'var(--pink)',
                                  color: 'var(--pink-soft)',
                                  background: 'transparent',
                                }}
                              >
                                取消訂單
                              </button>
                            ))}
                        </div>
                      </div>

                      {/* 付款截圖審批 */}
                      <div>
                        <h4 className="text-[13px] font-bold tracking-[0.08em] text-lavender">
                          付款截圖
                        </h4>
                        <div className="mt-3">
                          <ProofSection
                            order={order}
                            onReview={onReview}
                            reviewingProofId={reviewingProofId}
                            onOpenLightbox={onOpenLightbox}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
