import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, X } from 'lucide-react';
import { openFacebookLive } from '@/lib/openLive';

/**
 * 官網內全屏直度播放器（v2.2.11 老闆指令：
 * 「放大睇唔好導去 FB」「反正直播一定係打直」）
 *
 * fixed inset-0 黑底，9:16 直度 iframe 置中（高 100dvh、按比例出闊）；
 * 撳 ✕ 或黑底收返，唔離開官網。開嘅時候鎖 body scroll。
 * 動效淨 opacity fade（合老闆鐵律；reduced-motion 停）。
 *
 * v2.2.12 修復（老闆回報「上面條 bar 遮住咗」）：
 * 改用 createPortal 直掛 document.body——舊版喺 section 入面 render，
 * 上層有 transform／backdrop-filter 時 fixed 會失效，頁頂 Navbar 就會蓋過嚟。
 * 掛去 body＋z-index 9999，保證永遠喺最頂。
 */
export default function FbPlayerOverlay({
  src,
  fbUrl,
  title,
  onClose,
}: {
  src: string;
  /** v2.2.12（老闆指令）：底部「去 Facebook 睇」——有寶寶想返 FB 留言互動；v2.2.21 起經 /live-go-v6.html 跳板（推播成功路線），保證落到指定條片 */
  fbUrl?: string;
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

  return createPortal(
    <div
      className="fbp-overlay fixed inset-0 flex items-center justify-center"
      style={{ background: 'rgba(4,2,10,0.96)', zIndex: 9999 }}
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
      {/* 底部「去 Facebook 睇」：想留言互動嘅寶寶一撳經 v6 跳板去 FB 條片（推播成功路線） */}
      {fbUrl && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openFacebookLive(fbUrl);
          }}
          className="absolute bottom-5 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-5 py-2.5 text-[13px] font-medium text-pink-soft"
          style={{ borderColor: 'rgba(255,0,84,0.4)', background: 'rgba(10,6,20,0.8)' }}
          aria-label="去 Facebook 睇（有裝 app 會開 app）"
        >
          去 Facebook 睇
          <ExternalLink size={13} aria-hidden="true" />
        </button>
      )}
      <style>{`
        .fbp-overlay { animation: fbp-in 0.25s ease-out; }
        @keyframes fbp-in { from { opacity: 0; } to { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .fbp-overlay { animation: none; } }
      `}</style>
    </div>,
    document.body,
  );
}
