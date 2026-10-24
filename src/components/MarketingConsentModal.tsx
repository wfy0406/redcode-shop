import { useState } from 'react';
import { useLocation } from 'react-router';
import { ChevronDown } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { trpc } from '@/providers/trpc';

/**
 * 推廣同意原位摺疊卡（2026-10 batch1 UX 改造：唔再係全屏強制二揀一彈窗）
 *
 * 三態推導（server 冇 backfill，靠現有數據推）：
 * - 接受：marketingOptIn = true
 * - 未選：marketingOptIn = false ＋ marketingPromptedAt IS NULL ＋
 *   2026-08-05 或之前註冊（香港時間 2026-08-06 00:00 前，即 < 2026-08-05T16:00:00Z）
 * - 唔接受：其他 marketingOptIn = false 嘅情況
 *
 * 「只問一次」點做到：呢張卡淨係喺「未選」狀態先 render；
 * 會員撳「接受」定「唔接受」都會 call auth.respondMarketingPrompt，
 * server 寫 marketingPromptedAt = now → 三態推導即變「接受／唔接受」，
 * invalidate auth.me 之後卡就永遠唔會再出現（新會員註冊頁已有剔選格，唔受影響）。
 * 「稍後再話我知」只係摺起張卡，唔會提交，下次入會員中心會再展開。
 *
 * 掛載：應掛喺會員中心（/account）頂部做原位卡；組件自身會 gate 住只喺
 * /account 路由顯示，就算暫時掛喺 Layout 都唔會騷擾其他頁。
 */

// 香港時間 2026-08-06 00:00 ＝ UTC 2026-08-05T16:00:00Z
const CONSENT_CUTOFF = new Date('2026-08-05T16:00:00.000Z');

export default function MarketingConsentModal() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const { pathname } = useLocation();
  const [dismissed, setDismissed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

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
    !dismissed &&
    // 原位卡只喺會員中心出現（唔再全站彈窗截停）
    pathname.startsWith('/account');

  if (!shouldShow) return null;

  const respond = (optIn: boolean) => {
    if (mutation.isPending) return;
    mutation.mutate({ optIn });
  };

  return (
    <section
      aria-label="RedCode 會員專屬優惠通知"
      className="rounded-2xl border"
      style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
    >
      {/* 標題行：摺起嗰陣淨係呢行；撳右側掣展開（44px 觸控） */}
      <div className="flex items-center justify-between gap-3 px-5 py-3">
        <h2 className="font-serif-tc text-base font-bold text-txt-1">
          RedCode 會員專屬優惠通知 🎁
        </h2>
        {collapsed ? (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="flex min-h-11 shrink-0 items-center gap-1 rounded-full px-3 text-sm font-bold text-gold transition-colors hover:text-gold-soft"
            aria-expanded={false}
          >
            揀返
            <ChevronDown size={18} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="flex min-h-11 shrink-0 items-center gap-1 rounded-full px-3 text-sm text-txt-3 transition-colors hover:text-txt-1"
            aria-expanded={true}
          >
            稍後再話我知
            <ChevronDown size={18} aria-hidden="true" className="rotate-180" />
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="border-t px-5 pb-5 pt-4" style={{ borderColor: 'var(--space-line)' }}>
          <p className="text-sm leading-relaxed text-txt-2">
            我哋隨時推出官網限定嘅大大優惠😍
            仲有新品速遞同會員專屬折扣！想第一時間收到優惠情報，而家揀「接受推廣資訊」就搞掂～
          </p>
          <div className="mt-4 flex flex-col gap-2.5">
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
            <p role="alert" className="mt-3 text-center text-sm text-pink-soft">
              {mutation.error.message || '更新失敗，請再試'}
            </p>
          )}
          <p className="mt-4 text-center text-sm text-txt-3">
            你可以隨時喺會員中心更改設定；唔接受嘅話都係唔會收到我哋嘅推廣訊息。
          </p>
        </div>
      )}
    </section>
  );
}
