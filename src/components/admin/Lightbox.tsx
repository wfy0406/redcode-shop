import { useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * 付款截圖燈箱 —— §P9：click 開燈箱 1:1 睇，--space-0 罩底
 * Esc 或點罩底關閉。
 */
export default function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-auto p-4"
      style={{ background: 'rgba(7, 3, 15, 0.94)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="付款截圖大圖"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="關閉大圖"
        className="btn btn-secondary absolute right-4 top-4 !h-11 !w-11 !rounded-full !p-0"
      >
        <X size={20} aria-hidden="true" />
      </button>
      <img
        src={src}
        alt="付款截圖原圖"
        className="max-h-[92vh] max-w-[92vw] rounded-xl border object-contain"
        style={{ borderColor: 'var(--glass-border)' }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
