import { useCallback, useEffect, useRef, useState } from 'react';
import { usePageVisible } from '@/hooks/usePageVisible';
import { videoHasRealAlpha } from '@/lib/alphaVideo';

type MascotMode = 'poster' | 'video' | 'anim';

/** iOS／WebKit 對 VP9 alpha 支援不可靠，直接行安全後備，唔冒黑盒風險。 */
function shouldSkipWebM(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
  const safari = /^((?!chrome|chromium|crios|fxios|edgios|android).)*safari/i.test(ua);
  return iOS || safari;
}

/**
 * Wallet 專用單媒體層：任何時候只 render 一個 img 或一個 video，唔做雙層 opacity 交接。
 * WebM 先喺畫面外預載及驗真 alpha，通過先切換；失敗只用指定嘅安全 WebP，否則留 poster。
 */
export default function WalletMascot({
  videoSrc,
  animSrc,
  poster,
  alt,
  animClass,
  eager = false,
  width = 480,
  height = 480,
}: {
  videoSrc: string;
  /** 只傳入已確認全帧、冇合成殘影風險嘅動畫 WebP。 */
  animSrc?: string;
  poster: string;
  alt: string;
  animClass?: string;
  eager?: boolean;
  width?: number;
  height?: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recheckRef = useRef<number | null>(null);
  const [near, setNear] = useState(eager);
  const [inView, setInView] = useState(eager || typeof IntersectionObserver === 'undefined');
  const [mode, setMode] = useState<MascotMode>('poster');
  const [videoBlocked, setVideoBlocked] = useState(false);
  const [webkit] = useState(shouldSkipWebM);
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const pageVisible = usePageVisible();

  const clearRecheck = useCallback(() => {
    if (recheckRef.current !== null) {
      window.clearTimeout(recheckRef.current);
      recheckRef.current = null;
    }
  }, []);

  const blockVideo = useCallback(() => {
    clearRecheck();
    setMode('poster');
    setVideoBlocked(true);
  }, [clearRecheck]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (near || reduced) return;
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNear(true);
        observer.disconnect();
      },
      { rootMargin: '240px' },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [near, reduced]);

  useEffect(() => {
    if (!near || reduced) return;
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => setInView(entries.some((entry) => entry.isIntersecting)),
      { threshold: 0 },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [near, reduced]);

  useEffect(() => {
    setVideoBlocked(false);
    setMode('poster');
  }, [animSrc, videoSrc]);

  useEffect(() => {
    let cancelled = false;
    setMode('poster');
    if (!near || reduced) return;

    // WebKit 或 WebM 驗證失敗：有安全 WebP 先預載；冇就保持單層透明 poster。
    if (webkit || videoBlocked) {
      if (!animSrc) return;
      const preload = new Image();
      preload.decoding = 'async';
      preload.onload = () => {
        if (!cancelled) setMode('anim');
      };
      preload.onerror = () => {
        if (!cancelled) setMode('poster');
      };
      preload.src = animSrc;
      return () => {
        cancelled = true;
        preload.onload = null;
        preload.onerror = null;
      };
    }

    // 喺畫面外完成 autoplay／alpha 驗證，未通過前唔會將黑盒或不透明帧畀用戶睇。
    const probe = document.createElement('video');
    let retry: number | null = null;
    probe.muted = true;
    probe.defaultMuted = true;
    probe.playsInline = true;
    probe.preload = 'auto';

    const fail = () => {
      if (cancelled) return;
      setMode('poster');
      setVideoBlocked(true);
    };
    const confirmAlpha = () => {
      if (cancelled) return;
      if (videoHasRealAlpha(probe)) {
        probe.pause();
        setMode('video');
        return;
      }
      // 第一格偶然未上色時再探一次；全空白或全不透明都唔會誤當真 alpha。
      retry = window.setTimeout(() => {
        if (cancelled) return;
        if (videoHasRealAlpha(probe)) {
          probe.pause();
          setMode('video');
        } else {
          fail();
        }
      }, 160);
    };

    probe.addEventListener('playing', confirmAlpha);
    probe.addEventListener('error', fail);
    probe.src = videoSrc;
    void probe.play().catch(fail);

    return () => {
      cancelled = true;
      if (retry !== null) window.clearTimeout(retry);
      probe.removeEventListener('playing', confirmAlpha);
      probe.removeEventListener('error', fail);
      probe.pause();
      probe.removeAttribute('src');
      probe.load();
    };
  }, [animSrc, near, reduced, videoBlocked, videoSrc, webkit]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || mode !== 'video') return;
    if (inView && pageVisible && !reduced) {
      void video.play().catch((error: unknown) => {
        // play() 未落地時快速離屏／收埋分頁，pause() 會以 AbortError 正常中止；
        // 呢個唔係影片壞，唔可以因此永久轉用 poster。
        if ((error as DOMException | null)?.name !== 'AbortError') blockVideo();
      });
    } else {
      video.pause();
    }
  }, [blockVideo, inView, mode, pageVisible, reduced]);

  useEffect(() => clearRecheck, [clearRecheck]);

  const onVideoPlaying = (video: HTMLVideoElement) => {
    if (!videoHasRealAlpha(video)) {
      blockVideo();
      return;
    }
    clearRecheck();
    recheckRef.current = window.setTimeout(() => {
      recheckRef.current = null;
      if (video.isConnected && !videoHasRealAlpha(video)) blockVideo();
    }, 500);
  };

  return (
    <div ref={hostRef} className="relative" data-wallet-mascot={mode}>
      {mode === 'video' ? (
        <video
          ref={videoRef}
          src={videoSrc}
          poster={poster}
          width={width}
          height={height}
          className={`block h-auto w-full ${animClass ?? ''}`}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          role="img"
          aria-label={alt}
          onPlaying={(event) => onVideoPlaying(event.currentTarget)}
          onError={blockVideo}
        />
      ) : (
        <img
          src={mode === 'anim' && animSrc ? animSrc : poster}
          alt={alt}
          width={width}
          height={height}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setMode('poster')}
          className={`block h-auto w-full ${animClass ?? ''}`}
        />
      )}
    </div>
  );
}
