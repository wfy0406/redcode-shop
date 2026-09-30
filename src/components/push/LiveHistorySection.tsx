import { useState } from 'react';
import { ExternalLink, Play } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { openFacebookLive } from '@/lib/openLive';
import { useReveal } from '@/hooks/useReveal';

/**
 * 直播回顧（v2.2.6 老闆指令「高度美化・聚光燈之下・最好可以預覽 FB 片」）：
 * 直播頁保留最近 10 場已落畫嘅直播，每場一張「舞台卡」——
 *
 * 設計概念：每場直播係一個舞台。
 * · 頁區上方兩支聚光燈射落嚟（旋轉漸層光錐，呼吸明暗；只郁 opacity，跟動效鐵律）
 * · 卡嘅 16:9「舞台」預設係設計好嘅 poster：頂部聚光燈 radial 光池＋
 *   地面 pink 反光＋中央金圈 ▶（脈衝環 scale/opacity）；
 * · 撳 ▶ → URL 認到影片 ID 就原位載入 Facebook 播放器（v2.2.7：認唔到
 *   就唔再嵌入「影片不存在」畫面，直接 openFacebookLive 彈去 FB app）；
 *   撳「去 Facebook 睇 ↗」→ openFacebookLive（有 app 彈 app）。
 * · 第一場（最新）做 featured，桌面版佔滿兩欄。
 * 冇回顧時成區唔 render。
 */

/** liveDate 原樣係「2026-09-30」款；顯示做「2026.09.30」更 editorial */
function fmtDate(raw: string): string {
  return raw.trim().replaceAll('-', '.').replaceAll('/', '.');
}

interface HistoryItem {
  id: number;
  liveDate: string;
  liveSession: string;
  url: string;
  sentAt: string | Date | null;
  /** server 已解好嘅 FB 嵌入 URL（share/fb.watch 短鏈都解）；null = 嵌入唔到，撳 ▶ 彈 FB app */
  embedUrl?: string | null;
}

/* ---------- 單場舞台卡 ---------- */
function StageCard({ item, index, featured }: { item: HistoryItem; index: number; featured: boolean }) {
  const [playing, setPlaying] = useState(false);
  const embedUrl = item.embedUrl ?? null;

  return (
    <article
      className={`group overflow-hidden rounded-2xl border bg-space-2 ${featured ? 'md:col-span-2' : ''}`}
      style={{ borderColor: 'var(--glass-border)' }}
    >
      {/* ===== 舞台（16:9）：poster → 撳 ▶ 原位變 FB 播放器 ===== */}
      <div className="relative aspect-video w-full overflow-hidden" style={{ background: '#07040F' }}>
        {playing && embedUrl ? (
          <iframe
            src={embedUrl}
            className="absolute inset-0 h-full w-full border-0"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            title={`${item.liveDate} ${item.liveSession} 直播回顧`}
          />
        ) : (
          <button
            type="button"
            onClick={() => (embedUrl ? setPlaying(true) : openFacebookLive(item.url))}
            className="absolute inset-0 block h-full w-full cursor-pointer text-left"
            aria-label={`播放 ${fmtDate(item.liveDate)} ${item.liveSession} 回顧`}
          >
            {/* 聚光燈光池（頂中 radial）＋地面反光（pink ellipse）＋兩支光錐 */}
            <span
              aria-hidden="true"
              className="stage-spot absolute inset-0"
              style={{
                background:
                  'radial-gradient(ellipse 55% 70% at 50% 0%, rgba(245,213,138,0.20) 0%, rgba(255,0,84,0.06) 45%, transparent 72%)',
              }}
            />
            <span
              aria-hidden="true"
              className="stage-beam stage-beam-l absolute -top-1/4 left-[16%] h-[150%] w-[26%]"
              style={{
                background: 'linear-gradient(180deg, rgba(245,213,138,0.14) 0%, transparent 78%)',
                clipPath: 'polygon(42% 0, 58% 0, 100% 100%, 0% 100%)',
                transform: 'rotate(-9deg)',
              }}
            />
            <span
              aria-hidden="true"
              className="stage-beam stage-beam-r absolute -top-1/4 right-[16%] h-[150%] w-[26%]"
              style={{
                background: 'linear-gradient(180deg, rgba(255,0,84,0.12) 0%, transparent 78%)',
                clipPath: 'polygon(42% 0, 58% 0, 100% 100%, 0% 100%)',
                transform: 'rotate(9deg)',
              }}
            />
            <span
              aria-hidden="true"
              className="absolute inset-x-[12%] bottom-0 h-[26%]"
              style={{
                background: 'radial-gradient(ellipse 50% 100% at 50% 100%, rgba(255,0,84,0.16) 0%, transparent 70%)',
              }}
            />

            {/* 頂行：場次編號＋日期（左）／REPLAY tag（右） */}
            <span className="absolute left-4 top-4 flex items-baseline gap-3 md:left-5 md:top-5">
              <span
                className="font-mono text-[12px] text-purple-text"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {String(index + 1).padStart(2, '0')}
              </span>
              <span
                className="font-mono text-[12px] tracking-[0.12em] text-gold md:text-[13px]"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                [{fmtDate(item.liveDate)}]
              </span>
            </span>
            <span
              className="absolute right-4 top-4 rounded-full border px-2.5 py-1 font-mono text-[10px] tracking-[0.22em] text-txt-3 md:right-5 md:top-5"
              style={{ borderColor: 'var(--glass-border)', background: 'rgba(10,6,20,0.5)' }}
            >
              REPLAY
            </span>

            {/* 中央 ▶：金圈＋pink 核心＋脈衝環（transform/opacity） */}
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-3">
              <span className="relative flex h-16 w-16 items-center justify-center md:h-[72px] md:w-[72px]">
                <span
                  aria-hidden="true"
                  className="stage-pulse absolute inset-0 rounded-full border"
                  style={{ borderColor: 'rgba(245,197,24,0.55)' }}
                />
                <span
                  className="flex h-full w-full items-center justify-center rounded-full border transition-transform duration-200 group-hover:scale-105"
                  style={{
                    borderColor: 'var(--gold)',
                    background: 'rgba(10,6,20,0.72)',
                    boxShadow: '0 0 32px rgba(245,197,24,0.25), 0 0 64px rgba(255,0,84,0.18)',
                  }}
                >
                  <Play size={featured ? 26 : 22} className="ml-0.5 text-gold" fill="currentColor" aria-hidden="true" />
                </span>
              </span>
              <span className="text-[12px] font-medium tracking-[0.18em] text-txt-2">
                {embedUrl ? '撳掣即刻睇' : '去 Facebook 睇'}
              </span>
            </span>

            {/* 場次名壓舞台底（大字 serif） */}
            <span className="absolute inset-x-4 bottom-3.5 md:inset-x-5 md:bottom-4">
              <span className="block truncate font-serif-tc text-lg font-semibold leading-snug text-starlight md:text-xl">
                {item.liveSession}
              </span>
            </span>
          </button>
        )}
      </div>

      {/* ===== 卡底 meta 行：日期・場次｜去 Facebook 睇 ===== */}
      <div className="flex items-center justify-between gap-4 px-4 py-3.5 md:px-5">
        <p className="min-w-0 text-[13px] text-txt-3">
          <span className="font-mono text-[12px] text-gold" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {fmtDate(item.liveDate)}
          </span>
          <span className="mx-2 text-txt-disabled">·</span>
          <span className="text-txt-2">{item.liveSession}</span>
        </p>
        <button
          type="button"
          onClick={() => openFacebookLive(item.url)}
          className="inline-flex shrink-0 items-center gap-1.5 text-[13px] font-medium text-pink-soft transition-opacity hover:opacity-75"
          aria-label={`去 Facebook 睇 ${fmtDate(item.liveDate)} ${item.liveSession}`}
        >
          去 Facebook 睇
          <ExternalLink size={13} aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

export default function LiveHistorySection() {
  const ref = useReveal<HTMLDivElement>();
  const historyQuery = trpc.push.liveHistory.useQuery(undefined, {
    refetchInterval: 60_000,
    retry: false,
  });
  const items = (historyQuery.data?.items ?? []) as HistoryItem[];

  if (items.length === 0) return null;

  return (
    <section className="relative mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
      {/* 成區嘅聚光燈底（兩支大光錐由頂射落嚟，呼吸明暗；只郁 opacity） */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-10 h-[420px] overflow-visible">
        <div
          className="stage-beam stage-beam-l absolute -top-6 left-[8%] h-full w-[24%]"
          style={{
            background: 'linear-gradient(180deg, rgba(245,213,138,0.10) 0%, transparent 75%)',
            clipPath: 'polygon(44% 0, 56% 0, 100% 100%, 0% 100%)',
            transform: 'rotate(-11deg)',
          }}
        />
        <div
          className="stage-beam stage-beam-r absolute -top-6 right-[8%] h-full w-[24%]"
          style={{
            background: 'linear-gradient(180deg, rgba(255,0,84,0.09) 0%, transparent 75%)',
            clipPath: 'polygon(44% 0, 56% 0, 100% 100%, 0% 100%)',
            transform: 'rotate(11deg)',
          }}
        />
      </div>

      <div ref={ref} className="reveal relative">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h2 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px]">
            <span className="font-display-en mr-3 text-purple-text">Replay</span>
            直播回顧
          </h2>
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-txt-3">
            最近 {items.length} 場 · 撳 ▶ 即刻重溫
          </p>
        </div>

        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {items.map((item, i) => (
            <StageCard key={item.id} item={item} index={i} featured={i === 0} />
          ))}
        </div>

        <p className="mt-5 text-[13px] leading-relaxed text-txt-3">
          撳 ▶ 唔離開官網都可以直接睇；想留言互動，撳「去 Facebook 睇」——有裝 app 會直接開 app。
        </p>
      </div>

      {/* 舞台燈呼吸＋▶ 脈衝：淨 opacity/transform（老闆鐵律）；reduced-motion 全停 */}
      <style>{`
        .stage-beam-l { animation: stage-beam-a 5.2s ease-in-out infinite; }
        .stage-beam-r { animation: stage-beam-b 5.2s ease-in-out infinite; }
        @keyframes stage-beam-a { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
        @keyframes stage-beam-b { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .stage-pulse { animation: stage-pulse 2.4s ease-out infinite; }
        @keyframes stage-pulse {
          0% { transform: scale(1); opacity: 0.9; }
          70% { transform: scale(1.45); opacity: 0; }
          100% { transform: scale(1.45); opacity: 0; }
        }
        .stage-spot { animation: stage-spot 6.4s ease-in-out infinite; }
        @keyframes stage-spot { 0%, 100% { opacity: 0.85; } 50% { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) {
          .stage-beam-l, .stage-beam-r, .stage-pulse, .stage-spot { animation: none; }
        }
      `}</style>
    </section>
  );
}
