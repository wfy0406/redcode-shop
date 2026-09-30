import { useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * 官網內全屏直度播放器（v2.2.11 老闆指令：
 * 「放大睇唔好導去 FB」「反正直播一定係打直」）
 *
 * fixed inset-0 黑底，9:16 直度 iframe 置中（高 100dvh、按比例出闊）；
 * 撳 ✕ 或黑底收返，唔離開官網。開嘅時候鎖 body scroll。
 * 動效淨 opacity fade（合老闆鐵律；reduced-motion 停）。
 */
export default function FbPlayerOverlay({
  src,
  title,
  onClose,
}: {
  src: string;
  title: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div
      className="fbp-overlay fixed inset-0 z-[80] flex items-center justify-center"
      style={{ background: 'rgba(4,2,10,0.96)' }}
      onClick={onClose}
      role="dialog"
      aria-label={title}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="收返"
        className="absolute right-4 top-4 z-10 flex h-11 w-11 items-center justify-center rounded-full border text-gold"
        style={{ borderColor: 'rgba(245,197,24,0.45)', background: 'rgba(10,6,20,0.8)' }}
      >
        <X size={18} aria-hidden="true" />
      </button>
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative"
        style={{ height: '100dvh', maxWidth: '100vw', aspectRatio: '9 / 16' }}
      >
        <iframe
          src={src}
          className="absolute inset-0 h-full w-full border-0"
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          title={title}
        />
      </div>
      <style>{`
        .fbp-overlay { animation: fbp-in 0.25s ease-out; }
        @keyframes fbp-in { from { opacity: 0; } to { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .fbp-overlay { animation: none; } }
      `}</style>
    </div>
  );
}
