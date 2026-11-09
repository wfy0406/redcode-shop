'use client';

/**
 * Fox-couture 式角色主導首屏。
 * 兩個透明角色姿勢以滾動進度 crossfade；原西裝影片只作離線動作參考，
 * 呢個元件沒有 video、canvas、抽幀或任何原片播放邏輯。
 */
import { useEffect, useRef } from 'react';

export interface SuitScrollProps {
  /** 桌面滾動故事長度；手機及 reduced-motion 會由 CSS 改成靜態單屏。 */
  spacerVh?: number;
}

export default function SuitScroll({ spacerVh = 250 }: SuitScrollProps) {
  const spacerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const spacer = spacerRef.current;
    const stage = stageRef.current;
    if (!spacer || !stage) return undefined;

    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const coarseQuery = window.matchMedia('(pointer: coarse)');
    let raf = 0;
    let enabled = false;

    const writeProgress = () => {
      raf = 0;
      if (!enabled) {
        stage.style.setProperty('--wd-progress', '0');
        stage.style.setProperty('--wd-hero-opacity', '1');
        stage.style.setProperty('--wd-motion-opacity', '0');
        stage.style.setProperty('--wd-character-x', '0px');
        stage.style.setProperty('--wd-character-scale', '1');
        stage.style.setProperty('--wd-wordmark-x', '0px');
        stage.style.setProperty('--wd-orbit-turn', '0deg');
        return;
      }
      const rect = spacer.getBoundingClientRect();
      const range = Math.max(1, rect.height - window.innerHeight);
      const progress = Math.min(1, Math.max(0, -rect.top / range));
      const blend = Math.min(1, Math.max(0, (progress - 0.28) / 0.5));
      stage.style.setProperty('--wd-progress', progress.toFixed(4));
      stage.style.setProperty('--wd-hero-opacity', (1 - blend).toFixed(4));
      stage.style.setProperty('--wd-motion-opacity', blend.toFixed(4));
      stage.style.setProperty('--wd-character-x', `${(-42 * progress).toFixed(2)}px`);
      stage.style.setProperty('--wd-character-scale', (1 + progress * 0.12).toFixed(4));
      stage.style.setProperty('--wd-wordmark-x', `${(-110 * progress).toFixed(2)}px`);
      stage.style.setProperty('--wd-orbit-turn', `${(progress * 42).toFixed(2)}deg`);
    };

    const wake = () => {
      if (!raf) raf = window.requestAnimationFrame(writeProgress);
    };

    const syncMode = () => {
      enabled = !reduceQuery.matches && !coarseQuery.matches && window.innerWidth > 900;
      stage.dataset.motion = enabled ? 'scroll' : 'static';
      wake();
    };

    syncMode();
    window.addEventListener('scroll', wake, { passive: true });
    window.addEventListener('resize', syncMode);
    reduceQuery.addEventListener('change', syncMode);
    coarseQuery.addEventListener('change', syncMode);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('scroll', wake);
      window.removeEventListener('resize', syncMode);
      reduceQuery.removeEventListener('change', syncMode);
      coarseQuery.removeEventListener('change', syncMode);
    };
  }, []);

  return (
    <div
      ref={spacerRef}
      className="wd-suit-spacer"
      style={{ height: `${spacerVh}vh` }}
      aria-hidden="true"
    >
      <div ref={stageRef} className="wd-suit-stage" data-motion="static">
        <div className="wd-hero-wordmark">WEB DESIGN</div>
        <div className="wd-hero-orbit wd-hero-orbit--outer" />
        <div className="wd-hero-orbit wd-hero-orbit--inner" />
        <div className="wd-hero-index">RED / 01</div>
        <div className="wd-character-wrap">
          <img
            className="wd-character wd-character--hero"
            src="/web-design/character-hero.webp"
            alt=""
            width="864"
            height="1350"
            loading="eager"
            decoding="async"
            fetchPriority="high"
          />
          <img
            className="wd-character wd-character--motion"
            src="/web-design/character-motion.webp"
            alt=""
            width="864"
            height="1350"
            loading="eager"
            decoding="async"
          />
        </div>
        <div className="wd-hero-scroll-cue">
          <span>SCROLL TO CREATE</span>
          <i />
        </div>
      </div>
    </div>
  );
}
