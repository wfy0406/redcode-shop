import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { trpc } from '@/providers/trpc';

/**
 * 推廣同意一次性彈窗（2026-08-06 Glo 要求，三態制）
 *
 * 三態推導（server 冇 backfill，靠現有數據推）：
 * - 接受：marketingOptIn = true
 * - 未選：marketingOptIn = false ＋ marketingPromptedAt IS NULL ＋
 *   2026-08-05 或之前註冊（香港時間 2026-08-06 00:00 前，即 < 2026-08-05T16:00:00Z）
 * - 唔接受：其他 marketingOptIn = false 嘅情況
 *
 * 「只彈一次」點做到：呢個 modal 淨係喺「未選」狀態先 render；
 * 會員撳「接受」定「唔接受」都會 call auth.respondMarketingPrompt，
 * server 寫 marketingPromptedAt = now → 三態推導即變「接受／唔接受」，
 * invalidate auth.me 之後 modal 就永遠唔會再出現（新會員註冊頁已有剔選格，唔受影響）。
 *
 * Glo 要求一定要揀一次：冇 X 掣、撳 backdrop 唔會閂。
 */

// 香港時間 2026-08-06 00:00 ＝ UTC 2026-08-05T16:00:00Z
const CONSENT_CUTOFF = new Date('2026-08-05T16:00:00.000Z');

export default function MarketingConsentModal() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [dismissed, setDismissed] = useState(false);

  const mutation = trpc.auth.respondMarketingPrompt.useMutation({
    onSuccess: async () => {
      await utils.auth.me.invalidate();
      setDismissed(true);
    },
  });

  const shouldShow =
    !!user &&
    user.role === 'member' &&
    !user.marketingOptIn &&
    !user.marketingPromptedAt &&
    !!user.createdAt &&
    new Date(user.createdAt) < CONSENT_CUTOFF &&
    !dismissed;

  if (!shouldShow) return null;

  const respond = (optIn: boolean) => {
    if (mutation.isPending) return;
    mutation.mutate({ optIn });
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* 撳 backdrop 唔會閂（Glo：要求佢選一次），所以冇 onClick */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" />
      <div
        className="relative w-full max-w-md rounded-2xl border p-6"
        style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="marketing-consent-title"
      >
        <h2
          id="marketing-consent-title"
          className="font-serif-tc text-xl font-bold text-txt-1"
        >
          RedCode 會員專屬優惠通知 🎁
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-txt-2">
          我哋隨時推出官網限定嘅大大優惠😍
          仲有新品速遞同會員專屬折扣！想第一時間收到優惠情報，而家揀「接受推廣資訊」就搞掂～
        </p>
        <div className="mt-5 flex flex-col gap-2.5">
          <button
            type="button"
            disabled={mutation.isPending}
            onClick={() => respond(true)}
            className="inline-flex h-11 w-full items-center justify-center rounded-full text-sm font-bold text-white transition-opacity disabled:opacity-60"
            style={{ background: 'var(--pink-soft)' }}
          >
            接受推廣資訊 😍
          </button>
          <button
            type="button"
            disabled={mutation.isPending}
            onClick={() => respond(false)}
            className="inline-flex h-11 w-full items-center justify-center rounded-full border text-sm text-txt-2 transition-colors hover:text-txt-1 disabled:opacity-60"
            style={{ borderColor: 'var(--space-line)', background: 'transparent' }}
          >
            唔接受
          </button>
        </div>
        {mutation.error && (
          <p className="mt-3 text-center text-xs text-pink-soft">
            {mutation.error.message || '更新失敗，請再試'}
          </p>
        )}
        <p className="mt-4 text-center text-xs text-txt-3">
          你可以隨時喺會員中心更改設定；唔接受嘅話都係唔會收到我哋嘅推廣訊息。
        </p>
      </div>
    </div>
  );
}
