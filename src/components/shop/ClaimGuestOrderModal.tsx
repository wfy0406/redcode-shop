/**
 * 訪客單移入會員旗下——確認彈窗（2026-10-09 查單擴展）
 * 觸發：訪客查單卡／付款頁嘅「移入會員訂單」制（未登入會先引導去登入，登入完返嚟自動彈）。
 * 文案（用戶指定）：「是否將該訪客訂單移入至你的會員【會員名】旗下？」
 * 確認 → trpc.orders.claimGuestOrder（後端再驗 guestToken，只改 userId，寄送方式同地址照舊）。
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { trpc } from '@/providers/trpc';
import { WishStarSpinner } from '@/components/cart/WishingStar';
import { StrokeCheck } from '@/components/shop/form-bits';

export default function ClaimGuestOrderModal({
  orderNo,
  guestToken,
  onClose,
  onClaimed,
}: {
  orderNo: string;
  guestToken: string;
  onClose: () => void;
  /** 成功移入後 callback（caller 負責清 URL params／refetch 列表） */
  onClaimed: () => void;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const claim = trpc.orders.claimGuestOrder.useMutation();

  const confirm = async () => {
    if (busy || done) return;
    setBusy(true);
    setError(null);
    try {
      await claim.mutateAsync({ orderNo, guestToken });
      setDone(true);
    } catch (e) {
      const code = (e as { data?: { code?: string } })?.data?.code;
      if (code === 'CONFLICT') setError('呢張單已經綁定咗另一個帳號，如有疑問 WhatsApp 我哋。');
      else if (code === 'UNAUTHORIZED') setError('登入已過期，請重新登入再試。');
      else setError('移入失敗，請稍後再試一次。');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center overflow-y-auto p-4">
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(4,2,10,0.82)' }}
        aria-hidden="true"
        onClick={busy ? undefined : onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="移入訪客訂單至會員旗下"
        className="relative my-auto w-full max-w-sm overflow-hidden rounded-3xl border"
        style={{
          borderColor: 'rgba(245,197,24,0.45)',
          background: 'linear-gradient(180deg, #1B0E33 0%, #120C24 65%)',
          boxShadow: '0 0 60px rgba(245,197,24,0.16)',
          animation: 'claimCardIn 380ms cubic-bezier(0.2,1.2,0.4,1)',
        }}
      >
        {done ? (
          /* ── 成功態 ── */
          <div className="px-6 pb-7 pt-8 text-center">
            <span
              className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border"
              style={{ color: 'var(--success)', borderColor: 'rgba(94,224,160,0.4)', background: 'rgba(94,224,160,0.08)' }}
            >
              <StrokeCheck size={26} />
            </span>
            <p className="script mt-4 text-3xl text-gold">It&apos;s yours ✦</p>
            <h2 className="mt-1 font-serif-tc text-[22px] font-bold leading-[1.35] text-txt-1">已移入你嘅會員旗下！</h2>
            <p className="mt-3 text-[13.5px] leading-[1.8] text-txt-2">
              訂單 <span className="font-mono font-bold text-gold">{orderNo}</span> 而家喺你「我的訂單」度睇到，
              寄送方式同地址維持不變。
            </p>
            <button
              type="button"
              onClick={() => {
                onClaimed();
                void navigate('/orders');
              }}
              className="mt-6 w-full rounded-full py-3 font-serif-tc text-[15.5px] font-bold tracking-[0.12em]"
              style={{
                background: 'linear-gradient(160deg, #F7D774 0%, #F5C518 55%, #C99B0F 100%)',
                color: '#241505',
                boxShadow: '0 6px 26px rgba(245,197,24,0.35)',
              }}
            >
              去我的訂單睇睇
            </button>
          </div>
        ) : (
          /* ── 確認態 ── */
          <div className="px-6 pb-7 pt-8 text-center">
            <p className="script text-3xl text-gold">Make it yours ✦</p>
            <h2 className="mt-1 font-serif-tc text-[22px] font-bold leading-[1.35] text-txt-1">
              移入訪客訂單？
            </h2>
            <p className="mt-3 text-[14px] leading-[1.85] text-txt-2">
              是否將訪客訂單 <span className="font-mono font-bold text-gold">{orderNo}</span>
              <br />
              移入至你的會員「<span className="font-semibold text-txt-1">{user?.name ?? ''}</span>」旗下？
            </p>
            <p className="mt-3 rounded-xl border px-4 py-2.5 text-[12.5px] leading-[1.7] text-txt-3" style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}>
              移入後訂單會按照原有寄送方式同地址寄送，資料唔會改動；之後喺「我的訂單」隨時查到進度。
            </p>
            {error && (
              <p role="alert" className="mt-3 text-[13px] text-pink-soft" style={{ animation: 'promo-fade-in .2s ease-out' }}>
                {error}
              </p>
            )}
            <div className="mt-6 flex flex-col gap-2.5">
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={busy}
                className="w-full rounded-full py-3 font-serif-tc text-[15.5px] font-bold tracking-[0.12em] disabled:opacity-60"
                style={{
                  background: 'linear-gradient(160deg, #F7D774 0%, #F5C518 55%, #C99B0F 100%)',
                  color: '#241505',
                  boxShadow: '0 6px 26px rgba(245,197,24,0.35)',
                }}
              >
                {busy ? <WishStarSpinner /> : '確認移入'}
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="w-full rounded-full border py-2.5 text-[13.5px] text-txt-2 transition-colors hover:text-txt-1"
                style={{ borderColor: 'var(--space-line)' }}
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>
      <style>{`
        @keyframes claimCardIn { 0% { transform: scale(0.86) translateY(18px); opacity: 0; } 100% { transform: scale(1) translateY(0); opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { [role="dialog"] { animation: none !important; } }
      `}</style>
    </div>,
    document.body,
  );
}
