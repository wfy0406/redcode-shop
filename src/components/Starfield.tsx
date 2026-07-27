import { useEffect, useRef } from 'react';

/**
 * RedCode 設計系統 §3.2 —— 星空粒子 Canvas（全站背景，fixed, z-index: -2）
 *
 * - 每粒星獨立相位閃爍（週期 2.4s–7.6s，R-A §6：「呼吸」唔係「眨」），唔係統一 animation
 * - 內建流星預設關閉（shootingStars=false）：全站流星統一由 Meteors.tsx 三層調度，
 *   避免同 DOM 層角度不一（35° vs 45°）顯亂（R-A §6b）
 * - DPR cap 2、visibilitychange 暫停、手機星數 ×0.4 兼關星芒
 * - prefers-reduced-motion → 畫一幀靜態星空（唔係冇背景）
 */

export interface StarfieldProps {
  /** 密度倍率（1 = 設計基準 (w×h)/9000；員工後台用 0.3） */
  density?: number;
  /** 開關流星 */
  shootingStars?: boolean;
  /** 強制靜態（預設跟隨 prefers-reduced-motion） */
  reducedMotion?: boolean;
}

interface Star {
  x: number;
  y: number;
  r: number;
  baseAlpha: number;
  phase: number;
  speed: number; // rad/ms
  color: string;
  rays: boolean;
}

interface ShootingStar {
  x: number;
  y: number;
  len: number;
  born: number;
  duration: number;
}

const STAR_COLORS = ['#FFF7E8', '#FFF7E8', '#FFF7E8', '#FFF7E8', '#FFF7E8', '#FFF7E8', '#FFF7E8', '#FFF7E8',
  '#FFF7E8', '#FFF7E8', '#FFF7E8', '#FFF7E8', '#FFF7E8', '#FFF7E8', '#FFF7E8', '#FFF7E8', '#FFF7E8', // 85% starlight
  '#FF8FBF', '#FF8FBF', // 10% pink-tint
  '#C9A6FF', // 5% lavender
];

const SHOOTING_LIFE = 600; // ms
const SHOOTING_ANGLE = (35 * Math.PI) / 180; // 向左下 35°

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function makeStars(width: number, height: number, density: number, isMobile: boolean): Star[] {
  let count = Math.round(((width * height) / 9000) * density);
  if (isMobile) count = Math.round(count * 0.4);
  count = Math.min(count, 320);

  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    // 對數分佈：多細星、少大星
    const t = 1 - Math.pow(Math.random(), 2.2);
    const r = 0.4 + t * 1.2; // 0.4–1.6
    const baseAlpha = 0.2 + Math.random() * 0.5; // 0.2–0.7
    const period = 2400 + Math.random() * 5200; // 2.4s–7.6s（R-A §6：調慢做「呼吸」感）
    stars.push({
      x: Math.random() * width,
      y: Math.random() * height,
      r,
      baseAlpha,
      phase: Math.random() * Math.PI * 2,
      speed: (Math.PI * 2) / period,
      color: STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)],
      rays: !isMobile && r > 1.2,
    });
  }
  return stars;
}

export default function Starfield({ density = 1, shootingStars = false, reducedMotion }: StarfieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReduced =
      reducedMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let stars: Star[] = [];
    let shooting: ShootingStar | null = null;
    let nextShootingAt = Number.POSITIVE_INFINITY;
    let rafId = 0;
    let running = true;
    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = makeStars(width, height, density, width < 768);
      if (prefersReduced) drawStatic();
    };

    const drawStars = (now: number, twinkle: boolean) => {
      for (const s of stars) {
        // 透明度喺 base×0.35 至 base 之間正弦循環
        const alpha = twinkle
          ? s.baseAlpha * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(s.phase + now * s.speed)))
          : s.baseAlpha;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();

        // 大星 4 向十字星芒
        if (s.rays) {
          ctx.globalAlpha = alpha * 0.5;
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 1;
          const len = s.r * 3;
          ctx.beginPath();
          ctx.moveTo(s.x - len, s.y);
          ctx.lineTo(s.x + len, s.y);
          ctx.moveTo(s.x, s.y - len);
          ctx.lineTo(s.x, s.y + len);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    };

    const drawShooting = (now: number) => {
      if (!shooting) return;
      const t = (now - shooting.born) / SHOOTING_LIFE;
      if (t >= 1) {
        shooting = null;
        return;
      }
      const progress = easeOutCubic(t);
      const fade = 1 - t;
      const travel = progress * shooting.len * 2.2;
      // 方向：左下 35°
      const dx = -Math.cos(SHOOTING_ANGLE);
      const dy = Math.sin(SHOOTING_ANGLE);
      const headX = shooting.x + dx * travel;
      const headY = shooting.y + dy * travel;
      const tailX = headX - dx * shooting.len;
      const tailY = headY - dy * shooting.len;

      const grad = ctx.createLinearGradient(headX, headY, tailX, tailY);
      grad.addColorStop(0, `rgba(255, 247, 232, ${0.9 * fade})`);
      grad.addColorStop(1, 'rgba(255, 247, 232, 0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(headX, headY);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();

      // 流星頭光點
      ctx.globalAlpha = fade;
      ctx.fillStyle = '#FFF7E8';
      ctx.beginPath();
      ctx.arc(headX, headY, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    };

    const drawStatic = () => {
      ctx.clearRect(0, 0, width, height);
      drawStars(0, false);
    };

    const frame = (now: number) => {
      if (!running) return;
      ctx.clearRect(0, 0, width, height);
      drawStars(now, true);

      if (shootingStars) {
        if (!shooting && now >= nextShootingAt) {
          // 頂部右側 30% 區域出發
          shooting = {
            x: width * (0.7 + Math.random() * 0.3),
            y: height * Math.random() * 0.25,
            len: 80 + Math.random() * 60, // 80–140px
            born: now,
            duration: SHOOTING_LIFE,
          };
          nextShootingAt = now + 4000 + Math.random() * 4000; // 每 4–8s
        }
        drawShooting(now);
      }
      rafId = requestAnimationFrame(frame);
    };

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(rafId);
      } else if (!prefersReduced) {
        running = true;
        rafId = requestAnimationFrame(frame);
      }
    };

    resize();
    window.addEventListener('resize', resize);

    if (prefersReduced) {
      // 靜態星空：畫一幀就算
      drawStatic();
    } else {
      nextShootingAt = performance.now() + 1500 + Math.random() * 3000;
      rafId = requestAnimationFrame(frame);
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      running = false;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [density, shootingStars, reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: -2,
        pointerEvents: 'none',
      }}
    />
  );
}
