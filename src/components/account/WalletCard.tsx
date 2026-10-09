import { Link } from 'react-router';
import { ArrowRight, Wallet } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import WishingStar from './WishingStar';
import WalletLedgerList from './WalletLedgerList';
import { formatHKD } from '@/components/cart/format';

/**
 * v2.5.1（會員購物金）會員中心購物金卡—— trpc.wallet.myWallet
 * 內容：而家餘額（金框大字）＋購物金紀錄（每頁 15 筆分頁；存入有付款方式、
 * 使用／返還有貨品摘要＋訂單連結）＋待批核／待付款充值單提示＋「去充值 →」。
 * 設計跟會員中心玻璃卡風格，金框呼應購物金主題；金額全部整數港元。
 * 載入失敗唔阻住會員中心，成張卡收埋（同 VipCard 一致）。
 */

const TOPUP_STATUS_LABEL: Record<string, string> = {
  pending_payment: '待付款',
  payment_review: '待批核',
  approved: '已入帳',
  rejected: '已拒絕',
  cancelled: '已取消',
};

export default function WalletCard() {
  const walletQuery = trpc.wallet.myWallet.useQuery();

  if (walletQuery.isError) return null;

  const wallet = walletQuery.data;
  // 需要客人跟進嘅充值單（待付款／待批核）置頂提示
  const openTopups =
    wallet?.topups.filter((t) => t.status === 'pending_payment' || t.status === 'payment_review') ??
    [];

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{
        borderColor: 'var(--gold)',
        background: 'var(--glass-bg)',
        boxShadow: '0 0 24px rgba(171, 140, 82, 0.14)',
      }}
      aria-label="我的購物金"
    >
      {walletQuery.isLoading || !wallet ? (
        <div className="flex items-center gap-3 py-4 text-[13px] text-txt-3">
          <WishingStar size={18} spinning />
          許願星搬緊你嘅購物金…
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
            <div className="flex items-center gap-4">
              <span
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border"
                style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}
              >
                <Wallet size={22} aria-hidden="true" />
              </span>
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-gold">
                  購物金餘額
                </p>
                <p className="mt-1 font-serif-tc text-3xl font-bold leading-none text-starlight">
                  {formatHKD(wallet.balance)}
                </p>
              </div>
            </div>
            <Link to="/wallet-topup" className="btn btn-primary !px-5 !py-2.5 text-[13px]">
              去充值
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </div>

          {/* 待跟進充值單提示 */}
          {openTopups.length > 0 && (
            <div
              className="mt-5 rounded-xl border px-4 py-3 text-[13px] leading-relaxed"
              style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
            >
              {openTopups.map((t) => (
                <p key={t.id} className="text-txt-2">
                  <span className="font-mono text-txt-1">{t.topupNo}</span>
                  <span className="mx-2 text-gold">{TOPUP_STATUS_LABEL[t.status] ?? t.status}</span>
                  {t.status === 'pending_payment'
                    ? '未付款｜30 分鐘內付款，逾時自動取消'
                    : '已收款，等同事批核入帳'}
                  {t.status === 'pending_payment' && (
                    <Link to="/wallet-topup" className="ml-2 text-lavender underline underline-offset-4">
                      去付款
                    </Link>
                  )}
                </p>
              ))}
            </div>
          )}

          {/* 購物金紀錄（每頁 15 筆；存入有付款方式、使用/返還有訂單連結） */}
          <div className="mt-5">
            <p className="mb-2.5 font-mono text-[11px] uppercase tracking-[0.24em] text-gold">
              購物金紀錄
            </p>
            <WalletLedgerList emptyText="仲未有購物金紀錄。充值後結帳可以直接用購物金扣數，快過過數 ♡" />
          </div>
        </>
      )}
    </section>
  );
}
