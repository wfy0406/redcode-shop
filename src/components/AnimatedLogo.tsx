import { useEffect, useState } from 'react';
import { Link } from 'react-router';

/**
 * v2.2.33 老闆指令：全網左上角動態 logo —— 小 Gloria 推 logo → 推唔郁 → 雙手開心揮手，循環播。
 * 影片係黑底，用 mix-blend-screen 疊落深色玻璃頂欄＝透明效果（頂欄全站深色，唔使真 alpha 片）。
 * poster 只做載入前／reduced-motion／影片 error 兜底；影片一播就收起 poster，
 * 否則靜態 poster 會透過影片黑色位疊出殘影，logo 深淺色會變（老闆指令：透底、唔准變深淺色）。
 * 注意：唔好加 filter／blur（每幀 GPU 重繪會 lag 客人電話）。
 */
export default function AnimatedLogo() {
  const [reduced, setReduced] = useState(false);
  const [videoOk, setVideoOk] = useState(true);
  const [playing, setPlaying] = useState(false);

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
          src="/logo-live.webp"
          alt="RedCode Fashion Design"
          className={`absolute inset-0 h-full w-full object-contain mix-blend-screen transition-opacity duration-300 ${
            playing ? 'opacity-0' : 'opacity-100'
          }`}
          loading="eager"
          decoding="async"
        />
        {!reduced && videoOk && (
          <video
            className="absolute inset-0 h-full w-full object-contain mix-blend-screen"
            src="/logo-live.mp4"
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            aria-hidden="true"
            onPlaying={() => setPlaying(true)}
            onError={() => setVideoOk(false)}
          />
        )}
      </span>
    </Link>
  );
}
