import { useEffect } from 'react';
import { Link } from 'react-router';
import { Check } from 'lucide-react';

/**
 * 加入購物車成功後嘅細玻璃提示（toast 替代品 —— App 未掛 <Toaster/>，唔好用 sonner）。
 * glass-bg-strong + blur + 1px glass-border；底部浮出，4 秒自動收。
 */
interface AddedToastProps {
  show: boolean;
  productName: string;
  onClose: () => void;
}

export default function AddedToast({ show, productName, onClose }: AddedToastProps) {
  useEffect(() => {
    if (!show) return;
    const id = window.setTimeout(onClose, 4000);
    return () => window.clearTimeout(id);
  }, [show, onClose]);

  if (!show) return null;

  return (
    <div
      role="status"
      className="added-toast fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-2xl px-5 py-3"
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
      <p className="whitespace-nowrap text-sm text-txt-1">
        已將 <span className="font-bold">{productName}</span> 加入購物車
      </p>
      <Link
        to="/cart"
        className="whitespace-nowrap text-sm font-bold text-pink-soft transition-colors hover:text-pink-tint"
      >
        去購物車 →
      </Link>
      <style>{`
        .added-toast { animation: added-toast-in 300ms var(--ease-expo) both; }
        @keyframes added-toast-in {
          from { opacity: 0; transform: translate(-50%, 12px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .added-toast { animation: none; }
        }
      `}</style>
    </div>
  );
}
