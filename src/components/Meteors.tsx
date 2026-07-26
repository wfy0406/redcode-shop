import { useEffect, useRef, useState } from 'react';

/**
 * 全站流星動效層 —— 「落流星咁」嘅星空點綴
 *
 * - fixed inset-0、pointer-events-none，z-index 0：高過星空 canvas（-2）同星雲層（-1），低過主內容（z-10）
 * - JS 定時器每 2.5–6s 隨機生成一粒流星，同時上限 3 粒
 * - 每粒流星：頭部 3px 亮點 + 60–120px 漸隱尾跡（白 → 粉/紫 → 透明），
 *   沿 -45° 方向（右上 → 左下）劃過，drop-shadow 微光
 * - prefers-reduced-motion: reduce 時完全唔渲染
 */

interface Meteor {
  id: number;
  /** 起點（viewport %） */
  top: number;
  left: number;
  /** 尾跡長度 px */
  tail: number;
  /** 飛行時間 ms */
  duration: number;
  /** 飛行距離 vw */
  travel: number;
  /** 尾跡中段色（粉 / 紫 / 白） */
  midColor: string;
}

const MAX_CONCURRENT = 3;
const SPAWN_MIN = 2500;
const SPAWN_MAX = 6000;
const MID_COLORS = ['rgba(255, 77, 141, 0.9)', 'rgba(177, 77, 255, 0.85)', 'rgba(255, 247, 232, 0.9)'];

function randomMeteor(id: number): Meteor {
  return {
    id,
    // 由右上半屏出發，向左下飛
    top: 2 + Math.random() * 38, // 2–40vh
    left: 55 + Math.random() * 43, // 55–98vw
    tail: 60 + Math.random() * 60, // 60–120px
    duration: 900 + Math.random() * 800, // 0.9–1.7s
    travel: 28 + Math.random() * 22, // 28–50vw
    midColor: MID_COLORS[Math.floor(Math.random() * MID_COLORS.length)],
  };
}

export default function Meteors() {
  const [meteors, setMeteors] = useState<Meteor[]>([]);
  const idRef = useRef(0);
  const countRef = useRef(0);
  const [enabled] = useState(
    () =>
      typeof window !== 'undefined' &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    if (!enabled) return;

    let spawnTimer = 0;
    const despawnTimers = new Set<number>();
    let cancelled = false;

    const scheduleSpawn = (delay: number) => {
      spawnTimer = window.setTimeout(() => {
        if (cancelled) return;
        if (countRef.current < MAX_CONCURRENT) {
          const meteor = randomMeteor(++idRef.current);
          countRef.current += 1;
          setMeteors((prev) => [...prev, meteor]);
          const t = window.setTimeout(() => {
            despawnTimers.delete(t);
            countRef.current -= 1;
            setMeteors((prev) => prev.filter((m) => m.id !== meteor.id));
          }, meteor.duration + 120);
          despawnTimers.add(t);
        }
        scheduleSpawn(SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN));
      }, delay);
    };

    // 第一粒快啲出，等用戶一入嚟就見到
    scheduleSpawn(600 + Math.random() * 1200);

    return () => {
      cancelled = true;
      window.clearTimeout(spawnTimer);
      for (const t of despawnTimers) window.clearTimeout(t);
      despawnTimers.clear();
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden" style={{ zIndex: 0 }}>
      {meteors.map((m) => (
        <div
          key={m.id}
          className="meteor-fly absolute"
          style={{
            top: `${m.top}vh`,
            left: `${m.left}vw`,
            // CSS 變數俾 keyframes 用：向 -45°（左下）飛 travel vw
            ['--meteor-travel' as string]: `${m.travel}vw`,
            animationDuration: `${m.duration}ms`,
          }}
        >
          {/* 尾跡：horizontal bar 轉 135°，頭（左端）指向左下飛行方向 */}
          <div
            className="relative"
            style={{
              width: `${m.tail}px`,
              height: '2.5px',
              transform: 'rotate(135deg)',
              transformOrigin: 'left center',
              borderRadius: '9999px',
              background: `linear-gradient(to left, rgba(255,255,255,0.95) 0%, ${m.midColor} 35%, transparent 100%)`,
              filter: 'drop-shadow(0 0 6px rgba(255, 77, 141, 0.45))',
              opacity: 0.85,
            }}
          >
            {/* 頭部亮點 */}
            <span
              className="absolute left-0 top-1/2 block -translate-y-1/2 rounded-full bg-white"
              style={{
                width: '3px',
                height: '3px',
                boxShadow:
                  '0 0 6px 2px rgba(255,255,255,0.7), 0 0 12px 4px rgba(255, 77, 141, 0.35)',
              }}
            />
          </div>
        </div>
      ))}
      <style>{`
        @keyframes meteor-fly {
          0% { opacity: 0; transform: translate3d(0, 0, 0); }
          6% { opacity: 1; }
          65% { opacity: 1; }
          100% {
            opacity: 0;
            transform: translate3d(calc(var(--meteor-travel) * -1), var(--meteor-travel), 0);
          }
        }
        .meteor-fly {
          animation-name: meteor-fly;
          animation-timing-function: ease-out;
          animation-fill-mode: both;
          will-change: transform, opacity;
        }
        @media (prefers-reduced-motion: reduce) {
          .meteor-fly { display: none; }
        }
      `}</style>
    </div>
  );
}
