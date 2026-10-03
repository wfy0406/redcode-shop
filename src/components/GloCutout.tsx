import { useEffect, useRef, useState } from 'react';
import { videoHasRealAlpha } from '@/lib/alphaVideo';

/**
 * v2.2.34（老闆指令）：關於區兩個「會郁」嘅透明 Glo Glo —— 真・透明背景影片。
 * 上版用「假透底」（將畫面焗落頁底色），但人一跳、transform 一郁，
 * 焗死咗嘅背景就走位——成塊背景出晒嚟（老闆電話實測發現）。
 * 而家改用 RVM 逐幀 matting 出真 alpha：VP9 alpha WebM 行先，
 * 瀏覽器解唔到 alpha → canvas probe 一驗即知，轉真 alpha 動畫 WebP；
 * 再兜底係透明 webp poster。三層都係真透底，任何底色都唔會甩。
 * v2.2.57（老闆實測 iPhone 黑盒）：WebKit 系（iOS 全部瀏覽器／macOS Safari）
 * 永遠解唔到 VP9 alpha——唔再試，開局直出動畫 WebP；其餘瀏覽器 probe 加雙保險
 * （空白幀唔算數＋500ms 再探一次），黑盒無可能留低。
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
  posterW = 360,
  posterH = 640,
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
  /** v2.2.35：素材原生寬高（CLS 用）——cutout 係 360x640，霓虹 logo 係 512x256 */
  posterW?: number;
  posterH?: number;
}) {
  const [reduced] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  // v2.2.57（老闆實測：iPhone Instagram in-app 公仔黑盒）：
  // WebKit 系（iPhone/iPad 上所有瀏覽器＝WKWebView、macOS Safari）永遠解唔到 VP9 alpha——
  // 解到 VP9 嘅新機會直接出黑盒（當不透明渲染），probe 第一格仲有時機誤判風險。
  // 唔再試運氣：呢類瀏覽器唔 mount WebM，直出真 alpha 動畫 WebP（乜 WebKit 都透）。
  const [webkit] = useState(() => {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const iOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
    const safari = /^((?!chrome|chromium|crios|fxios|edgios|android).)*safari/i.test(ua);
    return iOS || safari;
  });
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(eager);
  // poster=靜態兜底；video=真 alpha WebM 播緊；anim=動畫 WebP（WebKit 或 WebM 掛咗）
  const [mode, setMode] = useState<'poster' | 'video' | 'anim'>(webkit ? 'anim' : 'poster');
  // v2.2.57 補漏：WebKit 開局就係 anim，但要等動畫 WebP 真係 load 完先收 poster——
  // 唔係嘅話 reduced-motion（anim img 唔 mount）同慢網（WebP 下載緊）會成隻公仔唔見咗
  const [animReady, setAnimReady] = useState(false);

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
        width={posterW}
        height={posterH}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        className={`h-auto w-full transition-opacity duration-300 ${animClass ?? ''} ${
          mode === 'poster' || (mode === 'anim' && !animReady) ? 'opacity-100' : 'opacity-0'
        }`}
      />
      {/* WebKit 唔再試 WebM（解唔到 alpha 會黑盒）；其餘瀏覽器照播＋probe 驗 alpha */}
      {near && !reduced && !webkit && mode !== 'anim' && (
        <video
          src={videoSrc}
          className={`absolute inset-0 h-full w-full object-contain ${animClass ?? ''}`}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-hidden="true"
          onPlaying={(e) => {
            const v = e.currentTarget;
            if (!videoHasRealAlpha(v)) {
              setMode('anim');
              return;
            }
            setMode('video');
            // v2.2.57：第一格 probe 過咗都留一手——500ms 後再探一次，
            // 半路 decode 企唔穩（半透半實誤判）即刻轉動畫 WebP，唔會黑盒跟全場
            window.setTimeout(() => {
              if (v.isConnected && !videoHasRealAlpha(v)) setMode('anim');
            }, 500);
          }}
          onError={() => setMode('anim')}
        />
      )}
      {/* WebKit／解唔到 WebM alpha：真 alpha 動畫 WebP，<img> 直出，乜瀏覽器都透。
          near 閘埋——WebKit 開局就係 anim 模式，冇閘會未入 viewport 就 download（慳數據鐵律） */}
      {near && mode === 'anim' && !reduced && (
        <img
          src={animSrc}
          alt=""
          aria-hidden="true"
          width={posterW}
          height={posterH}
          className={`absolute inset-0 h-full w-full object-contain ${animClass ?? ''}`}
          onLoad={() => setAnimReady(true)}
          onError={() => setMode('poster')}
        />
      )}
    </div>
  );
}
