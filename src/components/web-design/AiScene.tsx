'use client';

/** New-era 式未來工作流：語義內容保留，HUD／掃描環／網絡只作裝飾。 */
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

export default function AiScene() {
  const spacerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const spacer = spacerRef.current;
    const stage = stageRef.current;
    if (!spacer || !stage) return undefined;
    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const coarseQuery = window.matchMedia('(pointer: coarse)');
    let raf = 0;
    let enabled = false;
    let lastPhase = -1;

    const update = () => {
      raf = 0;
      if (!enabled) {
        stage.dataset.motion = 'static';
        stage.style.setProperty('--wd-ai-progress', '0');
        return;
      }
      stage.dataset.motion = 'scroll';
      const rect = spacer.getBoundingClientRect();
      const range = Math.max(1, rect.height - window.innerHeight);
      const progress = Math.min(1, Math.max(0, -rect.top / range));
      const nextPhase = Math.min(2, Math.floor(progress * 3));
      stage.style.setProperty('--wd-ai-progress', progress.toFixed(4));
      stage.style.setProperty('--wd-ai-turn', `${(progress * 120).toFixed(2)}deg`);
      stage.style.setProperty('--wd-ai-scan', `${(progress * 100).toFixed(2)}%`);
      if (nextPhase !== lastPhase) {
        lastPhase = nextPhase;
        setPhase(nextPhase);
      }
    };
    const wake = () => {
      if (!raf) raf = window.requestAnimationFrame(update);
    };
    const syncMode = () => {
      enabled = !reduceQuery.matches && !coarseQuery.matches && window.innerWidth > 900;
      if (!enabled) setPhase(0);
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
    <div ref={spacerRef} className="wd-ai-scene">
      <div ref={stageRef} className="wd-ai-stage" data-motion="static" data-phase={phase}>
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
