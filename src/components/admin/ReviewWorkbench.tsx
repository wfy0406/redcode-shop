import { useState } from 'react';
import { trpc } from '@/providers/trpc';
import type { AdminOrder, ReviewHandler } from './types';
import { fmtHKD } from './format';
import StatusBadge from './StatusBadge';
import ProofSection from './ProofSection';
import WishingStar from './WishingStar';

/** 待審批佇列（審批工作台嘅左欄）：一張張卡仔，撳入右欄處理 */
function ReviewQueue({ orders, activeId, onSelect }: {
  orders: AdminOrder[];
  activeId: number | null;
  onSelect: (id: number) => void;
}) {
  if (orders.length === 0) {
    return (
      <p className="rounded-2xl border px-4 py-10 text-center text-[13px] text-txt-3" style={{ borderColor: 'var(--space-line)' }}>
        冇待審批嘅訂單，辛苦晒！
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {orders.map((o) => {
        const active = o.id === activeId;
        return (
          <li key={o.id}>
            <button
              type="button"
              onClick={() => onSelect(o.id)}
              aria-pressed={active}
              className="w-full rounded-2xl border px-4 py-3 text-left transition-colors hover:border-pink"
              style={{
                borderColor: active ? 'var(--pink)' : 'var(--space-line)',
                background: active ? 'var(--space-3)' : 'var(--space-2)',
              }}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-[13px] text-txt-1">{o.orderNo}</span>
                <span className="font-mono text-[13px] text-pink">{fmtHKD(o.total)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-[12px] text-txt-3">
                <span className="truncate">{o.user.name}</span>
                <span>截圖 ×{o.proofs.length}</span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** 審批詳情（右欄）：訂單資料 + 截圖審批 + 駁回原因 */
function ReviewDetail({ order, onReview, reviewingProofId, onOpenLightbox }: {
  order: AdminOrder | undefined;
  onReview: ReviewHandler;
  reviewingProofId: number | null;
  onOpenLightbox: (src: string) => void;
}) {
  const [note, setNote] = useState('');
  if (!order) {
    return (
      <p className="rounded-2xl border px-4 py-10 text-center text-[13px] text-txt-3" style={{ borderColor: 'var(--space-line)' }}>
        由左邊揀一張待審批嘅訂單開始。
      </p>
    );
  }
  const pendingProofs = order.proofs.filter((p) => p.status === 'pending');
  return (
    <div
      className="rounded-2xl border p-5"
      style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[15px] text-txt-1">{order.orderNo}</p>
          <p className="mt-0.5 text-[13px] text-txt-3">
            {order.user.name} · {order.user.phone}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[16px] text-pink">{fmtHKD(order.total)}</span>
          <StatusBadge status={order.status} />
        </div>
      </div>

      <ul className="mt-4 flex flex-col gap-1.5 border-t pt-4 text-[13px]" style={{ borderColor: 'var(--space-line)' }}>
        {order.items.map((item) => (
          <li key={item.id} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-txt-2">
              {item.productName}
              {item.size && <span className="ml-2 font-mono text-[12px] text-txt-3">{item.size}</span>}
              <span className="ml-2 font-mono text-[12px] text-txt-3">×{item.quantity}</span>
            </span>
            <span className="shrink-0 font-mono text-txt-2">{fmtHKD(item.price * item.quantity)}</span>
          </li>
        ))}
      </ul>

      <div className="mt-5">
        <h4 className="text-[13px] font-bold tracking-[0.08em] text-lavender">
          付款截圖（待審 {pendingProofs.length} 張）
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

      {/* 駁回原因（預設唔使填；撳「退回」嗰陣會一併送出） */}
      {pendingProofs.length > 0 && (
        <div className="mt-5 border-t pt-4" style={{ borderColor: 'var(--space-line)' }}>
          <label className="flex items-center gap-2 text-[13px] text-txt-2">
            退回原因
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="（選填，會寫入審批紀錄）"
              aria-label="退回原因"
              className="h-9 min-w-0 flex-1 rounded-lg border bg-space-2 px-3 text-txt-1 placeholder:text-txt-disabled"
              style={{ borderColor: 'var(--space-line)' }}
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-3">
            {pendingProofs.map((p) => (
              <div key={p.id} className="flex gap-2">
                <button
                  type="button"
                  disabled={reviewingProofId === p.id}
                  onClick={() => onReview(p.id, 'approved')}
                  className="btn btn-primary !px-4 !py-2 text-[12px] disabled:opacity-60"
                >
                  {reviewingProofId === p.id ? <WishingStar size={13} /> : null}
                  通過截圖 #{p.id}
                </button>
                <button
                  type="button"
                  disabled={reviewingProofId === p.id}
                  onClick={() => onReview(p.id, 'rejected', note || undefined)}
                  className="btn btn-secondary !px-4 !py-2 text-[12px] disabled:opacity-60"
                >
                  退回截圖 #{p.id}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 審批工作台：左邊待審批訂單佇列 + 右邊詳情。
 * 唔會自己攞數——資料由 AdminPanel 傳入（同 OrderList 共用同一份 adminList）。
 */
export default function ReviewWorkbench({ orders, onReview, reviewingProofId, onOpenLightbox }: {
  orders: AdminOrder[];
  onReview: ReviewHandler;
  reviewingProofId: number | null;
  onOpenLightbox: (src: string) => void;
}) {
  const pending = orders.filter((o) => o.status === 'payment_review');
  const [activeId, setActiveId] = useState<number | null>(null);
  const active = pending.find((o) => o.id === activeId) ?? pending[0];
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[320px_1fr]">
      <div>
        <p className="mb-3 font-mono text-[12px] text-txt-3" aria-live="polite">
          待審批 {pending.length} 張
        </p>
        <ReviewQueue orders={pending} activeId={active?.id ?? null} onSelect={setActiveId} />
      </div>
      <ReviewDetail
        order={active}
        onReview={onReview}
        reviewingProofId={reviewingProofId}
        onOpenLightbox={onOpenLightbox}
      />
    </div>
  );
}
