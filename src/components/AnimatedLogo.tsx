import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { videoHasRealAlpha } from '@/lib/alphaVideo';
import { logoLayerVisibility } from '@/lib/animatedLogo';
import { usePageVisible } from '@/hooks/usePageVisible';

/**
 * v2.2.34 老闆指令：全網左上角動態 logo —— 小 Gloria 推 logo → 推唔郁 → 雙手開心揮手，循環播。
 * 上版靠 mix-blend-screen 疊黑底影片，但老闆電話（Android FB WebView）blend 唔到 → 黑盒。
 * 而家改真 alpha：VP9 alpha WebM 行先；canvas probe 驗到瀏覽器解唔到 alpha（Safari）
 * 就轉真 alpha 動畫 WebP；最終兜底係透明 webp 靜態 logo。三層都真透底，唔會再變深淺色。
 * 注意：唔好加 filter／blur（每幀 GPU 重繪會 lag 客人電話）。
 *
 * v2.2.60 重影根因修正（老闆指令）：
 * 病根＝舊版切層用 300ms opacity crossfade，transition 中途 poster 同動畫層
 * 兩層同時半透明疊加 → 重影。鐵律：唔准保留或新增 crossfade——
 * 三層即時切換（無 transition，opacity 只有 0/1 兩態），任何時刻都得一層可見，
 * 可見性全部由 logoLayerVisibility(mode, reduced) 話事。
 * video 喺 anim 模式唔 unmount 只 pause（opacity-0）——切返唔使重新下載。
 */
export default function AnimatedLogo() {
  const [reduced, setReduced] = useState(false);
  // poster=靜態兜底；video=真 alpha WebM 播緊；anim=動畫 WebP（Safari 或 WebM 掛咗）
  const [mode, setMode] = useState<'poster' | 'video' | 'anim'>('poster');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // perf-fix：logo 全站常駐 loop——背景分頁時 pause，返前景先播返（動畫保留，唔刪唔降速）
  const pageVisible = usePageVisible();

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const layers = logoLayerVisibility(mode, reduced);
  // anim WebP 要真係 load 完先即時切上——未 load 完繼續企 poster，唔會閃空白
  const [animReady, setAnimReady] = useState(false);
  const posterVisible = layers.poster || (layers.anim && !animReady);
  const animVisible = layers.anim && animReady;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // anim 模式／reduced／背景分頁：pause 但唔 unmount
    if (pageVisible && !reduced && mode !== 'anim') {
      void v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, [pageVisible, reduced, mode]);

  return (
    <Link
      to="/"
      aria-label="RedCode Fashion Design 首頁"
      className="relative flex shrink items-center overflow-visible"
    >
      {/* 微微高過頂欄內容（-my 拉返布局），小 Gloria 好似趴喺頂欄邊 */}
      <span className="relative -my-1 block h-[64px] w-[128px] md:-my-2 md:h-[88px] md:w-[176px]">
        {/* 三層即時切換（v2.2.60 鐵律：唔准 crossfade／opacity transition，
            任何時刻唔會兩層半透明疊加 → 唔會再重影） */}
        <img
          src="/logo-live-poster.webp"
          alt="RedCode Fashion Design"
          className={`absolute inset-0 h-full w-full object-contain ${
            posterVisible ? 'opacity-100' : 'opacity-0'
          }`}
          loading="eager"
          decoding="async"
        />
        {/* video 層常駐（reduced 除外）：mode 只控 opacity，唔條件 unmount */}
        {!reduced && (
          <video
            ref={videoRef}
            className={`absolute inset-0 h-full w-full object-contain ${
              layers.video ? 'opacity-100' : 'opacity-0'
            }`}
            src="/logo-live-alpha.webm"
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
        {/* anim 層照樣常駐（src 跟 mode 閘）：load 完即時切上（animReady 把關）；
            img 無 src 時 opacity-0 唔會現破圖 */}
        {!reduced && (
          <img
            src={mode === 'anim' ? '/logo-live-anim.webp' : undefined}
            alt=""
            aria-hidden="true"
            className={`absolute inset-0 h-full w-full object-contain ${
              animVisible ? 'opacity-100' : 'opacity-0'
            }`}
            onLoad={() => setAnimReady(true)}
            onError={() => setMode('poster')}
          />
        )}
      </span>
    </Link>
  );
}
