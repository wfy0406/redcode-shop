/**
 * v2.5.1（購物金紀錄分頁，老闆指令）——會員中心／充值頁共用嘅購物金流水列表。
 *
 * 每頁 **15 筆**（server 分頁，trpc.wallet.myWallet { ledgerPage }）：
 * - 存入：付款方式（網上即時付款／手動上傳截圖）＋充值單號
 * - 使用：買咗咩（貨品摘要）＋訂單編號——**撳落去去返張訂單單據**（/receipt/:id）
 * - 返還：同上，連返張取消咗嘅訂單
 * 金額正負色（存入/返還金、扣減淡色），右上有「第 x/y 頁」前後頁掣。
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowDownToLine, ArrowUpFromLine, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import WishingStar from './WishingStar';
import { formatHKD } from '@/components/cart/format';

const TYPE_META: Record<string, { label: string; icon: typeof ArrowDownToLine; positive: boolean }> = {
  topup: { label: '存入', icon: ArrowDownToLine, positive: true },
  spend: { label: '使用', icon: ArrowUpFromLine, positive: false },
  refund: { label: '返還', icon: RotateCcw, positive: true },
};

const CHANNEL_LABEL: Record<string, string> = {
  airwallex: '網上即時付款',
  manual: '手動上傳截圖',
};

/** ISO → 10月9日 14:32 */
function fmtShort(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('zh-HK', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Hong_Kong',
  });
}

export default function WalletLedgerList({
  /** 空紀錄時嘅提示語；唔想顯示可以傳 null */
  emptyText = '仲未有購物金紀錄。',
}: {
  emptyText?: string | null;
}) {
  const [page, setPage] = useState(1);
  const walletQuery = trpc.wallet.myWallet.useQuery({ ledgerPage: page });

  if (walletQuery.isLoading) {
    return (
      <div className="flex items-center gap-3 py-3 text-[13px] text-txt-3">
        <WishingStar size={16} spinning />
        許願星搬緊紀錄…
      </div>
    );
  }
  if (walletQuery.isError || !walletQuery.data) return null;

  const { ledger, ledgerTotal, ledgerPageSize, orderInfoByNo, channelByTopupNo } = walletQuery.data;
  const totalPages = Math.max(1, Math.ceil(ledgerTotal / ledgerPageSize));

  if (ledger.length === 0) {
    return emptyText ? <p className="py-2 text-[13px] text-txt-3">{emptyText}</p> : null;
  }

  return (
    <div>
      <div className="flex flex-col gap-2.5">
        {ledger.map((l) => {
          const meta = TYPE_META[l.type] ?? { label: l.type, icon: ArrowDownToLine, positive: l.amount >= 0 };
          const Icon = meta.icon;
          const orderInfo = l.refType === 'order' ? orderInfoByNo[l.refId] : undefined;
          const channel = l.refType === 'topup' ? channelByTopupNo[l.refId] : undefined;
          return (
            <div
              key={l.id}
              className="flex items-center justify-between gap-4 rounded-xl border px-4 py-2.5"
              style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
            >
              <div className="flex min-w-0 items-start gap-3">
                <span
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border"
                  style={{
                    borderColor: meta.positive ? 'color-mix(in srgb, var(--gold) 45%, transparent)' : 'var(--space-line)',
                    color: meta.positive ? 'var(--gold)' : 'var(--text-2)',
                  }}
                >
                  <Icon size={13} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] text-txt-1">
                    <span className="font-semibold">{meta.label}</span>
                    {channel && (
                      <span className="ml-2 text-[12px] text-txt-3">
                        經{CHANNEL_LABEL[channel] ?? channel}
                      </span>
                    )}
                  </p>
                  {/* 使用／返還：買咗咩＋訂單連結（撳落去睇返張訂單） */}
                  {orderInfo ? (
                    <p className="mt-0.5 text-[12px] text-txt-2">
                      <span className="line-clamp-1">{orderInfo.summary}</span>
                      <Link
                        to={`/receipt/${orderInfo.id}`}
                        className="ml-1.5 font-mono text-lavender underline underline-offset-4 transition-colors hover:text-txt-1"
                      >
                        {l.refId} →
                      </Link>
                    </p>
                  ) : l.refType === 'order' ? (
                    <p className="mt-0.5 font-mono text-[12px] text-txt-3">{l.refId}</p>
                  ) : null}
                  {l.refType === 'topup' && (
                    <p className="mt-0.5 font-mono text-[12px] text-txt-3">{l.refId}</p>
                  )}
                  {l.note && l.type === 'spend' && !orderInfo && (
                    <p className="mt-0.5 text-[12px] text-txt-3">{l.note}</p>
                  )}
                  <p className="mt-0.5 font-mono text-[11.5px] text-txt-3">{fmtShort(l.createdAt)}</p>
                </div>
              </div>
              <span
                className={`shrink-0 font-mono text-[14px] font-bold ${
                  l.amount >= 0 ? 'text-gold' : 'text-txt-2'
                }`}
              >
                {l.amount >= 0 ? '+' : '−'}
                {formatHKD(Math.abs(l.amount))}
              </span>
            </div>
          );
        })}
      </div>

      {/* 分頁掣（每頁 15 筆，server 分頁） */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            disabled={page <= 1 || walletQuery.isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="btn btn-ghost !px-3 !py-1.5 text-[12.5px] disabled:opacity-40"
          >
            <ChevronLeft size={14} aria-hidden="true" />
            上一頁
          </button>
          <span className="font-mono text-[12px] text-txt-3">
            {walletQuery.isFetching ? '搬緊…' : `第 ${page}／${totalPages} 頁 · 共 ${ledgerTotal} 筆`}
          </span>
          <button
            type="button"
            disabled={page >= totalPages || walletQuery.isFetching}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="btn btn-ghost !px-3 !py-1.5 text-[12.5px] disabled:opacity-40"
          >
            下一頁
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
