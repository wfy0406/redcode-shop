import { trpc } from '@/providers/trpc';

/**
 * 首頁頂部直播 Banner（v2.2.2，2026-09-30 老闆指令）
 *
 * 「如果直播緊，我想一入首頁首先見到直播開始咗啦！跟住按咗會往下見到
 *   LIVE 直播進行中區塊」——currentLive 有直播先 render，擺首頁最頂；
 * 撳咗 smooth scroll 落 #live-now（LiveNowSection）。
 *
 * 動感：紅點呼吸（opacity）＋背景紅光暈流動（transform translateX）；
 * 全部淨 opacity／transform，reduced-motion 停。
 */
export default function LiveTopBanner() {
  const liveQuery = trpc.push.currentLive.useQuery(undefined, {
    refetchInterval: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const live = liveQuery.data?.live ?? null;
  if (!live) return null;

  const scrollToLive = () => {
    const el = document.getElementById('live-now');
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <button
      type="button"
      onClick={scrollToLive}
      className="relative block w-full overflow-hidden border-b px-5 py-3 text-left"
      style={{
        borderColor: 'rgba(255, 0, 84, 0.4)',
        background: 'linear-gradient(90deg, rgba(255, 0, 84, 0.16) 0%, var(--space-2) 55%, rgba(245, 197, 24, 0.10) 100%)',
      }}
      aria-label="直播進行中，撳我落去直播區"
    >
      {/* 流動紅光（transform，極低透明度） */}
      <span
        aria-hidden="true"
        className="livetop-flow pointer-events-none absolute inset-y-0 w-1/4"
        style={{
          background:
            'linear-gradient(100deg, transparent 0%, rgba(255, 0, 84, 0.16) 50%, transparent 100%)',
        }}
      />
      <span className="relative mx-auto flex max-w-[1280px] flex-wrap items-center justify-center gap-x-4 gap-y-1 md:justify-between md:px-3 xl:px-7">
        <span className="flex items-center gap-2.5">
          <span
            className="livetop-dot inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: 'var(--pink)' }}
            aria-hidden="true"
          />
          <span className="font-mono text-[11px] font-medium tracking-[0.28em] text-pink-tint">
            LIVE
          </span>
          <span className="font-serif-tc text-[15px] font-bold text-starlight md:text-base">
            直播開始咗啦！Glo Glo 開咗台
          </span>
          <span className="hidden font-serif-tc text-[13px] text-gold-soft sm:inline">
            {live.liveDate}・{live.liveSession}
          </span>
        </span>
        <span className="flex items-center gap-1.5 font-serif-tc text-[13px] font-semibold text-gold">
          立即入直播
          <span aria-hidden="true" className="livetop-arrow inline-block">↓</span>
        </span>
      </span>

      <style>{`
        .livetop-dot { animation: livetop-breathe 1.6s ease-in-out infinite; }
        @keyframes livetop-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
        .livetop-flow { animation: livetop-sweep 3.6s ease-in-out infinite; }
        @keyframes livetop-sweep {
          0% { transform: translateX(-120%); opacity: 0; }
          20% { opacity: 1; }
          60% { transform: translateX(520%); opacity: 1; }
          75%, 100% { transform: translateX(520%); opacity: 0; }
        }
        .livetop-arrow { animation: livetop-bob 1.4s ease-in-out infinite; }
        @keyframes livetop-bob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(3px); }
        }
        @media (prefers-reduced-motion: reduce) {
          .livetop-dot, .livetop-flow, .livetop-arrow { animation: none; }
          .livetop-flow { opacity: 0; }
        }
      `}</style>
    </button>
  );
}
