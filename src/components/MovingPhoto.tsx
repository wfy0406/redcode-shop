import { useEffect, useRef, useState } from 'react';

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
  const [near, setNear] = useState(eager);
  const [videoOk, setVideoOk] = useState(true);

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
    <div ref={hostRef} className={`relative overflow-hidden ${wrapperClassName ?? ''}`}>
      <img src={poster} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" className={imgClassName} />
      {near && !reduced && videoOk && (
        <video
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
