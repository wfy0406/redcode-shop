import { useEffect, useMemo, useRef, useState } from 'react';
import type { AdminOrder, ReviewHandler } from './types';
import { fmtHKD, fmtWaiting } from './format';
import ProofSection from './ProofSection';
import type { ProofSectionHandle } from './ProofSection';
import StatusBadge from './StatusBadge';

/**
 * §P9 訂單審批工作枱（兩欄 5:7）
 * 左：待審批隊列（單號 mono + 金額 + 等待時長，超 24h 轉 --pink）
 * 右：選中訂單詳情 —— 付款截圖大圖 + 金額/會員電話 mono 對數欄 + Approve/Reject
 * 鍵盤：A approve、R reject（focus 備註欄）、↑↓ 揀單
 */

interface ReviewWorkbenchProps {
  queue: AdminOrder[];
  onReview: ReviewHandler;
  reviewingProofId: number | null;
  onOpenLightbox: (src: string) => void;
  /** 審批完成後 300ms 內向右飛出嘅訂單 */
  leavingIds: ReadonlySet<number>;
}

/** 鍵盤事件嚟自表單元件時唔攔截 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export default function ReviewWorkbench({
  queue,
  onReview,
  reviewingProofId,
  onOpenLightbox,
  leavingIds,
}: ReviewWorkbenchProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const proofRef = useRef<ProofSectionHandle>(null);

  // 選中訂單由隊列派生：審批完 selectedId 失效時自動帶入隊列下一張（FIFO 頭）
  const selected = useMemo(
    () => queue.find((o) => o.id === selectedId) ?? queue[0] ?? null,
    [queue, selectedId],
  );

  // 鍵盤快捷鍵：A 批准、R 拒絕、↑↓ 揀單
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || queue.length === 0) return;
      const current = queue.find((o) => o.id === selectedId) ?? queue[0];
      const firstPending = current?.proofs.find((p) => p.status === 'pending');

      if (e.key === 'a' || e.key === 'A') {
        if (!current || !firstPending || reviewingProofId != null) return;
        e.preventDefault();
        onReview(firstPending.id, true, undefined, current);
      } else if (e.key === 'r' || e.key === 'R') {
        if (!firstPending) return;
        e.preventDefault();
        proofRef.current?.openRejectForm(firstPending.id);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = queue.findIndex((o) => o.id === current?.id);
        const next =
          e.key === 'ArrowDown'
            ? queue[Math.min(queue.length - 1, idx + 1)]
            : queue[Math.max(0, idx - 1)];
        if (next) setSelectedId(next.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [queue, selectedId, reviewingProofId, onReview]);

  if (queue.length === 0) {
    return (
      <div
        className="rounded-2xl border px-6 py-16 text-center"
        style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
      >
        <p className="script text-3xl">All wishes cleared ✦</p>
        <p className="mt-3 text-[15px] text-txt-2">冇待審批嘅付款截圖，飲杯茶先。</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
      {/* 左：待審批隊列（5） */}
      <div className="xl:col-span-5">
        <p className="mb-3 flex items-center gap-3 text-[13px] text-txt-3">
          鍵盤：
          <kbd className="rounded-md border border-space-line px-1.5 py-0.5 font-mono text-[11px] text-lavender">A</kbd>
          批准
          <kbd className="rounded-md border border-space-line px-1.5 py-0.5 font-mono text-[11px] text-lavender">R</kbd>
          拒絕
          <kbd className="rounded-md border border-space-line px-1.5 py-0.5 font-mono text-[11px] text-lavender">↑↓</kbd>
          揀單
        </p>
        <ul className="flex max-h-[560px] flex-col gap-2 overflow-y-auto pr-1">
          {queue.map((order) => {
            const waiting = fmtWaiting(order.createdAt);
            const isSelected = order.id === selected?.id;
            const isLeaving = leavingIds.has(order.id);
            return (
              <li
                key={order.id}
                style={{
                  transition: 'transform 300ms var(--ease-expo), opacity 300ms var(--ease-expo)',
                  transform: isLeaving ? 'translateX(48px)' : 'translateX(0)',
                  opacity: isLeaving ? 0 : 1,
                }}
              >
                <button
                  type="button"
                  onClick={() => setSelectedId(order.id)}
                  aria-current={isSelected}
                  className="flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition-colors"
                  style={{
                    borderColor: isSelected ? 'var(--pink)' : 'var(--space-line)',
                    background: isSelected ? 'var(--space-3)' : 'var(--space-2)',
                  }}
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[14px] text-txt-1">{order.orderNo}</p>
                    <p className="mt-0.5 truncate text-[13px] text-txt-3">
                      {order.user.name} · {order.user.phone}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-mono text-[15px] text-pink">{fmtHKD(order.total)}</p>
                    <p
                      className="mt-0.5 font-mono text-[12px]"
                      style={{ color: waiting.over24h ? 'var(--pink-soft)' : 'var(--text-3)' }}
                    >
                      等緊 {waiting.text}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* 右：選中訂單詳情（7） */}
      <div className="xl:col-span-7">
        {selected && (
          <div
            className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
            style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-mono text-[16px] text-txt-1">{selected.orderNo}</h3>
              <StatusBadge status={selected.status} />
            </div>

            {/* 對數欄：金額／會員電話／件數 並排 DM Mono */}
            <div
              className="mt-4 grid grid-cols-3 gap-px overflow-hidden rounded-xl border"
              style={{ borderColor: 'var(--space-line)', background: 'var(--space-line)' }}
            >
              {[
                { label: '應收金額', value: fmtHKD(selected.total), pink: true },
                { label: '會員電話', value: selected.user.phone, pink: false },
                {
                  label: '件數',
                  value: String(selected.items.reduce((s, i) => s + i.quantity, 0)),
                  pink: false,
                },
              ].map((cell) => (
                <div key={cell.label} className="px-4 py-3" style={{ background: 'var(--space-2)' }}>
                  <p className="text-[12px] text-txt-3">{cell.label}</p>
                  <p
                    className="mt-1 truncate font-mono text-[15px]"
                    style={{ color: cell.pink ? 'var(--pink)' : 'var(--text-1)' }}
                  >
                    {cell.value}
                  </p>
                </div>
              ))}
            </div>

            {/* 優惠碼折扣細行（應收金額已係折後價） */}
            {selected.discountAmount > 0 && (
              <p className="mt-2 text-right text-[13px] text-gold">
                優惠碼 <span className="font-mono">{selected.promoCode}</span>{' '}
                <span className="font-mono">−{fmtHKD(selected.discountAmount)}</span>
              </p>
            )}

            <div className="mt-5">
              <ProofSection
                ref={proofRef}
                order={selected}
                onReview={onReview}
                reviewingProofId={reviewingProofId}
                onOpenLightbox={onOpenLightbox}
                large
              />
            </div>

            {selected.note && (
              <p className="mt-4 border-t pt-4 text-[14px] text-txt-2" style={{ borderColor: 'var(--space-line)' }}>
                會員備註：{selected.note}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
