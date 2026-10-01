import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { videoHasRealAlpha } from '@/lib/alphaVideo';

/**
 * v2.2.34 老闆指令：全網左上角動態 logo —— 小 Gloria 推 logo → 推唔郁 → 雙手開心揮手，循環播。
 * 上版靠 mix-blend-screen 疊黑底影片，但老闆電話（Android FB WebView）blend 唔到 → 黑盒。
 * 而家改真 alpha：VP9 alpha WebM 行先；canvas probe 驗到瀏覽器解唔到 alpha（Safari）
 * 就轉真 alpha 動畫 WebP；最終兜底係透明 webp 靜態 logo。三層都真透底，唔會再變深淺色。
 * 注意：唔好加 filter／blur（每幀 GPU 重繪會 lag 客人電話）。
 */
export default function AnimatedLogo() {
  const [reduced, setReduced] = useState(false);
  // poster=靜態兜底；video=真 alpha WebM 播緊；anim=動畫 WebP（Safari 或 WebM 掛咗）
  const [mode, setMode] = useState<'poster' | 'video' | 'anim'>('poster');

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  return (
    <Link
      to="/"
      aria-label="RedCode Fashion Design 首頁"
      className="relative flex shrink items-center overflow-visible"
    >
      {/* 微微高過頂欄內容（-my 拉返布局），小 Gloria 好似趴喺頂欄邊 */}
      <span className="relative -my-1 block h-[64px] w-[128px] md:-my-2 md:h-[88px] md:w-[176px]">
        <img
          src="/logo-live-poster.webp"
          alt="RedCode Fashion Design"
          className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-300 ${
            mode === 'poster' || reduced ? 'opacity-100' : 'opacity-0'
          }`}
          loading="eager"
          decoding="async"
        />
        {!reduced && mode !== 'anim' && (
          <video
            className="absolute inset-0 h-full w-full object-contain"
            src="/logo-live-alpha.webm"
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            aria-hidden="true"
            onPlaying={(e) => setMode(videoHasRealAlpha(e.currentTarget) ? 'video' : 'anim')}
            onError={() => setMode('anim')}
          />
        )}
        {!reduced && mode === 'anim' && (
          <img
            src="/logo-live-anim.webp"
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full object-contain"
            onError={() => setMode('poster')}
          />
        )}
      </span>
    </Link>
  );
}
