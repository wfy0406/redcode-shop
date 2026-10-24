import { useEffect, useRef, useState } from 'react';
import { usePageVisible } from '@/hooks/usePageVisible';

/**
 * 哈利波特式「會郁嘅相」（v2.2.31 老闆指令：真人相變動態——揮手／抱抱／擺 pose，
 * 但人樣唔准郁）——AI image-to-video 由張相本身做第一格，樣貌 100% 唔變。
 *
 * 用法同 <img> 接近：poster 係靜態 jpg（即刻出、SEO/兜底），
 * 旁邊有同名 mp4 就疊住循環播（靜音 playsInline，手機瀏覽器准 autoplay）。
 *
 * 設計守鐵律（唔好整慢客人電話）：
 * - mp4 未整好／404 → onError 即刻收埋 video，永遠有靜態相兜底
 * - prefers-reduced-motion → 淨顯示靜態相
 * - eager=false 時入 viewport（提前 240px）先 mount <video>，慳數據慳電
 * - 冇 CSS 動畫，淨係影片本身郁
 * - perf-fix（動畫全保留，離屏/背景先暫停）：mount 之後唔會再 unmount——
 *   出 viewport（threshold 0）`pause()`、入返 `play()`；背景分頁一律 pause，
 *   返前景先播返。pause 唔會觸發重新下載，poster 同影片第一格係同一張相，冇閃爍
 */
export default function MovingPhoto({
  videoSrc,
  poster,
  alt,
  imgClassName,
  wrapperClassName,
  eager = false,
}: {
  /** 動態版 mp4 路徑（未生成就得 poster 出住先） */
  videoSrc: string;
  /** 靜態 jpg 海報（同影片同一張相） */
  poster: string;
  alt: string;
  /** 傳畀 poster <img> 嘅 class（決定尺寸，例如 aspect-[4/5] w-full object-cover） */
  imgClassName?: string;
  wrapperClassName?: string;
  /** 第一屏就見到 → true 即刻播；否則入 viewport 先播 */
  eager?: boolean;
}) {
  const [reduced] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  const hostRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [near, setNear] = useState(eager);
  const [videoOk, setVideoOk] = useState(true);
  const pageVisible = usePageVisible();
  // 雙向暫停用：真正喺唔喺 viewport（mount 用嘅 240px 提前量唔算）。
  // 舊瀏覽器冇 IntersectionObserver → lazy init 當成常駐可見（照播，唔喺 effect 同步 setState）
  const [inView, setInView] = useState(eager || typeof IntersectionObserver === 'undefined');

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

  // mount 之後改做「雙向」觀察：離開 viewport 就暫停解碼（慳 GPU/電），入返繼續播
  useEffect(() => {
    if (!near || reduced || !videoOk) return;
    const el = hostRef.current;
    // host div 必定已 render（ref 已綁定）；冇 IO 嘅舊瀏覽器 lazy init 已當 inView=true
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (es) => setInView(es.some((e) => e.isIntersecting)),
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, reduced, videoOk]);

  // 播/停統一喺度：睇到＋頁面喺前景先播；否則 pause（唔 unmount、唔 reload）
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (inView && pageVisible) {
      void v.play().catch(() => {
        // 瀏覽器間中會擋 play（例如未夠緩衝）——靜默留低 poster，唔好噉 unhandled rejection
      });
    } else {
      v.pause();
    }
  }, [inView, pageVisible, videoOk]);

  return (
    <div ref={hostRef} className={`relative overflow-hidden ${wrapperClassName ?? ''}`}>
      <img src={poster} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" className={imgClassName} />
      {near && !reduced && videoOk && (
        <video
          ref={videoRef}
          src={videoSrc}
          poster={poster}
          className="absolute inset-0 h-full w-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-hidden="true"
          onError={() => setVideoOk(false)}
        />
      )}
    </div>
  );
}
