import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, RotateCw, X } from 'lucide-react';
import { openFacebookLive } from '@/lib/openLive';

/**
 * 官網內全屏直度播放器（v2.2.11 老闆指令：
 * 「放大睇唔好導去 FB」「反正直播一定係打直」）
 *
 * fixed inset-0 黑底，9:16 直度 iframe 置中（實數 pixel 裝入屏幕）；
 * 撳 ✕ 或黑底收返，唔離開官網。開嘅時候鎖 body scroll。
 * 動效淨 opacity fade（合老闆鐵律；reduced-motion 停）。
 *
 * v2.2.12 修復（老闆回報「上面條 bar 遮住咗」）：
 * 改用 createPortal 直掛 document.body——舊版喺 section 入面 render，
 * 上層有 transform／backdrop-filter 時 fixed 會失效，頁頂 Navbar 就會蓋過嚟。
 * 掛去 body＋z-index 9999，保證永遠喺最頂。
 *
 * v2.2.31 修復（老闆 iPhone 實測「放大播跟住會卡住」——撳 ▶ 後黑屏，
 * 之後播幾秒就 freeze 喺一格；放大思路老闆確認係啱，所以保留 overlay）：
 * iOS Safari 喺 iframe 未完成 layout／fade 未行完（opacity 仲近 0）嗰刻
 * 俾 FB 播放器 init，會量到錯尺寸、decode 企唔穩 → 黑屏／播幾秒 freeze。
 * 修復三寶：
 * 1. 等 overlay fade（250ms）行完、量度好實數 pixel 先 mount iframe，
 *    FB 開波嗰陣一定攞到真尺寸；
 * 2. iframe 用實數 width/height attribute＋style（FB plugin init 係讀 attribute，
 *    百分比闊度喺 iOS aspect-ratio 盒會度出怪尺寸）；
 * 3. 底部加「重新載入」掣：真係再卡住，一撳 remount 成個播放器（key 跳），
 *    唔使閂咗 overlay 再開。
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
  // v2.2.31：播放器外盒實數尺寸（9:16 裝入部機屏幕，闊唔好超出 100vw）
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  // iframe 等 overlay 落位先 mount（iOS 企穩先開波）
  const [mountFrame, setMountFrame] = useState(false);
  // 重新載入次數——入 key 強制 remount iframe
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    setMountFrame(false);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let h = vh;
    let w = Math.round((h * 9) / 16);
    if (w > vw) {
      w = vw;
      h = Math.round((w * 16) / 9);
    }
    setBox({ w, h });
    // fade（250ms）行完先 mount iframe；iOS 嗰下 layout 一定已 settle
    const t = window.setTimeout(() => setMountFrame(true), 260);
    return () => window.clearTimeout(t);
  }, [reloadKey]);

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
        style={box ? { width: box.w, height: box.h } : { width: '100vw', height: '100dvh' }}
      >
        {mountFrame && box ? (
          <iframe
            key={reloadKey}
            src={src}
            width={box.w}
            height={box.h}
            style={{ width: box.w, height: box.h }}
            className="block border-0"
            scrolling="no"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            title={title}
          />
        ) : (
          // v2.2.31：iframe 未 mount 前嘅載入位——金圈轉（transform，合鐵律），唔再黑屏
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <span
              aria-hidden="true"
              className="fbp-spinner block h-10 w-10 rounded-full border-2"
              style={{ borderColor: 'rgba(245,197,24,0.25)', borderTopColor: 'var(--gold)' }}
            />
            <span className="text-[13px] tracking-[0.15em] text-txt-3">直播載入緊…</span>
          </div>
        )}
      </div>
      {/* 底部掣行：重新載入（卡住自救）＋「去 Facebook 睇」（想返 FB 留言互動，經 v6 跳板） */}
      <div className="absolute bottom-5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setReloadKey((k) => k + 1);
          }}
          className="inline-flex items-center gap-1.5 rounded-full border px-4 py-2.5 text-[13px] font-medium text-gold-soft"
          style={{ borderColor: 'rgba(245,197,24,0.4)', background: 'rgba(10,6,20,0.8)' }}
          aria-label="重新載入播放器（卡住時撳）"
        >
          <RotateCw size={13} aria-hidden="true" />
          重新載入
        </button>
        {fbUrl && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openFacebookLive(fbUrl);
            }}
            className="inline-flex items-center gap-1.5 rounded-full border px-5 py-2.5 text-[13px] font-medium text-pink-soft"
            style={{ borderColor: 'rgba(255,0,84,0.4)', background: 'rgba(10,6,20,0.8)' }}
            aria-label="去 Facebook 睇（有裝 app 會開 app）"
          >
            去 Facebook 睇
            <ExternalLink size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      <style>{`
        .fbp-overlay { animation: fbp-in 0.25s ease-out; }
        @keyframes fbp-in { from { opacity: 0; } to { opacity: 1; } }
        .fbp-spinner { animation: fbp-spin 0.9s linear infinite; }
        @keyframes fbp-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .fbp-overlay { animation: none; } }
      `}</style>
    </div>,
    document.body,
  );
}
