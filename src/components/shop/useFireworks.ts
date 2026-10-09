/**
 * 煙花粒子 hook（2026-10-09 由 PrizeWinModal 抽出共用）
 * 用處：中獎賀卡（PrizeWinModal）＋訪客付款成功 modal（guest-payment 頁）。
 * 金/粉紅/白/紫拖尾火星＋金色衝擊波環，錯峰三連爆（0ms／240ms／500ms），爆完即停唔循環。
 * 老闆鐵律：動畫淨郁 transform/opacity 嘅 canvas 繪製；reduced-motion 由 caller 唔傳 active 處理。
 */
import { useEffect, useRef } from 'react';

/** 煙花粒子（v2.2.56 加強版，同後台輪盤同款：拖尾火星＋金色衝擊波環＋錯峰爆；金/粉紅/白/紫） */
export function useFireworks(active: boolean) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !active) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = (canvas.width = canvas.offsetWidth * 2);
    const H = (canvas.height = canvas.offsetHeight * 2);
    type P = { x: number; y: number; px: number; py: number; vx: number; vy: number; life: number; max: number; color: string; size: number };
    type Ring = { x: number; y: number; r: number; vr: number; alpha: number };
    const colors = ['#F5C518', '#F5C518', '#F7D774', '#FF8FBF', '#FFFFFF', '#C4B5FD'];
    const parts: P[] = [];
    const rings: Ring[] = [];
    const burst = (bx: number, by: number) => {
      rings.push({ x: bx, y: by, r: 10, vr: 6, alpha: 0.8 });
      for (let i = 0; i < 100; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 2 + Math.random() * 6.5;
        parts.push({
          x: bx, y: by, px: bx, py: by,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5,
          life: 0, max: 60 + Math.random() * 45,
          color: colors[Math.floor(Math.random() * colors.length)],
          size: 1.8 + Math.random() * 3.2,
        });
      }
    };
    burst(W * 0.28, H * 0.3);
    const timers = [
      window.setTimeout(() => burst(W * 0.72, H * 0.26), 240),
      window.setTimeout(() => burst(W * 0.5, H * 0.14), 500),
    ];
    let raf = 0;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      ctx.clearRect(0, 0, W, H);
      let any = false;
      for (const rg of rings) {
        if (rg.alpha <= 0.02) continue;
        any = true;
        rg.r += rg.vr;
        rg.vr *= 0.965;
        rg.alpha *= 0.94;
        ctx.globalAlpha = rg.alpha;
        ctx.beginPath();
        ctx.arc(rg.x, rg.y, rg.r, 0, Math.PI * 2);
        ctx.strokeStyle = '#F7D774';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      for (const p of parts) {
        if (p.life >= p.max) continue;
        any = true;
        p.life++;
        p.px = p.x;
        p.py = p.y;
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.09;
        p.vx *= 0.985;
        const fade = 1 - p.life / p.max;
        ctx.globalAlpha = fade * 0.9;
        ctx.beginPath();
        ctx.moveTo(p.px, p.py);
        ctx.lineTo(p.x, p.y);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(0.8, p.size * 0.55);
        ctx.stroke();
        ctx.globalAlpha = fade;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.4 + fade * 0.6), 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (any) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      for (const t of timers) window.clearTimeout(t);
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, W, H); // 早切步驟都唔會留「冰封火星」
    };
  }, [active]);
  return ref;
}
