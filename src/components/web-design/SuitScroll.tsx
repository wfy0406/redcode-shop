'use client';

/**
 * SuitScroll —— Motion Sites 凍結規格（2026-11-09 修訂版）scroll-scrub 西裝真人 stage
 *
 * 因素材係直片 720×1280（9:16），桌面唔做全版 cover（會裁頭鞋），
 * 改為右側 9:16 sticky/fixed 真人 stage；暖色全版背景保留。手機／reduced-motion
 * 完全唔載片，淨睇 poster。
 *
 * 凍結規格逐項：
 * ① loadeddata 之後等 300ms 先開始抽幀
 * ② poster → video → canvas 三層 500ms crossfade（CSS opacity transition）
 * ③ fallback video seek：|delta| > 0.04s 先 seek，避免 seek thrash
 * ④ frame cache 上限 90 張；幀寬 = min(540, stage 實際寬 × DPR)；DPR ≤ 2；
 *    canvas 尺寸跟 stage rect（唔係成個 window）
 * ⑤ spacer 預設 240vh（140vh 太短，實際 scrub range 得 40vh）
 * ⑥ cleanup：停晒 listeners／rAF／timeout／bitmap／影片
 * 影片絕不 autoplay loop；顯示進度 lerp 0.12；canvas object-cover。
 */
import { useEffect, useRef, useState } from 'react';

const FRAME_COUNT = 90; // frame cache 上限
const CACHE_MAX_WIDTH = 540; // 直片 cache 幀寬封頂（控制記憶體）
const LERP = 0.12; // 平滑系數
const SEEK_MIN_DELTA = 0.04; // fallback seek 最小差距（秒）
const EXTRACT_DELAY_MS = 300; // loadeddata 後等 300ms 先抽幀

export interface SuitScrollProps {
  videoSrc?: string;
  posterSrc?: string;
  /** spacer 高度（vh），按故事節奏調整（220–280vh） */
  spacerVh?: number;
}

export default function SuitScroll({
  videoSrc = '/web-design/suit-scroll.mp4',
  posterSrc = '/web-design/suit-poster.webp',
  spacerVh = 240,
}: SuitScrollProps) {
  const spacerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // 桌面＋非 reduced-motion 先 mount <video>（手機連 metadata 都唔下載）
  const [enabled, setEnabled] = useState(false);
  const [videoOn, setVideoOn] = useState(false);
  const [canvasOn, setCanvasOn] = useState(false);

  // 環境判定：決定使唔使影片
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const narrow = window.innerWidth < 768;
    if (!reduce && !coarse && !narrow && typeof createImageBitmap === 'function') {
      setEnabled(true);
    }
  }, []);

  // 主引擎：掛喺 enabled（video mount）之後
  useEffect(() => {
    if (!enabled) return undefined;
    const spacer = spacerRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!spacer || !stage || !canvas || !video) return undefined;

    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    const cache = new Map<number, ImageBitmap>();
    let duration = 0;
    let raf = 0;
    let alive = true;
    let inView = false;
    let smooth = -1; // 未初始化：第一次 tick 直接對齊，唔由 0 掃
    let seeking = false;
    let pendingIdx = -1;
    let drawnIdx = -1;
    let extractReady = false; // ① loadeddata + 300ms 之後先 true
    let extractTimer = 0;

    const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

    /** ④ canvas 跟 stage rect（唔係 window），DPR ≤ 2；resize 後即刻重畫 */
    const resize = () => {
      const rect = stage.getBoundingClientRect();
      const d = dpr();
      canvas.width = Math.max(1, Math.round(rect.width * d));
      canvas.height = Math.max(1, Math.round(rect.height * d));
      drawnIdx = -1; // 強制重畫（canvas 尺寸改變會清空內容）
      // cache 幀寬跟 stage 寬，resize 後舊 cache 尺寸唔啱 → 清走重抽
      cache.forEach((b) => b.close());
      cache.clear();
      wake();
    };

    const cacheWidth = () => {
      const rect = stage.getBoundingClientRect();
      return Math.max(1, Math.min(CACHE_MAX_WIDTH, Math.round(rect.width * dpr())));
    };

    /** object-cover 繪製（stage 係 9:16、素材 9:16，基本 1:1；仍照 cover 保險） */
    const paint = (src: CanvasImageSource, sw: number, sh: number) => {
      const cw = canvas.width;
      const ch = canvas.height;
      if (!cw || !ch || !sw || !sh) return false;
      const scale = Math.max(cw / sw, ch / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      ctx.drawImage(src, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
      return true;
    };

    const progressOf = () => {
      const rect = spacer.getBoundingClientRect();
      const range = rect.height - window.innerHeight;
      if (range <= 0) return 0;
      return Math.min(1, Math.max(0, -rect.top / range));
    };

    const frameTime = (idx: number) =>
      duration > 0 ? (idx / (FRAME_COUNT - 1)) * Math.max(0, duration - 0.05) : 0;

    /** ③ fallback seek：|delta| > 0.04s 先郁 */
    const maybeSeek = (t: number, idx: number) => {
      if (seeking || !extractReady || !duration) return;
      if (Math.abs(t - video.currentTime) <= SEEK_MIN_DELTA) return;
      seeking = true;
      pendingIdx = idx;
      video.currentTime = t;
    };

    const onSeeked = () => {
      seeking = false;
      if (!alive) return;
      const idx = pendingIdx;
      // ② 第一格到位：poster → video crossfade 開始
      setVideoOn(true);
      if (idx < 0 || cache.has(idx)) {
        wake();
        return;
      }
      createImageBitmap(video, { resizeWidth: cacheWidth(), resizeQuality: 'medium' })
        .then((bmp) => {
          if (!alive) {
            bmp.close();
            return;
          }
          if (cache.size >= FRAME_COUNT) {
            // FIFO eviction（正常 idx 只有 90 個值，呢度係保險）
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) {
              cache.get(oldest)?.close();
              cache.delete(oldest);
            }
          }
          cache.set(idx, bmp);
          wake();
        })
        .catch(() => {
          // 抽幀失敗：唔入 cache；顯示層有 video fallback 頂住
        });
    };

    const tick = () => {
      raf = 0;
      if (!alive || !inView) return;

      const target = progressOf();
      if (smooth < 0) smooth = target;
      smooth += (target - smooth) * LERP;
      if (Math.abs(target - smooth) < 0.0004) smooth = target;

      const idx = Math.min(FRAME_COUNT - 1, Math.round(smooth * (FRAME_COUNT - 1)));
      const t = frameTime(idx);

      const cached = cache.get(idx);
      let painted = false;
      if (cached) {
        if (drawnIdx !== idx) {
          painted = paint(cached, cached.width, cached.height);
          if (painted) drawnIdx = idx;
        } else {
          painted = true;
        }
      } else if (video.readyState >= 2) {
        // fallback：直接用 video 現時幀頂住（舊幀好過空）
        painted = paint(video, video.videoWidth, video.videoHeight);
        maybeSeek(t, idx);
      } else {
        maybeSeek(t, idx);
      }

      // ② 第一次成功畫到幀：video → canvas crossfade
      if (painted && drawnIdx >= 0) setCanvasOn(true);
      if (painted && drawnIdx < 0) {
        drawnIdx = idx;
        setCanvasOn(true);
      }

      // 未對齊／seek 緊／目標幀未入 cache：繼續 loop；否則靜止慳電
      if (smooth !== target || seeking || (!cached && extractReady)) {
        raf = requestAnimationFrame(tick);
      }
    };

    function wake() {
      if (!raf && alive && inView) raf = requestAnimationFrame(tick);
    }

    /** ① loadeddata 之後等 300ms 先開始抽幀 */
    const onLoadedData = () => {
      duration = Number.isFinite(video.duration) ? video.duration : 0;
      window.clearTimeout(extractTimer);
      extractTimer = window.setTimeout(() => {
        extractReady = true;
        wake();
      }, EXTRACT_DELAY_MS);
    };

    const onError = () => {
      // 影片載唔到：永留 poster
      alive = false;
      window.clearTimeout(extractTimer);
      cancelAnimationFrame(raf);
      canvas.style.display = 'none';
      video.style.display = 'none';
    };

    const io = new IntersectionObserver(
      (entries) => {
        inView = entries.some((e) => e.isIntersecting);
        if (inView) wake();
      },
      { rootMargin: '20% 0px' },
    );
    io.observe(spacer);

    resize();
    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    // 極快 cache hit／即時失敗可能喺 effect 前已經完成，兩種情況都補查一次。
    if (video.readyState >= 2) onLoadedData();
    if (video.error) onError();
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', wake, { passive: true });

    /* ⑥ cleanup：停晒 listeners／rAF／timeout／bitmap／影片 */
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.clearTimeout(extractTimer);
      io.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', wake);
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      video.pause();
      video.removeAttribute('src');
      video.load();
      cache.forEach((b) => b.close());
      cache.clear();
    };
  }, [enabled]);

  return (
    <div
      ref={spacerRef}
      className="wd-suit-spacer"
      style={{ height: `${spacerVh}vh` }}
      aria-hidden="true"
    >
      <div ref={stageRef} className="wd-suit-stage">
        <img
          className="wd-suit-poster"
          src={posterSrc}
          alt=""
          loading="eager"
          decoding="async"
        />
        {enabled && (
          <video
            ref={videoRef}
            className={`wd-suit-video${videoOn ? ' wd-suit-on' : ''}`}
            src={videoSrc}
            muted
            playsInline
            preload="auto"
            disablePictureInPicture
          />
        )}
        <canvas
          ref={canvasRef}
          className={`wd-suit-canvas${canvasOn ? ' wd-suit-on' : ''}`}
        />
        <div className="wd-suit-veil" />
      </div>
    </div>
  );
}
