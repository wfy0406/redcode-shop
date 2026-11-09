'use client';

/**
 * 透明角色 72 幀連續行路序列，由滾動進度逐幀驅動。
 * 原西裝影片只作離線動作參考；頁面冇嵌入或播放原片。
 */
import { useEffect, useRef } from 'react';

const FRAME_COUNT = 72;
const FRAME_COLS = 9;
const FRAME_WIDTH = 240;
const FRAME_HEIGHT = 375;

export interface SuitScrollProps {
  /** 手機及桌面都保留完整滾動故事；只有 reduced-motion 會靜態降級。 */
  spacerVh?: number;
}

export default function SuitScroll({ spacerVh = 250 }: SuitScrollProps) {
  const spacerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const spacer = spacerRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!spacer || !stage || !canvas) return undefined;
    const context = canvas.getContext('2d');
    const hero = spacer.closest<HTMLElement>('.wd-hero');
    if (!context) {
      stage.dataset.sprite = 'error';
      return undefined;
    }

    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sprite = new Image();
    let cancelled = false;
    let ready = false;
    let enabled = !reduceQuery.matches;
    let raf = 0;
    let targetProgress = 0;
    let currentProgress = 0;
    let lastFrame = -1;

    const measure = () => {
      if (!enabled) {
        targetProgress = 0;
        return;
      }
      const rect = spacer.getBoundingClientRect();
      const range = Math.max(1, rect.height - window.innerHeight);
      targetProgress = Math.min(1, Math.max(0, -rect.top / range));
    };

    const drawFrame = (progress: number) => {
      const frame = enabled && ready
        ? Math.min(FRAME_COUNT - 1, Math.max(0, Math.round(progress * (FRAME_COUNT - 1))))
        : 0;
      stage.dataset.frame = String(frame);
      canvas.dataset.frame = String(frame);
      if (!ready || frame === lastFrame) return;
      const sx = (frame % FRAME_COLS) * FRAME_WIDTH;
      const sy = Math.floor(frame / FRAME_COLS) * FRAME_HEIGHT;
      context.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
      context.drawImage(
        sprite,
        sx, sy, FRAME_WIDTH, FRAME_HEIGHT,
        0, 0, FRAME_WIDTH, FRAME_HEIGHT,
      );
      lastFrame = frame;
    };

    const render = () => {
      const progress = currentProgress;
      const compact = window.innerWidth <= 900;
      const copyFade = Math.min(1, Math.max(0, (progress - 0.5) / 0.2));
      stage.style.setProperty('--wd-progress', progress.toFixed(4));
      stage.style.setProperty('--wd-character-x', `${(-72 * progress).toFixed(2)}px`);
      stage.style.setProperty('--wd-character-y', `${((compact ? 5 : 4) * progress).toFixed(2)}svh`);
      stage.style.setProperty('--wd-character-scale', (1 - progress * 0.055).toFixed(4));
      stage.style.setProperty('--wd-wordmark-x', `${(-110 * progress).toFixed(2)}px`);
      stage.style.setProperty('--wd-orbit-turn', `${(progress * 72).toFixed(2)}deg`);
      hero?.style.setProperty('--wd-hero-copy-opacity', (1 - copyFade).toFixed(4));
      hero?.style.setProperty('--wd-hero-copy-y', `${(-32 * copyFade).toFixed(2)}px`);
      if (hero) hero.dataset.phase = copyFade >= 0.99 ? 'walk' : 'intro';
      stage.dataset.phase = progress >= 0.5 ? 'walk' : 'intro';
      drawFrame(progress);
    };

    const tick = () => {
      raf = 0;
      const difference = targetProgress - currentProgress;
      currentProgress = Math.abs(difference) < 0.0005
        ? targetProgress
        : currentProgress + difference * 0.24;
      render();
      if (currentProgress !== targetProgress && !raf) {
        raf = window.requestAnimationFrame(tick);
      }
    };

    const wake = () => {
      measure();
      if (!enabled) currentProgress = 0;
      if (!raf) raf = window.requestAnimationFrame(tick);
    };

    const syncMode = () => {
      enabled = !reduceQuery.matches;
      stage.dataset.motion = enabled ? 'scroll' : 'static';
      if (!enabled) {
        targetProgress = 0;
        currentProgress = 0;
        lastFrame = -1;
      }
      wake();
    };

    sprite.onload = () => {
      if (cancelled) return;
      ready = true;
      stage.dataset.sprite = 'ready';
      lastFrame = -1;
      render();
    };
    sprite.onerror = () => {
      if (cancelled) return;
      ready = false;
      stage.dataset.sprite = 'error';
    };
    stage.dataset.sprite = 'loading';
    sprite.src = '/web-design/character-walk-sprite.webp';

    syncMode();
    window.addEventListener('scroll', wake, { passive: true });
    window.addEventListener('resize', syncMode);
    reduceQuery.addEventListener('change', syncMode);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      window.removeEventListener('scroll', wake);
      window.removeEventListener('resize', syncMode);
      reduceQuery.removeEventListener('change', syncMode);
      sprite.onload = null;
      sprite.onerror = null;
    };
  }, []);

  return (
    <div
      ref={spacerRef}
      className="wd-suit-spacer"
      style={{ height: `${spacerVh}vh` }}
      aria-hidden="true"
    >
      <div ref={stageRef} className="wd-suit-stage" data-motion="static" data-sprite="loading" data-frame="0">
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
          <canvas
            ref={canvasRef}
            className="wd-character wd-character-canvas"
            width={FRAME_WIDTH}
            height={FRAME_HEIGHT}
            data-frame="0"
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
