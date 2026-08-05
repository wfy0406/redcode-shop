import { useState } from 'react';
import { Link } from 'react-router';
import { Megaphone } from 'lucide-react';
import { trpc } from '@/providers/trpc';

/**
 * 優惠資訊接收設定卡（2026-08-05 Glo 要求，PDPO 第 6A 部）
 * 會員喺會員中心自己隨時開/關直接促銷同意（marketingOptIn）：
 * - 開＝後端記新同意時間（marketingOptInAt）；關＝保留當初同意紀錄，動作記落操作日誌
 * - 關咗之後，後台「促銷電郵」功能唔會再寄推廣信畀佢
 * - 說明文字連去私隱政策第 7 節（直接促銷），同註冊頁剔選格講法一致
 */
export default function MarketingPrefCard({
  optIn,
  pushToast,
}: {
  optIn: boolean;
  pushToast: (text: string) => void;
}) {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.auth.setMarketingOptIn.useMutation({
    onSuccess: async (user) => {
      await utils.auth.me.invalidate();
      pushToast(
        user?.marketingOptIn
          ? '已開啟優惠資訊通知 ✓'
          : '已關閉優惠資訊通知，唔會再收到推廣訊息',
      );
    },
    onError: (err) => setError(err.message || '更新失敗，請再試'),
  });

  const toggle = () => {
    if (mutation.isPending) return;
    setError(null);
    mutation.mutate({ optIn: !optIn });
  };

  return (
    <div
      className="rounded-2xl border p-6 md:p-8"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderColor: 'var(--glass-border)',
      }}
    >
      <div className="flex items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border"
          style={{ borderColor: 'var(--pink-soft)', color: 'var(--pink-soft)' }}
        >
          <Megaphone size={20} aria-hidden="true" />
        </span>
        <div>
          <h2 className="font-serif-tc text-lg font-bold text-txt-1">優惠資訊</h2>
          <p className="text-sm text-txt-3">商品、直播同優惠資訊通知</p>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-space-line pt-4">
        <div className="min-w-0">
          <p className="text-[15px] text-txt-1">
            狀態：{' '}
            {optIn ? (
              <span className="font-medium text-pink-soft">接收緊</span>
            ) : (
              <span className="text-txt-3">冇接收</span>
            )}
          </p>
          <p className="mt-1.5 text-[13px] leading-[1.7] text-txt-3">
            開啟即同意 RedCode 用你嘅姓名、電話同 Email，經電郵或 WhatsApp
            發送商品、直播同優惠資訊畀你。可以隨時喺度免費關閉，詳情見
            <Link to="/privacy" className="text-lavender underline underline-offset-4 transition-colors hover:text-txt-1">
              私隱政策第 7 節
            </Link>
            。
          </p>
        </div>
        {/* 開關掣：粉紅＝接收緊；灰＝冇接收。撳一下即改，唔使確認 */}
        <button
          type="button"
          role="switch"
          aria-checked={optIn}
          aria-label="接收優惠資訊"
          onClick={toggle}
          disabled={mutation.isPending}
          className="relative h-7 w-12 shrink-0 rounded-full border transition-colors duration-200 disabled:opacity-50"
          style={{
            borderColor: optIn ? 'var(--pink-soft)' : 'var(--space-line)',
            background: optIn ? 'rgba(255, 0, 132, 0.35)' : 'var(--space-2)',
          }}
        >
          <span
            className="absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full transition-all duration-200"
            style={{
              left: optIn ? 'calc(100% - 22px)' : '3px',
              background: optIn ? 'var(--pink-soft)' : 'var(--text-3)',
            }}
            aria-hidden="true"
          />
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-pink-soft">
          {error}
        </p>
      )}
    </div>
  );
}
