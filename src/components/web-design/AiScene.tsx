'use client';

/** 滾動驅動嘅粒子星場＋三階段工作流程；只有 reduced-motion 會靜態降級。 */
import { useEffect, useRef, useState } from 'react';

const STEPS = [
  {
    no: '01',
    code: 'DISCOVER',
    title: '先理解，再設計',
    body: '將你嘅生意、客群、內容同功能需要整理成清晰規格；設計唔係換模板，而係由真實需要出發。',
    tags: ['需求梳理', '內容架構', '視覺方向'],
  },
  {
    no: '02',
    code: 'CREATE',
    title: '設計與開發並行',
    body: '唔同 AI agent 分工處理版面、功能同檢查，加快反覆試作；慳到嘅工序時間，反映喺你睇到嘅價錢。',
    tags: ['介面設計', '功能開發', '手機適配'],
  },
  {
    no: '03',
    code: 'VERIFY',
    title: '真人驗收先交付',
    body: '實際檢查桌面、手機、表單、權限同付款流程；每一項有結果先算完成，AI 唔會代替最終把關。',
    tags: ['功能驗證', '畫面檢查', '人類把關'],
  },
] as const;

interface Particle {
  x: number;
  y: number;
  depth: number;
  radius: number;
  drift: number;
  phase: number;
  warm: boolean;
}

function createParticles(count: number): Particle[] {
  let seed = 20261109;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return Array.from({ length: count }, () => ({
    x: random(),
    y: random(),
    depth: 0.25 + random() * 0.75,
    radius: 0.65 + random() * 1.75,
    drift: (random() - 0.5) * 0.3,
    phase: random() * Math.PI * 2,
    warm: random() > 0.88,
  }));
}

export default function AiScene() {
  const spacerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const spacer = spacerRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!spacer || !stage || !canvas) return undefined;
    const context = canvas.getContext('2d');
    if (!context) return undefined;

    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const particles = createParticles(112);
    let raf = 0;
    let enabled = false;
    let lastPhase = -1;
    let width = 1;
    let height = 1;
    let lastProgress = -1;

    const drawParticles = (progress: number) => {
      if (lastProgress === progress) return;
      lastProgress = progress;
      context.clearRect(0, 0, width, height);
      const points = particles.map((particle) => {
        const travel = progress * (0.32 + particle.depth * 0.72);
        const x = ((particle.x + particle.drift * progress + Math.sin(progress * Math.PI * 2 + particle.phase) * 0.018 * particle.depth + 1) % 1) * width;
        const y = ((particle.y - travel + 2) % 1.25) * height - height * 0.1;
        return { ...particle, px: x, py: y };
      });

      // 星塵之間嘅連線同樣由滾動後嘅實際位置計算，唔係固定 SVG 裝飾。
      for (let i = 0; i < points.length; i += 1) {
        const a = points[i];
        for (let j = i + 1; j < points.length; j += 1) {
          const b = points[j];
          const dx = a.px - b.px;
          const dy = a.py - b.py;
          const distance = Math.hypot(dx, dy);
          const limit = 88 + Math.min(a.depth, b.depth) * 58;
          if (distance >= limit) continue;
          const alpha = (1 - distance / limit) * 0.13 * Math.min(a.depth, b.depth);
          context.strokeStyle = `rgba(120,246,231,${alpha.toFixed(4)})`;
          context.lineWidth = 0.55;
          context.beginPath();
          context.moveTo(a.px, a.py);
          context.lineTo(b.px, b.py);
          context.stroke();
        }
      }

      for (const point of points) {
        const glow = 0.36 + point.depth * 0.56;
        const radius = point.radius * (0.75 + point.depth * 0.7);
        context.fillStyle = point.warm
          ? `rgba(255,111,58,${glow.toFixed(4)})`
          : `rgba(120,246,231,${glow.toFixed(4)})`;
        context.beginPath();
        context.arc(point.px, point.py, radius, 0, Math.PI * 2);
        context.fill();
        if (point.depth > 0.84) {
          context.strokeStyle = `rgba(120,246,231,${(glow * 0.3).toFixed(4)})`;
          context.lineWidth = 0.7;
          context.beginPath();
          context.arc(point.px, point.py, radius * 3.2, 0, Math.PI * 2);
          context.stroke();
        }
      }
      stage.dataset.particleProgress = progress.toFixed(4);
      canvas.dataset.progress = progress.toFixed(4);
    };

    const resizeCanvas = () => {
      const rect = stage.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      lastProgress = -1;
    };

    const update = () => {
      raf = 0;
      let progress = 0;
      if (enabled) {
        const rect = spacer.getBoundingClientRect();
        const range = Math.max(1, rect.height - window.innerHeight);
        progress = Math.min(1, Math.max(0, -rect.top / range));
      }
      const nextPhase = enabled ? Math.min(2, Math.floor(progress * 3)) : 0;
      stage.dataset.motion = enabled ? 'scroll' : 'static';
      stage.style.setProperty('--wd-ai-progress', progress.toFixed(4));
      stage.style.setProperty('--wd-ai-turn', `${(progress * 150).toFixed(2)}deg`);
      stage.style.setProperty('--wd-ai-scan', `${(progress * 82 + 8).toFixed(2)}%`);
      stage.style.setProperty('--wd-ai-dash', (-progress * 180).toFixed(2));
      stage.style.setProperty('--wd-ai-network-y', `${(-progress * 64).toFixed(2)}px`);
      if (nextPhase !== lastPhase) {
        lastPhase = nextPhase;
        setPhase(nextPhase);
      }
      drawParticles(progress);
    };

    const wake = () => {
      if (!raf) raf = window.requestAnimationFrame(update);
    };
    const handleResize = () => {
      resizeCanvas();
      wake();
    };
    const syncMode = () => {
      enabled = !reduceQuery.matches;
      if (!enabled) setPhase(0);
      handleResize();
    };

    syncMode();
    window.addEventListener('scroll', wake, { passive: true });
    window.addEventListener('resize', handleResize);
    reduceQuery.addEventListener('change', syncMode);
    const observer = new ResizeObserver(handleResize);
    observer.observe(stage);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('scroll', wake);
      window.removeEventListener('resize', handleResize);
      reduceQuery.removeEventListener('change', syncMode);
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={spacerRef} className="wd-ai-scene">
      <div ref={stageRef} className="wd-ai-stage" data-motion="static" data-phase={phase} data-particle-progress="0">
        <canvas ref={canvasRef} className="wd-ai-particles" data-progress="0" aria-hidden="true" />
        <div className="wd-ai-hud" aria-hidden="true">
          <div className="wd-ai-hud-top"><span>REDCODE / CREATIVE SYSTEM</span><span>PROCESS 0{phase + 1}</span></div>
          <svg className="wd-ai-network" viewBox="0 0 1200 700" fill="none">
            <path d="M80 520L280 350L480 410L650 190L860 270L1110 80" />
            <path d="M110 120L280 350L360 90L650 190L760 540L1030 480L1110 80" />
            <path d="M80 520L360 90M480 410L760 540M860 270L1030 480" />
            {[[80,520],[280,350],[480,410],[650,190],[860,270],[1110,80],[110,120],[360,90],[760,540],[1030,480]].map(([cx,cy],i) => (
              <g key={i}><circle cx={cx} cy={cy} r="7" /><circle cx={cx} cy={cy} r="18" className="wd-ai-node-ring" /></g>
            ))}
          </svg>
          <div className="wd-ai-scanner"><i /><b /><span /></div>
          <div className="wd-ai-coordinates">HK / 22.3193° N<br />HUMAN IN THE LOOP</div>
        </div>

        <div className="wd-ai-stage-grid">
          <div className="wd-ai-rail">
            <p className="wd-ai-system-label">WORKFLOW / 03</p>
            <ol>
              {STEPS.map((step, index) => (
                <li key={step.no} className={phase === index ? 'is-active' : ''} aria-current={phase === index ? 'step' : undefined}>
                  <span>{step.no}</span><strong>{step.code}</strong>
                </li>
              ))}
            </ol>
            <p className="wd-ai-rail-note">AI 分工加速<br />真人逐項驗收</p>
          </div>

          <div className="wd-ai-panels">
            {STEPS.map((step, index) => (
              <article key={step.no} className={`wd-ai-panel${phase === index ? ' is-active' : ''}`}>
                <div className="wd-ai-panel-meta"><span>{step.no} / 03</span><span>{step.code}</span></div>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                <ul>{step.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul>
              </article>
            ))}
          </div>
        </div>
        <div className="wd-ai-progress" aria-hidden="true"><i /></div>
      </div>
    </div>
  );
}
