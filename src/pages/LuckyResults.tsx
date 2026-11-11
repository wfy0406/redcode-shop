import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { Gift, PartyPopper, Sparkles, Trophy } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { LuckyPublicActions } from '@/components/lucky/LuckyPublicActions';
import { setCanonicalPath } from '@/lib/seo';
import { holdClosedAnnouncementSeo, luckyAnnouncementGateOpen, luckyAnnouncementStatusFresh } from '@/lib/luckyAnnouncementVisibility';

/**
 * LuckyResults（v2.5.8，老闆指令「公開抽獎公告要特別華麗動態引流」）
 * --------------------------------------------------------------
 * 公開中獎公告頁（唔使登入）：/lucky-results/:eventId
 * - 資料全部係真實抽獎結果（luckyDraw.publicEventResults）：活動名＋預定抽獎日（scheduledDrawDate，
 *   null＝舊活動未定，如實寫「抽獎日待公佈」）＋實際抽獎日期時間（嚟自 winner 真實紀錄）＋
 *   winner 對外顯示名＋獎品名；唔放電話／email／會員編號／地址／內部備註。
 * - 沿用現行「已抽出」口径（pending＋confirmed）；cancelled／declined 唔當有效中獎
 *   （同後台 drawnCount 同一口径，唔係新加嘅展示過濾）。
 * - 狀態齊全：載入中／載入失敗（可重試）／活動唔存在或已刪除／仲未抽（即將公佈）。
 * - 引流 CTA（創意規矩：深色實心底＋金色描邊，唔用透明 ghost）：
 *   直播開播通知（重用現有 browser push／會員流程）＋ AI 試穿（/try-on）＋
 *   Facebook 專頁＋ Facebook 分享（真 sharer URL）＋複製公開連結。
 * - 華麗動畫全部淨 transform／opacity（GPU-only），prefers-reduced-motion 自動停。
 *
 * v2026.11.11.2（老闆指令：對外抽獎公告總開關，預設關閉）：
 * - luckyDraw.publicAnnouncementStatus 回 {enabled:false} → 成個功能對外收埋：
 *   總頁同單場頁都顯示「對外中獎公告已關閉」＋獨立查劵入口，客戶端即刻 noindex，
 *   **唔會再渲染任何舊 React Query 快取入面嘅活動名／中獎名單**（closed branch 先於 data branch）。
 * - 查劵頁（/lucky-tickets/:eventId）係獨立路徑，唔受總開關影響——呢度只提供入口。
 */

/** YYYYMMDD → YYYY-MM-DD */
function fmtDate(d: string): string {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** 總頁活動日期標籤（v2026.10.26.2）：
 *  有預定日一律如實寫「預定抽獎日」；已開獎嘅真實抽出日由單場頁 winner 紀錄列出；
 *  舊活動 null＋未開獎 → 如實「抽獎日待公佈」（唔好用 createdAt 冒充）；
 *  舊活動 null＋已開獎 → 總頁冇實際抽出日資料，唔出日期字（入單場頁睇每位 winner 真實抽獎日）。 */
function indexDateLabel(ev: { scheduledDrawDate: string | null; winnerCount: number }): string {
  if (ev.scheduledDrawDate) return `預定抽獎日 ${fmtDate(ev.scheduledDrawDate)}`;
  return ev.winnerCount > 0 ? '' : '抽獎日待公佈';
}

/** 抽出時間（香港時間 HH:MM） */
function fmtTimeHkt(iso: string | Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', hour12: false });
}

export default function LuckyResults() {
  const params = useParams();
  // 冇 eventId → 公告總頁（全部活動一覽）
  if (params.eventId == null) return <LuckyResultsIndex />;
  return <LuckyResultsEvent eventIdRaw={params.eventId} />;
}

/* ---------- 總開關關閉時嘅統一對外文案（v2026.11.11.2） ----------
 * 零活動名／零中獎名單（唔渲染任何舊快取資料）；只保留獨立查劵指引——
 * 查劵頁係獨立路徑，公告關閉唔影響客人查自己嘅劵。 */
function AnnouncementClosedCard({ eventId }: { eventId?: number }) {
  return (
    <div className="lr-state" role="status">
      <Gift size={22} aria-hidden="true" className="mx-auto mb-3 text-gold" />
      <p className="font-serif-tc text-lg font-semibold text-txt-1">對外中獎公告已關閉</p>
      <p className="mt-2 text-[13.5px] leading-relaxed text-txt-3">
        RedCode 暫停公開抽獎公告；之前已公佈嘅活動同中獎名單已經全部收埋。
      </p>
      {eventId ? (
        <>
          <p className="mt-2 text-[13.5px] leading-relaxed text-txt-3">
            持有呢場抽獎劵嘅客人唔受影響，仍然可以用獨立查劵連結睇自己有幾多張劵：
          </p>
          <p className="lr-lookup-cta-wrap">
            <Link to={`/lucky-tickets/${eventId}`} className="lr-lookup-link">
              🔍查自己有幾多張抽獎劵
            </Link>
          </p>
        </>
      ) : (
        <p className="mt-2 text-[13.5px] leading-relaxed text-txt-3">
          持有抽獎劵嘅客人唔受影響：用店家提供嘅專屬查劵連結（/lucky-tickets/活動編號），照舊查到自己有幾多張劵。
        </p>
      )}
    </div>
  );
}

/* ---------- 公告總頁：全部公開活動一覽（新→舊） ---------- */
function LuckyResultsIndex() {
  // v2026.11.11.2（加強版）：只有總開關明確 enabled===true 先准出公告——
  // status 初次 loading／讀取失敗／舊快取 true 待重查期間，一律當「未確認」：
  // 唔打 publicEvents、**唔渲染任何舊快取嘅活動名**（舊 React Query 快取唔可以再公開）。
  const statusQuery = trpc.luckyDraw.publicAnnouncementStatus.useQuery(undefined, {
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
  const announcementOpen =
    luckyAnnouncementStatusFresh(statusQuery) && luckyAnnouncementGateOpen(statusQuery.data?.enabled);
  const announcementClosed = statusQuery.data?.enabled === false;
  // 舊快取 true 唔算數：背景重查（isRefetching）期間 gate 暫時關——呢段窗口要出中性
  // 「重新確認」態，絕唔好跌入 events=[] 嘅「仲未有抽獎活動」（會誤導客人以為活動消失）。
  const reconfirming =
    !statusQuery.isLoading && !statusQuery.isError && !announcementClosed && !announcementOpen;
  const query = trpc.luckyDraw.publicEvents.useQuery(undefined, {
    enabled: announcementOpen,
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
  const events = announcementOpen ? (query.data ?? []) : [];

  // 關閉時客戶端 SEO：noindex＋清 canonical（首口 HTML 已由 server 保證唔注入公告內容）。
  // hold 住：SeoManager（App root，parent effect 後跑）會喺路由變化時重設 index,follow，
  // 關閉期間一翻轉即刻還原（見 src/lib/luckyAnnouncementVisibility.ts）。
  useEffect(() => {
    if (!announcementClosed) return;
    return holdClosedAnnouncementSeo();
  }, [announcementClosed]);

  return (
    <div className="lr-page">
      <div aria-hidden="true" className="lr-stars">
        {Array.from({ length: 24 }, (_, i) => (
          <span key={i} className={`lr-star lr-star-${i % 6}`} />
        ))}
      </div>
      <section className="mx-auto max-w-3xl px-5 pb-16 pt-14 md:pt-20">
        <p className="lr-enter text-center font-mono text-[11px] uppercase tracking-[0.3em] text-gold" style={{ animationDelay: '0.05s' }}>
          RedCode ✦ Lucky Draw
        </p>
        <h1 className="lr-enter mt-3 text-center font-serif-tc text-4xl font-bold leading-[1.2] text-starlight md:text-[52px]" style={{ animationDelay: '0.15s' }}>
          中獎公告
        </h1>
        <div className="lr-enter lr-card mt-8" style={{ animationDelay: '0.25s' }}>
          <span aria-hidden="true" className="lr-card-shine" />
          {statusQuery.isLoading ? (
            // 總開關狀態未確認：中性載入態，零活動資料（舊快取唔准閃現）
            <p className="lr-state" role="status">
              <Sparkles size={16} aria-hidden="true" className="mr-2 inline-block text-gold" />
              許願星確認緊公告狀態…
            </p>
          ) : statusQuery.isError ? (
            // 狀態讀取失敗：中性錯誤態＋重試，一樣零活動資料
            <div className="lr-state" role="alert">
              <p className="font-serif-tc text-lg font-semibold text-txt-1">載入失敗</p>
              <p className="mt-2 text-[13.5px] text-txt-3">{statusQuery.error.message}</p>
              <button type="button" onClick={() => void statusQuery.refetch()} className="lr-cta lr-cta-gold mx-auto mt-5">
                重試
              </button>
            </div>
          ) : announcementClosed ? (
            <AnnouncementClosedCard />
          ) : reconfirming ? (
            // 舊 status 重查緊（fresh gate 暫時關）：中性重新確認態，零活動資料
            <p className="lr-state" role="status">
              <Sparkles size={16} aria-hidden="true" className="mr-2 inline-block text-gold" />
              許願星重新確認緊公告狀態…
            </p>
          ) : query.isLoading ? (
            <p className="lr-state" role="status">
              <Sparkles size={16} aria-hidden="true" className="mr-2 inline-block text-gold" />
              許願星搬緊活動一覽…
            </p>
          ) : query.isError ? (
            <div className="lr-state" role="alert">
              <p className="font-serif-tc text-lg font-semibold text-txt-1">載入失敗</p>
              <p className="mt-2 text-[13.5px] text-txt-3">{query.error.message}</p>
              <button type="button" onClick={() => void query.refetch()} className="lr-cta lr-cta-gold mx-auto mt-5">
                重試
              </button>
            </div>
          ) : events.length === 0 ? (
            <div className="lr-state" role="status">
              <PartyPopper size={22} aria-hidden="true" className="mx-auto mb-3 text-gold" />
              <p className="font-serif-tc text-lg font-semibold text-txt-1">仲未有抽獎活動</p>
              <p className="mt-2 text-[13.5px] leading-relaxed text-txt-3">
                最新抽獎同直播消息，留意我哋 Facebook 專頁同直播。
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {events.map((ev, i) => {
                const dateLabel = indexDateLabel(ev);
                return (
                  <li key={ev.id} className="lr-enter" style={{ animationDelay: `${0.35 + Math.min(i, 10) * 0.08}s` }}>
                    <Link to={`/lucky-results/${ev.id}`} className="lr-winner lr-event-link">
                      <Trophy size={16} aria-hidden="true" className="shrink-0 text-gold" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-serif-tc text-[16.5px] font-bold text-txt-1" title={ev.name}>
                          {ev.name}
                        </span>
                        <span className="mt-0.5 block text-[12px] text-txt-3">
                          {dateLabel ? `${dateLabel}・` : ''}
                          {ev.winnerCount > 0 ? `${ev.winnerCount} 位幸運兒已誕生 ✦` : '中獎名單即將公佈'}
                        </span>
                      </span>
                      <span aria-hidden="true" className="shrink-0 text-gold">→</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <p className="mt-6 text-center text-[12px] text-txt-3">
          <Link to="/" className="underline underline-offset-4 transition-opacity hover:opacity-75">
            返去 RedCode 首頁
          </Link>
        </p>
      </section>
      <LuckyResultsStyles />
    </div>
  );
}

/* ---------- 單場公告頁 ---------- */
function LuckyResultsEvent({ eventIdRaw }: { eventIdRaw: string }) {
  const eventId = Number(eventIdRaw);
  const validId = Number.isInteger(eventId) && eventId > 0;

  // v2026.11.11.2（加強版）：只有總開關明確 enabled===true 先准打名單 query／渲染——
  // status 初次 loading／讀取失敗／舊快取 true 待重查期間一律當「未確認」，
  // 唔渲染任何舊快取嘅活動名／中獎名單（舊 React Query 快取唔可以再公開）。
  const statusQuery = trpc.luckyDraw.publicAnnouncementStatus.useQuery(undefined, {
    enabled: validId,
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
  const statusFresh = luckyAnnouncementStatusFresh(statusQuery);
  const announcementOpen = validId && statusFresh && luckyAnnouncementGateOpen(statusQuery.data?.enabled);
  const announcementClosed = validId && statusQuery.data?.enabled === false;
  // 舊快取 true 喺背景重查期間 gate 暫時關：出中性「重新確認」態（唔好出白卡／唔好出舊名單）
  const reconfirming =
    validId && !statusQuery.isLoading && !statusQuery.isError && !announcementClosed && !announcementOpen;

  const query = trpc.luckyDraw.publicEventResults.useQuery(
    { eventId: validId ? eventId : 0 },
    {
      enabled: announcementOpen,
      retry: false,
      // 公告開關會喺另一分頁改；唔可以俾 60 秒 fresh cache 令舊名單無限期留喺畫面。
      // 後台切換會即時 remove 同一 SPA 快取；其他已開分頁就喺聚焦或下一次 30 秒重查時收起。
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: true,
      refetchInterval: 30_000,
    },
  );

  // 總開關未確認／關閉時 query 停用，但 data 可能係舊快取——只有 announcementOpen 先准讀佢
  const data = announcementOpen ? (query.data ?? null) : null;
  // v2026.10.26.2 活動日期顯示資料：
  // scheduledLabel＝活動級預定抽獎日（scheduledDrawDate，null＝舊活動未定，如實寫待公佈）；
  // actualDrawDates＝真實 winner 紀錄嘅實際抽出日（luckyDraws.drawDate，去重排序）——同預定日分開標示。
  const scheduledLabel = data?.event.scheduledDrawDate ? fmtDate(data.event.scheduledDrawDate) : null;
  const actualDrawDates = [...new Set((data?.winners ?? []).map((w) => w.drawDate))].sort();
  const notFound =
    query.isError &&
    (query.error.message.includes('唔存在') ||
      query.error.message.includes('已刪除') ||
      query.error.message.includes('未公開'));
  const pageUrl = typeof window !== 'undefined' ? window.location.href : '';

  useEffect(() => {
    const robots = document.querySelector('meta[name="robots"]');
    // v2026.11.11.2：總開關關閉 → 客戶端即刻 noindex＋清 canonical，兼 hold 住唔俾
    // SeoManager（parent effect 後跑）喺路由變化時翻轉返 index,follow。
    if (announcementClosed) {
      return holdClosedAnnouncementSeo();
    }
    if (!validId || notFound) {
      document.title = '中獎公告未公開或唔存在｜RedCode Fashion Design';
      document
        .querySelector('meta[name="description"]')
        ?.setAttribute('content', '呢場中獎公告未公開、已移除或唔存在，請返回中獎公告總頁睇最新公開活動。');
      robots?.setAttribute('content', 'noindex, nofollow');
      setCanonicalPath(null);
      return;
    }
    if (!data) return;
    document.title = `《${data.event.name}》中獎名單｜RedCode Fashion Design`;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute(
        'content',
        `RedCode《${data.event.name}》直播抽獎公告——查閱公開活動資料、預定抽獎日同已公佈嘅真實中獎結果。`,
      );
    robots?.setAttribute('content', 'index, follow');
    setCanonicalPath(`/lucky-results/${data.event.id}`);
  }, [data, eventId, notFound, validId, announcementClosed]);

  return (
    <div className="lr-page">
      {/* 星光閃爍層（純 CSS twinkle；reduced-motion 停） */}
      <div aria-hidden="true" className="lr-stars">
        {Array.from({ length: 24 }, (_, i) => (
          <span key={i} className={`lr-star lr-star-${i % 6}`} />
        ))}
      </div>

      <section className="mx-auto max-w-3xl px-5 pb-16 pt-14 md:pt-20">
        {/* 品牌行 */}
        <p className="lr-enter text-center font-mono text-[11px] uppercase tracking-[0.3em] text-gold" style={{ animationDelay: '0.05s' }}>
          RedCode ✦ Lucky Draw
        </p>
        <p className="script lr-enter mt-3 text-center text-[30px] leading-[1.3] text-pink-soft md:text-[38px]" style={{ animationDelay: '0.12s' }}>
          Lucky stars, real winners ✦
        </p>
        <h1 className="lr-enter mt-3 text-center font-serif-tc text-4xl font-bold leading-[1.2] text-starlight md:text-[52px]" style={{ animationDelay: '0.2s' }}>
          中獎公告
        </h1>

        {/* 主卡：幼金雙框＋掃光＋星光角 */}
        <div className="lr-enter lr-card mt-8" style={{ animationDelay: '0.3s' }}>
          <span aria-hidden="true" className="lr-card-shine" />
          <span aria-hidden="true" className="lr-corner lr-corner-tl" />
          <span aria-hidden="true" className="lr-corner lr-corner-tr" />
          <span aria-hidden="true" className="lr-corner lr-corner-bl" />
          <span aria-hidden="true" className="lr-corner lr-corner-br" />

          {!validId ? (
            <p className="lr-state" role="alert">連結唔啱——請向店家攞正確嘅公告連結。</p>
          ) : statusQuery.isLoading ? (
            // 總開關狀態未確認：中性載入態，零活動名零中獎者（舊快取唔准閃現）
            <p className="lr-state" role="status">
              <Sparkles size={16} aria-hidden="true" className="mr-2 inline-block text-gold" />
              許願星確認緊公告狀態…
            </p>
          ) : statusQuery.isError ? (
            // 狀態讀取失敗：中性錯誤態＋重試，一樣零活動資料
            <div className="lr-state" role="alert">
              <p className="font-serif-tc text-lg font-semibold text-txt-1">載入失敗</p>
              <p className="mt-2 text-[13.5px] text-txt-3">{statusQuery.error.message}</p>
              <button
                type="button"
                onClick={() => void statusQuery.refetch()}
                className="lr-cta lr-cta-gold mx-auto mt-5"
              >
                重試
              </button>
            </div>
          ) : announcementClosed ? (
            // 總開關關閉：唔打名單 query、唔渲染舊快取名單；提供呢場獨立查劵入口
            <AnnouncementClosedCard eventId={eventId} />
          ) : reconfirming ? (
            // 舊 status 重查緊（fresh gate 暫時關）：中性重新確認態，零活動名零中獎者
            <p className="lr-state" role="status">
              <Sparkles size={16} aria-hidden="true" className="mr-2 inline-block text-gold" />
              許願星重新確認緊公告狀態…
            </p>
          ) : query.isLoading ? (
            <p className="lr-state" role="status">
              <Sparkles size={16} aria-hidden="true" className="mr-2 inline-block text-gold" />
              許願星搬緊中獎名單…
            </p>
          ) : query.isError ? (
            notFound ? (
              <div className="lr-state" role="status">
                <Gift size={20} aria-hidden="true" className="mx-auto mb-3 text-txt-3" />
                <p className="font-serif-tc text-lg font-semibold text-txt-1">呢場中獎公告暫時未能顯示</p>
                <p className="mt-2 text-[13.5px] leading-relaxed text-txt-3">
                  公告連結可能未公開、已過期，或活動已移除。最新抽獎同直播消息，留意我哋 Facebook 專頁。
                </p>
              </div>
            ) : (
              <div className="lr-state" role="alert">
                <p className="font-serif-tc text-lg font-semibold text-txt-1">名單載入失敗</p>
                <p className="mt-2 text-[13.5px] text-txt-3">{query.error.message}</p>
                <button
                  type="button"
                  onClick={() => void query.refetch()}
                  className="lr-cta lr-cta-gold mx-auto mt-5"
                >
                  重試
                </button>
              </div>
            )
          ) : data ? (
            <>
              <h2 className="break-words text-center font-serif-tc text-[24px] font-bold leading-[1.35] text-gold-soft md:text-[30px]">
                {data.event.name}
              </h2>
              {data.winners.length === 0 ? (
                <>
                  {/* 未開獎：寫預定抽獎日；舊活動冇日期就如實寫待公佈 */}
                  <p className="mt-3 text-center font-mono text-[13px] text-gold-soft">
                    {scheduledLabel ? `預定抽獎日：${scheduledLabel}` : '抽獎日待公佈'}
                  </p>
                  <div className="lr-state" role="status">
                    <PartyPopper size={22} aria-hidden="true" className="mx-auto mb-3 text-gold" />
                    <p className="font-serif-tc text-lg font-semibold text-txt-1">中獎名單即將公佈</p>
                    <p className="mt-2 text-[13.5px] leading-relaxed text-txt-3">
                      呢場仲未開獎——撳實開播通知，直播即場抽出嚟嘅幸運兒會第一時間喺度公佈。
                    </p>
                    <p className="lr-lookup-cta-wrap">
                      <Link to={`/lucky-tickets/${data.event.id}`} className="lr-lookup-link">
                        🔍查看睇睇自己有幾張抽獎劵
                      </Link>
                    </p>
                  </div>
                </>
              ) : (
                <>
                  {/* 已開獎：實際抽獎日嚟自真實 winner 紀錄；有預定日就分行寫明係「預定」 */}
                  <p className="mt-2 text-center font-mono text-[12.5px] text-txt-3">
                    {scheduledLabel ? `預定抽獎日：${scheduledLabel}・` : ''}
                    實際抽獎日：{actualDrawDates.map(fmtDate).join('、')}
                  </p>
                  <p className="mt-2 text-center text-[12.5px] text-txt-3">
                    以下係直播即場抽出嘅真實結果，共 {data.winners.length} 位幸運兒 ✦
                  </p>
                  <ul className="mt-6 space-y-3">
                    {data.winners.map((w, i) => (
                      <li key={w.id} className="lr-winner lr-enter" style={{ animationDelay: `${0.45 + Math.min(i, 12) * 0.09}s` }}>
                        <span className="lr-rank" aria-hidden="true">{i + 1}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-serif-tc text-[17px] font-bold text-txt-1" title={w.name}>
                            {w.name}
                          </span>
                          <span className="mt-0.5 block truncate text-[12.5px] text-gold-soft" title={w.prizeName}>
                            中獎獎品：{w.prizeName}
                          </span>
                        </span>
                        <span className="shrink-0 text-right font-mono text-[11px] leading-[1.5] text-txt-3">
                          {fmtDate(w.drawDate)}
                          <br />
                          {fmtTimeHkt(w.drawnAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-6 text-center text-[12.5px] leading-relaxed text-txt-3">
                    恭喜晒咁多位幸運兒 🎉 中獎客人我哋會按既定流程通知同安排寄送；
                    想下一場做主角？撳實開播通知，直播見！
                  </p>
                </>
              )}
            </>
          ) : null}
        </div>

        {/* 引流 CTA 區（同查劵頁共用；保持原公告頁行為／文案）。v2026.11.11.2：總開關關閉時唔出引流 CTA，只留返首頁。 */}
        {announcementClosed ? (
          <p className="mt-6 text-center text-[12px] text-txt-3">
            <Link to="/" className="underline underline-offset-4 transition-opacity hover:opacity-75">
              返去 RedCode 首頁
            </Link>
          </p>
        ) : (
          <div className="lr-enter mt-10" style={{ animationDelay: '0.5s' }}>
            <LuckyPublicActions shareUrl={pageUrl} copyLabel="複製公告連結" />
            <p className="mt-4 text-center text-[12px] text-txt-3">
              <Link to="/" className="underline underline-offset-4 transition-opacity hover:opacity-75">
                返去 RedCode 首頁
              </Link>
            </p>
          </div>
        )}
      </section>
      <LuckyResultsStyles />
    </div>
  );
}

/** 兩個視圖共用嘅 scoped 樣式（lr- 前綴，唔會撞首頁 hero-* 嗰套） */
function LuckyResultsStyles() {
  return (
      <style>{`
        .lr-page { position: relative; min-height: 70vh; }
        .lr-enter { opacity: 0; animation: lr-enter 700ms var(--ease-expo, ease-out) both; }
        @keyframes lr-enter {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }

        /* 星光閃爍層：24 粒純 CSS 星，transform scale＋opacity twinkle；6 組錯開 delay */
        .lr-stars { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
        .lr-star {
          position: absolute;
          width: 5px; height: 5px;
          border-radius: 9999px;
          background: radial-gradient(circle, #FFE28F 0%, rgba(245,197,24,0) 70%);
          animation: lr-twinkle 3.4s ease-in-out infinite;
        }
        .lr-star-0 { left: 8%;  top: 12%; animation-delay: 0s; }
        .lr-star-1 { left: 88%; top: 9%;  animation-delay: 0.6s; }
        .lr-star-2 { left: 16%; top: 48%; animation-delay: 1.2s; }
        .lr-star-3 { left: 82%; top: 42%; animation-delay: 1.8s; }
        .lr-star-4 { left: 30%; top: 78%; animation-delay: 2.4s; }
        .lr-star-5 { left: 70%; top: 84%; animation-delay: 3s; }
        .lr-stars .lr-star:nth-child(6n+7)  { left: 44%; top: 7%;  animation-delay: 0.3s; }
        .lr-stars .lr-star:nth-child(6n+8)  { left: 60%; top: 15%; animation-delay: 0.9s; }
        .lr-stars .lr-star:nth-child(6n+9)  { left: 5%;  top: 30%; animation-delay: 1.5s; }
        .lr-stars .lr-star:nth-child(6n+10) { left: 94%; top: 28%; animation-delay: 2.1s; }
        .lr-stars .lr-star:nth-child(6n+11) { left: 12%; top: 66%; animation-delay: 2.7s; }
        .lr-stars .lr-star:nth-child(6n+12) { left: 91%; top: 62%; animation-delay: 3.3s; }
        .lr-stars .lr-star:nth-child(6n+13) { left: 50%; top: 90%; animation-delay: 0.45s; }
        .lr-stars .lr-star:nth-child(6n+14) { left: 37%; top: 22%; animation-delay: 1.05s; }
        .lr-stars .lr-star:nth-child(6n+15) { left: 66%; top: 33%; animation-delay: 1.65s; }
        .lr-stars .lr-star:nth-child(6n+16) { left: 25%; top: 88%; animation-delay: 2.25s; }
        .lr-stars .lr-star:nth-child(6n+17) { left: 76%; top: 70%; animation-delay: 2.85s; }
        .lr-stars .lr-star:nth-child(6n+18) { left: 55%; top: 55%; animation-delay: 3.45s; }
        @keyframes lr-twinkle {
          0%, 100% { transform: scale(0.6); opacity: 0.25; }
          50% { transform: scale(1.5); opacity: 0.95; }
        }

        /* 主卡：深底＋幼金雙框＋玻璃感；掃光 loop 淨 transform */
        .lr-card {
          position: relative;
          overflow: hidden;
          border-radius: 24px;
          border: 1px solid rgba(245,197,24,0.55);
          background: rgba(11,16,38,0.72);
          padding: 40px 24px 34px;
          box-shadow: inset 0 0 0 6px rgba(11,16,38,0.72), inset 0 0 0 7px rgba(212,175,55,0.28), 0 18px 60px rgba(0,0,0,0.45);
        }
        @media (min-width: 640px) { .lr-card { padding: 48px 44px 40px; } }
        .lr-card-shine {
          position: absolute; top: 0; bottom: 0; left: 0; width: 36%;
          pointer-events: none;
          background: linear-gradient(100deg, transparent, rgba(255,226,143,0.10), transparent);
          transform: translateX(-160%) skewX(-14deg);
          animation: lr-card-shine 4.2s ease-in-out infinite;
        }
        @keyframes lr-card-shine {
          0% { transform: translateX(-160%) skewX(-14deg); }
          55%, 100% { transform: translateX(360%) skewX(-14deg); }
        }
        /* 四角金芒 */
        .lr-corner {
          position: absolute; width: 14px; height: 14px; pointer-events: none;
          background: #F5C518;
          clip-path: polygon(50% 0%, 63% 37%, 100% 50%, 63% 63%, 50% 100%, 37% 63%, 0% 50%, 37% 37%);
          animation: lr-twinkle 3s ease-in-out infinite;
        }
        .lr-corner-tl { top: 14px; left: 14px; }
        .lr-corner-tr { top: 14px; right: 14px; animation-delay: 0.75s; }
        .lr-corner-bl { bottom: 14px; left: 14px; animation-delay: 1.5s; }
        .lr-corner-br { bottom: 14px; right: 14px; animation-delay: 2.25s; }

        .lr-state { padding: 28px 8px; text-align: center; color: var(--text-2); font-size: 14px; }

        /* 中獎行：金序號章＋細金邊卡 */
        .lr-winner {
          display: flex; align-items: center; gap: 12px;
          border-radius: 16px;
          border: 1px solid rgba(245,197,24,0.32);
          background: rgba(255,255,255,0.03);
          padding: 12px 14px;
        }
        /* 總頁活動卡（可撳）：hover 輕微升起（淨 transform） */
        .lr-event-link { text-decoration: none; transition: transform 200ms ease-out; }
        .lr-event-link:hover { transform: translateY(-2px); border-color: rgba(245,197,24,0.6); }
        .lr-rank {
          display: inline-flex; align-items: center; justify-content: center;
          width: 34px; height: 34px; flex-shrink: 0;
          border-radius: 9999px;
          background: rgba(245,197,24,0.14);
          border: 1px solid rgba(245,197,24,0.5);
          color: #F5C518;
          font-weight: 800; font-size: 14px;
        }

        /* 未開獎句子正下方嘅同場查劵入口：44px 觸控目標＋暖金實心框 */
        .lr-lookup-cta-wrap { margin-top: 18px; text-align: center; }
        .lr-lookup-link {
          display: inline-flex; align-items: center; justify-content: center;
          min-height: 44px;
          border-radius: 9999px;
          border: 1px solid rgba(245,197,24,0.62);
          background: rgba(245,197,24,0.12);
          color: var(--gold-soft);
          padding: 10px 18px;
          font-size: 13px; font-weight: 700;
          text-decoration: none;
          transition: transform 200ms ease-out, border-color 200ms ease-out;
        }
        .lr-lookup-link:hover { transform: translateY(-1px); border-color: rgba(245,197,24,0.9); }

        @media (prefers-reduced-motion: reduce) {
          .lr-enter { opacity: 1; animation: none; }
          .lr-star, .lr-corner, .lr-card-shine { animation: none; }
          .lr-card-shine { display: none; }
          .lr-lookup-link { transition: none; }
          .lr-lookup-link:hover { transform: none; }
        }
      `}</style>
  );
}
