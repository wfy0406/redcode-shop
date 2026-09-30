import { trpc } from '@/providers/trpc';
import { openFacebookLive } from '@/lib/openLive';
import { useReveal } from '@/hooks/useReveal';

/**
 * 直播回顧（v2.2.5 老闆指令）：直播頁保留最近 10 場已落畫嘅直播，
 * 寫明日期＋場次，撳一撳用 openFacebookLive 彈去 Facebook app（冇裝先落網頁版）。
 *
 * 設計：editorial index 行式——hairline 分隔（唔用卡片疊卡片）、
 * 左側 mono 編號＋括號日期 [2026.09.30]、大字 serif 場次題目，
 * hover 先浮現「重溫直播 ↗」（opacity/transform，跟全站動效鐵律）。
 * 冇回顧時成區唔 render（唔好留空殼）。
 */

/** liveDate 原樣係「2026-09-30」款；顯示做「2026.09.30」更 editorial */
function fmtDate(raw: string): string {
  return raw.trim().replaceAll('-', '.').replaceAll('/', '.');
}

export default function LiveHistorySection() {
  const ref = useReveal<HTMLDivElement>();
  const historyQuery = trpc.push.liveHistory.useQuery(undefined, {
    refetchInterval: 60_000, // 同 LiveNowSection 對齊：一分鐘自己更新
    retry: false,
  });
  const items = historyQuery.data?.items ?? [];

  // 載入中／冇回顧：成區隱藏（首頁直播頁保持乾淨）
  if (items.length === 0) return null;

  return (
    <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
      <div ref={ref} className="reveal">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h2 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px]">
            <span className="font-display-en mr-3 text-purple-text">Replay</span>
            直播回顧
          </h2>
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-txt-3">
            最近 {items.length} 場 · 撳入去重溫
          </p>
        </div>

        <ol className="mt-8">
          {items.map((item, i) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => openFacebookLive(item.url)}
                className="group flex w-full flex-wrap items-baseline gap-x-5 gap-y-1 border-t px-1 py-5 text-left md:py-6"
                style={{ borderColor: 'var(--space-line)' }}
                aria-label={`重溫 ${fmtDate(item.liveDate)} ${item.liveSession}（去 Facebook）`}
              >
                {/* 編號（01–10，mono 紫） */}
                <span
                  className="w-7 shrink-0 font-mono text-sm text-purple-text"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                  aria-hidden="true"
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                {/* 括號日期（mono 金） */}
                <span
                  className="shrink-0 font-mono text-[12px] tracking-[0.12em] text-gold md:text-[13px]"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  [{fmtDate(item.liveDate)}]
                </span>
                {/* 場次題目（大字 serif，hover 轉 pink） */}
                <span className="min-w-0 flex-1 font-serif-tc text-xl font-semibold leading-[1.3] text-starlight transition-colors duration-200 group-hover:text-pink-soft md:text-2xl">
                  {item.liveSession}
                </span>
                {/* hover 先浮現嘅入口（opacity/transform 鐵律） */}
                <span className="inline-flex shrink-0 items-center gap-1.5 text-[13px] font-medium text-pink-soft opacity-60 transition-all duration-200 group-hover:translate-x-1 group-hover:opacity-100 md:opacity-0 md:-translate-x-1">
                  重溫直播
                  <span aria-hidden="true">↗</span>
                </span>
              </button>
            </li>
          ))}
        </ol>

        <p className="mt-4 text-[13px] leading-relaxed text-txt-3">
          手機有裝 Facebook 會直接開 app 重溫；冇裝就開網頁版。
        </p>
      </div>
    </section>
  );
}
