import { useEffect, useMemo, useState } from 'react';
import { Search, Trash2, Users, X } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { fmtDate, fmtDateTime, fmtHKD } from './format';
import { LoadingBlock } from './WishingStar';
import StatusBadge from './StatusBadge';
import type { OrderStatus } from './types';
import type { ToastKind } from './useToasts';

/**
 * 會員列表（F-H，admin only）—— trpc.members.list
 * 2026-07-28 更新：
 * - 搜尋框：輸入名或電話即時篩（300ms debounce，server ilike 模糊對照）
 * - 表格加「地址」欄
 * - 撳任何一行彈出詳情：會員資料（名/電話/email/年齡/地址/註冊日）＋訂單統計＋最近 10 張訂單
 * - 每行有刪除掣：有訂單嘅會員會喺確認對話框講明連訂單一併刪（後端 members.remove 把關）
 */

/** membersRouter 未 merge 前嘅本地型別（同 spec §B4 契約一致） */
type MemberRow = {
  id: number;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  createdAt: Date | string;
  orderCount: number;
  totalSpent: number;
};

type MemberDetail = {
  user: {
    id: number;
    name: string;
    phone: string;
    email: string | null;
    address: string | null;
    age: number | null;
    role: string;
    createdAt: Date | string;
  };
  orderCount: number;
  totalSpent: number;
  recentOrders: {
    id: number;
    orderNo: string;
    status: OrderStatus;
    total: number;
    deliveryMethod: string;
    createdAt: Date | string;
  }[];
};

const DELIVERY_TEXT: Record<string, string> = {
  address: '送貨上門',
  sf_station: '順豐站自取',
  sf_locker: '順豐智能櫃',
};

export default function MemberList({
  toast,
}: {
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const utils = trpc.useUtils();
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // 打字停 300ms 先出搜尋請求，唔會每個字打一次
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const listQuery = trpc.members.list.useQuery(
    debouncedQ ? { q: debouncedQ } : undefined,
  );
  const members = useMemo(() => (listQuery.data ?? []) as MemberRow[], [listQuery.data]);

  const detailQuery = trpc.members.detail.useQuery(
    { id: selectedId ?? 0 },
    { enabled: selectedId !== null },
  );

  // Esc 閂詳情
  useEffect(() => {
    if (selectedId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

  const removeMutation = trpc.members.remove.useMutation({
    onSuccess: (result) => {
      toast(
        result?.deletedOrders
          ? `已刪除會員（連埋 ${result.deletedOrders} 張訂單）`
          : '已刪除會員',
        'success',
      );
      setSelectedId(null);
      void utils.members.list.invalidate();
      void utils.analytics.summary.invalidate();
    },
    onError: (err) => toast(err.message || '刪除會員失敗', 'error'),
  });

  const askDelete = (m: MemberRow) => {
    const withOrders = m.orderCount > 0;
    const msg = withOrders
      ? `會員「${m.name}」有 ${m.orderCount} 張訂單。\n\n確定連埋訂單一併刪除？呢個操作唔可以復原。`
      : `確定刪除會員「${m.name}」？呢個操作唔可以復原。`;
    if (!window.confirm(msg)) return;
    removeMutation.mutate(withOrders ? { id: m.id, alsoDeleteOrders: true } : { id: m.id });
  };

  const detail = detailQuery.data as MemberDetail | undefined;

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
        <Users size={16} aria-hidden="true" className="text-lavender" />
        會員
        {!listQuery.isLoading && !listQuery.isError && (
          <span className="font-mono text-[13px] font-normal text-txt-3">
            （{members.length}
            {debouncedQ ? ' 個結果' : ''}）
          </span>
        )}
      </h3>

      {/* 搜尋：名或電話 */}
      <div className="relative mt-3">
        <Search
          size={15}
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-txt-3"
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="輸入名或電話搜尋…"
          aria-label="搜尋會員（名或電話）"
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
        <LoadingBlock text="許願星搬緊會員名單…" />
      ) : listQuery.isError ? (
        <p className="py-8 text-center text-[14px] text-pink-soft">
          載入會員失敗：{listQuery.error.message}
        </p>
      ) : members.length === 0 ? (
        <p className="py-8 text-center text-[14px] text-txt-3">
          {debouncedQ ? `搵唔到名或電話有「${debouncedQ}」嘅會員。` : '暫時冇會員。'}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[780px] border-collapse text-[14px]">
            <thead>
              <tr
                className="border-b text-left text-[12px] text-txt-3"
                style={{ borderColor: 'var(--space-line)' }}
              >
                <th className="py-2 pr-3 font-normal">名</th>
                <th className="py-2 pr-3 font-normal">電話</th>
                <th className="py-2 pr-3 font-normal">Email</th>
                <th className="py-2 pr-3 font-normal">地址</th>
                <th className="py-2 pr-3 font-normal">註冊日期</th>
                <th className="w-16 py-2 pr-3 text-right font-normal">訂單數</th>
                <th className="w-28 py-2 text-right font-normal">累計消費</th>
                <th className="w-14 py-2 pl-3 text-right font-normal">刪除</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr
                  key={m.id}
                  onClick={() => setSelectedId(m.id)}
                  className="cursor-pointer border-b transition-colors last:border-0 hover:bg-white/5"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  <td className="max-w-0 truncate py-2.5 pr-3 text-txt-1">{m.name}</td>
                  <td className="py-2.5 pr-3 font-mono text-[13px] text-txt-2">{m.phone}</td>
                  <td className="max-w-0 truncate py-2.5 pr-3 font-mono text-[13px] text-txt-3">
                    {m.email || '—'}
                  </td>
                  <td className="max-w-[140px] truncate py-2.5 pr-3 text-[13px] text-txt-3">
                    {m.address || '—'}
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-[13px] text-txt-3">
                    {fmtDate(m.createdAt)}
                  </td>
                  <td className="py-2.5 pr-3 text-right font-mono text-[13px] text-txt-2">
                    {m.orderCount}
                  </td>
                  <td className="py-2.5 text-right font-mono text-[13px] text-pink">
                    {fmtHKD(m.totalSpent)}
                  </td>
                  <td className="py-2.5 pl-3 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        askDelete(m);
                      }}
                      disabled={removeMutation.isPending}
                      aria-label={`刪除會員 ${m.name}`}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-txt-3 transition-colors hover:text-pink-soft disabled:opacity-50"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[12px] text-txt-3">撳任何一行睇詳細資料。</p>
        </div>
      )}

      {/* 會員詳情彈窗 */}
      {selectedId !== null && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center"
          onClick={() => setSelectedId(null)}
          role="dialog"
          aria-modal="true"
          aria-label="會員詳細資料"
        >
          <div
            className="max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-2xl border p-5"
            style={{ borderColor: 'var(--gold)', background: 'var(--space-1)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {detailQuery.isLoading ? (
              <LoadingBlock text="許願星搬緊會員資料…" />
            ) : detailQuery.isError ? (
              <p className="py-8 text-center text-[14px] text-pink-soft">
                載入失敗：{detailQuery.error.message}
              </p>
            ) : detail ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="text-[17px] font-bold text-txt-1">{detail.user.name}</h4>
                    <p className="mt-0.5 font-mono text-[13px] text-txt-3">
                      {detail.user.phone}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    aria-label="關閉"
                    className="rounded-lg p-1.5 text-txt-3 transition-colors hover:text-txt-1"
                  >
                    <X size={18} aria-hidden="true" />
                  </button>
                </div>

                {/* 基本資料 */}
                <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
                  <p className="text-txt-3">
                    Email：
                    <span className="font-mono text-txt-2">{detail.user.email || '—'}</span>
                  </p>
                  <p className="text-txt-3">
                    年齡：<span className="text-txt-2">{detail.user.age ?? '—'}</span>
                  </p>
                  <p className="text-txt-3">
                    註冊：
                    <span className="font-mono text-txt-2">{fmtDate(detail.user.createdAt)}</span>
                  </p>
                  <p className="text-txt-3">
                    訂單數：
                    <span className="font-mono text-txt-2">{detail.orderCount}</span>
                    <span className="ml-3">累計：</span>
                    <span className="font-mono text-pink">{fmtHKD(detail.totalSpent)}</span>
                  </p>
                  <p className="col-span-2 text-txt-3">
                    地址：
                    <span className="whitespace-pre-wrap text-txt-1">
                      {detail.user.address || '—'}
                    </span>
                  </p>
                </div>

                {/* 最近訂單 */}
                <h5 className="mt-5 text-[12px] font-bold tracking-[0.08em] text-gold">
                  最近訂單（最多 10 張）
                </h5>
                {detail.recentOrders.length === 0 ? (
                  <p className="mt-2 text-[13px] text-txt-3">暫時冇訂單。</p>
                ) : (
                  <ul className="mt-2 flex flex-col">
                    {detail.recentOrders.map((o) => (
                      <li
                        key={o.id}
                        className="flex items-center gap-3 border-t py-2 text-[13px]"
                        style={{ borderColor: 'var(--space-line)' }}
                      >
                        <span className="font-mono text-txt-1">{o.orderNo}</span>
                        <span className="hidden font-mono text-[12px] text-txt-3 sm:inline">
                          {fmtDateTime(o.createdAt)}
                        </span>
                        <span className="text-[12px] text-txt-3">
                          {DELIVERY_TEXT[o.deliveryMethod] ?? o.deliveryMethod}
                        </span>
                        <span className="ml-auto flex items-center gap-2">
                          <StatusBadge status={o.status} />
                          <span className="font-mono text-pink">{fmtHKD(o.total)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
