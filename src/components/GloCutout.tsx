import { useEffect, useRef, useState } from 'react';

/**
 * v2.2.33（老闆指令）：關於區兩個「會郁」嘅透明 Glo Glo —— 哈利波特式會郁嘅相。
 * 影片做咗「假透底」：出片時已經將畫面 screen-blend 落實 --space-1（#0A0614，關於區平底色）
 * ＋淡粉／淡紫光晕，所以影片本身不透明都同頁面底無縫融合——任何瀏覽器都穩陣，
 * 唔使靠 mix-blend-mode（headless/舊 WebView 對 video blend 支援唔穩，會變黑磚），
 * 仲慳咗每幀 GPU blend。底色日後如果改，要重焗影片。
 * 透明 webp poster 即刻顯示，兼做 reduced-motion／影片 404 兜底。
 *
 * 設計守鐵律（唔好整慢客人電話）：
 * - 影片未整好／404 → onError 即刻收埋 video，永遠有靜態 webp 兜底
 * - prefers-reduced-motion → 淨顯示靜態 webp
 * - 入 viewport（提前 240px）先 mount <video>，慳數據慳電
 * - 冇 CSS looping 背景動畫；淨係影片本身郁＋video/poster 嘅 transform 微動畫（見 index.css）
 */
export default function GloCutout({
  videoSrc,
  poster,
  alt,
  className,
  animClass,
  eager = false,
}: {
  /** 黑底循環 mp4（9:16，figure 置中） */
  videoSrc: string;
  /** 透明 webp poster（同影片一樣 9:16 畫布） */
  poster: string;
  alt: string;
  className?: string;
  /** 微動畫 class（glo-sway / glo-hop）——直接落喺 video＋poster 度，
      唔可以落外層 wrapper：transform animation 會起 stacking context，
      隔斷 mix-blend-screen 嘅 backdrop，黑底會變返黑磚 */
  animClass?: string;
  eager?: boolean;
}) {
  const [reduced] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(eager);
  const [videoOk, setVideoOk] = useState(true);
  const [playing, setPlaying] = useState(false);

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
      {/* 影片一播就收 poster：否則靜態 poster 會透過影片黑色位疊出殘影（透底唔變色嘅關鍵） */}
      <img
        src={poster}
        alt={alt}
        width={360}
        height={640}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        className={`h-auto w-full transition-opacity duration-300 ${animClass ?? ''} ${
          playing ? 'opacity-0' : 'opacity-100'
        }`}
      />
      {near && !reduced && videoOk && (
        <video
          src={videoSrc}
          className={`absolute inset-0 h-full w-full object-contain ${animClass ?? ''}`}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-hidden="true"
          onPlaying={() => setPlaying(true)}
          onError={() => setVideoOk(false)}
        />
      )}
    </div>
  );
}
