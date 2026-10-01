import { useEffect, useRef, useState } from 'react';
import { videoHasRealAlpha } from '@/lib/alphaVideo';

/**
 * v2.2.34（老闆指令）：關於區兩個「會郁」嘅透明 Glo Glo —— 真・透明背景影片。
 * 上版用「假透底」（將畫面焗落頁底色），但人一跳、transform 一郁，
 * 焗死咗嘅背景就走位——成塊背景出晒嚟（老闆電話實測發現）。
 * 而家改用 RVM 逐幀 matting 出真 alpha：VP9 alpha WebM 行先，
 * 瀏覽器解唔到 alpha（Safari）→ canvas probe 一驗即知，轉真 alpha 動畫 WebP；
 * 再兜底係透明 webp poster。三層都係真透底，任何底色都唔會甩。
 *
 * 設計守鐵律（唔好整慢客人電話）：
 * - 入 viewport（提前 240px）先 mount <video>，慳數據慳電
 * - prefers-reduced-motion → 淨顯示靜態 webp
 * - 冇 CSS looping 背景動畫；淨係影片本身郁＋video/poster 嘅 transform 微動畫（見 index.css）
 */
export default function GloCutout({
  videoSrc,
  animSrc,
  poster,
  alt,
  className,
  animClass,
  eager = false,
}: {
  /** 真 alpha VP9 WebM（Chrome/Android/Firefox/Edge） */
  videoSrc: string;
  /** 真 alpha 動畫 WebP（Safari／解唔到 alpha 嘅瀏覽器） */
  animSrc: string;
  /** 透明 webp poster（載入前／reduced-motion／兩條片都掛嘅最終兜底） */
  poster: string;
  alt: string;
  className?: string;
  /** 微動畫 class（glo-sway / glo-hop）——直接落喺 video＋img 度 */
  animClass?: string;
  eager?: boolean;
}) {
  const [reduced] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(eager);
  // poster=靜態兜底；video=真 alpha WebM 播緊；anim=動畫 WebP（Safari 或 WebM 掛咗）
  const [mode, setMode] = useState<'poster' | 'video' | 'anim'>('poster');

  useEffect(() => {
    if (near || reduced) return;
    const el = hostRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: '240px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, reduced]);

  return (
    <div ref={hostRef} className={`relative ${className ?? ''}`}>
      {/* 靜態透底 poster：影片一播／動畫 WebP 一上就收（opacity transition） */}
      <img
        src={poster}
        alt={alt}
        width={360}
        height={640}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        className={`h-auto w-full transition-opacity duration-300 ${animClass ?? ''} ${
          mode === 'poster' ? 'opacity-100' : 'opacity-0'
        }`}
      />
      {near && !reduced && mode !== 'anim' && (
        <video
          src={videoSrc}
          className={`absolute inset-0 h-full w-full object-contain ${animClass ?? ''}`}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-hidden="true"
          onPlaying={(e) => setMode(videoHasRealAlpha(e.currentTarget) ? 'video' : 'anim')}
          onError={() => setMode('anim')}
        />
      )}
      {/* Safari／解唔到 WebM alpha：真 alpha 動畫 WebP，<img> 直出，乜瀏覽器都透 */}
      {mode === 'anim' && !reduced && (
        <img
          src={animSrc}
          alt=""
          aria-hidden="true"
          width={360}
          height={640}
          className={`absolute inset-0 h-full w-full object-contain ${animClass ?? ''}`}
          onError={() => setMode('poster')}
        />
      )}
    </div>
  );
}
