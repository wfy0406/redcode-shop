import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import GoogleLoginButton from './GoogleLoginButton';
import WishingStar from './WishingStar';

/**
 * 「連結 Google 帳號」卡（2026-08-04 Glo 要求）
 * 舊會員（電話＋密碼開戶）喺會員中心綁定自己嘅 Google 帳號：
 * 連結後 googleSub 寫入會員行，之後登入頁撳「以 Google 登入」直入呢個帳號，
 * 唔使再入電話同密碼（電話登入照舊用到，兩样並存）。
 * - GOOGLE_CLIENT_ID 未設 → 成張卡靜默隱藏（同登入頁 Google 掣一致）
 * - 已連結 → 顯示 ✓ 狀態，唔再顯示掣
 * - 同一個 Google 帳號只可以綁一個會員（後端 CONFLICT 把關）
 */

interface GoogleLinkCardProps {
  linked: boolean;
  pushToast: (text: string) => void;
}

export default function GoogleLinkCard({ linked, pushToast }: GoogleLinkCardProps) {
  const utils = trpc.useUtils();
  const configQuery = trpc.auth.googleConfig.useQuery(undefined, {
    staleTime: 300_000,
    retry: false,
  });
  const linkGoogle = trpc.auth.linkGoogle.useMutation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // env 未設 Google Client ID → 隱藏成張卡（載入中都係 null，出咗 clientId 先彈入）
  if (!configQuery.data?.clientId) return null;

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
      <div className="flex items-center gap-4">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border"
          style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}
        >
          <Link2 size={20} aria-hidden="true" />
        </span>
        <div>
          <h2 className="font-serif-tc text-lg font-bold text-txt-1">連結 Google 帳號</h2>
          <p className="text-sm text-txt-3">一撳登入，唔使再入電話同密碼</p>
        </div>
      </div>

      {linked ? (
        <>
          <p
            className="mt-5 flex items-center gap-2 rounded-xl border px-4 py-3 text-[14px] font-medium text-txt-1"
            style={{ borderColor: 'var(--success)', background: 'var(--glass-bg-strong)' }}
          >
            <span aria-hidden="true" style={{ color: 'var(--success)' }}>
              ✓
            </span>
            已連結 Google 帳號
          </p>
          <p className="mt-3 text-[13px] leading-[1.7] text-txt-3">
            下次喺登入頁撳「以 Google 登入」就直入你嘅帳號；電話＋密碼登入照舊用到。
          </p>
        </>
      ) : (
        <>
          <p className="mt-5 text-[14px] leading-[1.8] text-txt-2">
            你而家係用電話＋密碼登入。連結咗 Google 之後，下次喺登入頁撳「以 Google
            登入」一撳就入到（電話登入照舊用到，唔會整唔見舊資料）。
          </p>

          {error && (
            <p
              role="alert"
              className="mt-4 flex items-center gap-2 rounded-xl border border-pink bg-space-2 px-4 py-3 text-[13px] text-pink-soft"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                className="shrink-0"
              >
                <path
                  d="M12 1.5C13 6.8 17.2 11 22.5 12C17.2 13 13 17.2 12 22.5C11 17.2 6.8 13 1.5 12C6.8 11 11 6.8 12 1.5Z"
                  fill="var(--gold)"
                />
              </svg>
              {error}
            </p>
          )}

          <div className="mt-4">
            {busy ? (
              <p className="flex min-h-[44px] items-center justify-center gap-2 text-sm text-txt-2">
                <WishingStar size={16} spinning /> 連結緊…
              </p>
            ) : (
              <GoogleLoginButton
                text="continue_with"
                onCredential={async (idToken) => {
                  setError(null);
                  setBusy(true);
                  try {
                    await linkGoogle.mutateAsync({ idToken });
                    await utils.auth.me.invalidate();
                    pushToast('Google 帳號已連結 ✓');
                    // 唔使自己收掣：linked 一變 true，上面就轉咗做 ✓ 狀態
                  } catch (err) {
                    setError(
                      err instanceof Error && err.message ? err.message : '連結失敗，請稍後再試',
                    );
                    setBusy(false);
                  }
                }}
                onError={(msg) => setError(msg)}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
