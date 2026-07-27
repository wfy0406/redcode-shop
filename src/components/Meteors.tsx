import { useEffect, useRef, useState } from 'react';

/**
 * 全站流星動效層 —— 三層密度調度（R-A 主題一）
 *
 * - 全站唯一流星調度器：Starfield.tsx 內建 shooting stars 已預設關閉（R-A §6b，
 *   兩套並行角度 35° vs 45° 會顯亂）
 * - 三層密度（R-A §1）：far 55%（細/淡/慢）、mid 35%、near 10%（大/亮/快 + glow），
 *   near 同屏最多 1 粒保住稀有度；同屏總上限 5 粒
 * - 軌跡多樣化（§2）：以 -45° 為中軸 ±10° 抖動（-55° ~ -35°），行程 24–54vw；
 *   far 層 8% 機率反向（左→右）掠過；near 唔喺中央正文帶生成
 * - 偶發流星群（§3）：每次 spawn 後 6% 機率 burst —— 3–5 粒（far/mid 為主）喺 ~2s 內連發，
 *   之後強制冷靜期 9–15s，靠長平靜襯托「偶發」感
 * - 飛行 easing 用設計 token 級曲線 cubic-bezier(0.16, 1, 0.3, 1)（§5，爆發快出、尾段拖長）；
 *   far 層淡出提前到 50%（一閃即逝），mid/near 維持 65%
 * - 顏色：--pink / --gold / --lavender 低透明度尾跡
 * - fixed inset-0、pointer-events-none、aria-hidden，z-index 0：唔影響 layout
 * - prefers-reduced-motion: reduce 時完全唔渲染
 */

type Layer = 'far' | 'mid' | 'near';

interface Meteor {
  id: number;
  layer: Layer;
  /** 起點（viewport %） */
  top: number;
  left: number;
  /** 頭部直徑 px */
  head: number;
  /** 尾跡長度 px */
  tail: number;
  /** 整體透明度（層級權重） */
  opacity: number;
  /** glow 強度 0–1 */
  glow: number;
  /** 飛行時間 ms */
  duration: number;
  /** 飛行位移 vw（已計角度） */
  tx: number;
  ty: number;
  /** 尾跡旋轉角 deg（尾尖指向飛行反方向） */
  rotate: number;
  /** 尾跡中段色（粉 / 金 / 紫，低透明度） */
  midColor: string;
}

const MAX_CONCURRENT = 5;
const MAX_NEAR = 1;
const SPAWN_MIN = 2500;
const SPAWN_MAX = 6000;
const BURST_CHANCE = 0.06;
const BURST_COOLDOWN_MIN = 9000;
const BURST_COOLDOWN_MAX = 15000;

/** R-A §1 三層參數表 */
const LAYER_PARAMS = {
  far: { head: 1.5, tail: [40, 70], opacity: [0.35, 0.5], dur: [1600, 2400], glow: 0 },
  mid: { head: 2.5, tail: [60, 110], opacity: [0.6, 0.8], dur: [1000, 1600], glow: 0.45 },
  near: { head: 3.5, tail: [120, 180], opacity: [0.9, 1.0], dur: [700, 1100], glow: 0.7 },
} as const;

/** --pink-soft / --gold-soft / --lavender 低透明度尾跡中段色 */
const MID_COLORS = ['rgba(255, 77, 141, 0.8)', 'rgba(247, 215, 116, 0.7)', 'rgba(201, 166, 255, 0.8)'];

function pickLayer(): Layer {
  const r = Math.random();
  return r < 0.55 ? 'far' : r < 0.9 ? 'mid' : 'near';
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomMeteor(id: number, layer: Layer): Meteor {
  const p = LAYER_PARAMS[layer];
  // 角度：-45° 中軸 ±10°（即俯角 35°–55°），斜啲就飛短啲（行程同角度綁定）
  const deg = 45 + (Math.random() - 0.5) * 20;
  const rad = (deg * Math.PI) / 180;
  const travel = rand(24, 54) * (45 / deg); // 越斜（deg 大）行程越短
  // far 層 8% 機率反向（左→右），極稀有不搶戲
  const flip = layer === 'far' && Math.random() < 0.08;
  const dirX = flip ? 1 : -1;

  // 生成區域：far 擴到右上半天（top 0–55vh / left 30–98vw）；
  // mid/near 維持右上角（2–40vh / 55–98vw），避開中央正文帶（top 40–70vh、left 20–70vw）
  // 反向流星由左側出發
  const top = layer === 'far' ? rand(0, 55) : rand(2, 40);
  const left = flip ? rand(2, 40) : layer === 'far' ? rand(30, 98) : rand(55, 98);

  // 位移（vw）：dirX·cos(deg)·travel 水平、sin(deg)·travel 向下
  const tx = dirX * Math.cos(rad) * travel;
  const ty = Math.sin(rad) * travel;
  // 尾跡由頭部向後（飛行反方向）延伸：backward = (-tx, -ty)
  const rotate = (Math.atan2(-Math.sin(rad), -dirX * Math.cos(rad)) * 180) / Math.PI;

  return {
    id,
    layer,
    top,
    left,
    head: layer === 'near' ? rand(3.5, 4) : p.head,
    tail: rand(p.tail[0], p.tail[1]),
    opacity: rand(p.opacity[0], p.opacity[1]),
    glow: p.glow,
    duration: rand(p.dur[0], p.dur[1]),
    tx,
    ty,
    rotate,
    midColor: MID_COLORS[Math.floor(Math.random() * MID_COLORS.length)],
  };
}

export default function Meteors() {
  const [meteors, setMeteors] = useState<Meteor[]>([]);
  const idRef = useRef(0);
  const totalRef = useRef(0);
  const nearRef = useRef(0);
  const [enabled] = useState(
    () =>
      typeof window !== 'undefined' &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    if (!enabled) return;

    let spawnTimer = 0;
    const timers = new Set<number>();
    let cancelled = false;

    const addTimer = (t: number) => {
      timers.add(t);
      return t;
    };

    const spawnOne = (forcedLayer?: Layer) => {
      if (cancelled || totalRef.current >= MAX_CONCURRENT) return;
      let layer = forcedLayer ?? pickLayer();
      // near 同屏最多 1 粒——「哇」嘅稀有度先係價值；爆滿就降級做 mid
      if (layer === 'near' && nearRef.current >= MAX_NEAR) layer = 'mid';

      const meteor = randomMeteor(++idRef.current, layer);
      totalRef.current += 1;
      if (layer === 'near') nearRef.current += 1;
      setMeteors((prev) => [...prev, meteor]);

      const t = addTimer(
        window.setTimeout(() => {
          timers.delete(t);
          totalRef.current -= 1;
          if (meteor.layer === 'near') nearRef.current -= 1;
          setMeteors((prev) => prev.filter((m) => m.id !== meteor.id));
        }, meteor.duration + 150),
      );
    };

    const scheduleSpawn = (delay: number) => {
      spawnTimer = addTimer(
        window.setTimeout(() => {
          timers.delete(spawnTimer);
          tick();
        }, delay),
      );
    };

    const tick = () => {
      if (cancelled) return;
      spawnOne();
      // 6% 機率進入 burst：3–5 粒（far/mid 為主）喺 ~2s 內連發，之後 9–15s 冷靜期
      if (Math.random() < BURST_CHANCE && totalRef.current <= 1) {
        const n = 3 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n; i++) {
          addTimer(
            window.setTimeout(() => {
              spawnOne(Math.random() < 0.7 ? 'far' : 'mid');
            }, i * rand(150, 400)),
          );
        }
        scheduleSpawn(rand(BURST_COOLDOWN_MIN, BURST_COOLDOWN_MAX));
      } else {
        scheduleSpawn(rand(SPAWN_MIN, SPAWN_MAX));
      }
    };

    // 第一粒快啲出，等用戶一入嚟就見到
    scheduleSpawn(600 + Math.random() * 1200);

    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
      timers.clear();
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden" style={{ zIndex: 0 }}>
      {meteors.map((m) => (
        <div
          key={m.id}
          className={`absolute ${m.layer === 'far' ? 'meteor-fly-far' : 'meteor-fly'}`}
          style={{
            top: `${m.top}vh`,
            left: `${m.left}vw`,
            // CSS 變數俾 keyframes 用：按角度抖動後嘅飛行位移
            ['--meteor-tx' as string]: `${m.tx}vw`,
            ['--meteor-ty' as string]: `${m.ty}vw`,
            animationDuration: `${m.duration}ms`,
          }}
        >
          {/* 尾跡：由頭部（原點）向飛行反方向延伸，白頭 → 粉/金/紫 → 透明 */}
          <div
            className="relative"
            style={{
              width: `${m.tail}px`,
              height: `${Math.max(m.head * 0.7, 1)}px`,
              transform: `rotate(${m.rotate}deg)`,
              transformOrigin: 'left center',
              borderRadius: '9999px',
              background: `linear-gradient(to right, rgba(255,255,255,0.95) 0%, ${m.midColor} 35%, transparent 100%)`,
              filter:
                m.glow > 0
                  ? `drop-shadow(0 0 ${Math.round(10 * m.glow)}px rgba(255, 77, 141, ${0.3 + m.glow * 0.35}))`
                  : 'none',
              opacity: m.opacity,
            }}
          >
            {/* 頭部亮點（原點 = 飛行最前） */}
            <span
              className="absolute left-0 top-1/2 block -translate-y-1/2 rounded-full bg-white"
              style={{
                width: `${m.head}px`,
                height: `${m.head}px`,
                boxShadow:
                  m.layer === 'near'
                    ? '0 0 8px 2px rgba(255,255,255,0.8), 0 0 16px 6px rgba(255, 77, 141, 0.45)'
                    : m.layer === 'mid'
                      ? '0 0 6px 2px rgba(255,255,255,0.6), 0 0 10px 3px rgba(255, 77, 141, 0.3)'
                      : '0 0 4px 1px rgba(255,255,255,0.4)',
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
            transform: translate3d(var(--meteor-tx), var(--meteor-ty), 0);
          }
        }
        @keyframes meteor-fly-far {
          0% { opacity: 0; transform: translate3d(0, 0, 0); }
          6% { opacity: 1; }
          50% { opacity: 1; }
          100% {
            opacity: 0;
            transform: translate3d(var(--meteor-tx), var(--meteor-ty), 0);
          }
        }
        .meteor-fly, .meteor-fly-far {
          animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1);
          animation-fill-mode: both;
          will-change: transform, opacity;
        }
        .meteor-fly { animation-name: meteor-fly; }
        .meteor-fly-far { animation-name: meteor-fly-far; }
        @media (prefers-reduced-motion: reduce) {
          .meteor-fly, .meteor-fly-far { display: none; }
        }
      `}</style>
    </div>
  );
}
