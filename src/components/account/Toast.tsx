import { useCallback, useRef, useState } from 'react';
import { Check } from 'lucide-react';

/**
 * 會員中心玻璃 toast（App 未掛 <Toaster/>，唔好用 sonner —— 跟 shop/AddedToast 玻璃 pattern）
 * glass-bg-strong + blur + 1px glass-border；底部浮出，3.6s 自動收。
 */

export interface AccountToastMsg {
  id: number;
  text: string;
}

/** toast 狀態 hook：push 後 3.6s 自動消失 */
export function useAccountToasts() {
  const [toasts, setToasts] = useState<AccountToastMsg[]>([]);
  const idRef = useRef(0);

  const push = useCallback((text: string) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev.slice(-2), { id, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3600);
  }, []);

  return { toasts, push };
}

export default function AccountToastStack({ toasts }: { toasts: AccountToastMsg[] }) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="account-toast pointer-events-auto flex items-center gap-3 rounded-2xl px-5 py-3"
          style={{
            background: 'var(--glass-bg-strong)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid var(--glass-border)',
          }}
        >
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success text-space-1"
            aria-hidden="true"
          >
            <Check size={14} />
          </span>
          <p className="whitespace-nowrap text-sm text-txt-1">{t.text}</p>
        </div>
      ))}
      <style>{`
        .account-toast { animation: account-toast-in 300ms var(--ease-expo) both; }
        @keyframes account-toast-in {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .account-toast { animation: none; }
        }
      `}</style>
    </div>
  );
}
