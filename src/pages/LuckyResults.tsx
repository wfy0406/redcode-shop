import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { Gift, PartyPopper, Sparkles, Trophy } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { LuckyPublicActions } from '@/components/lucky/LuckyPublicActions';
import { setCanonicalPath } from '@/lib/seo';

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

/* ---------- 公告總頁：全部公開活動一覽（新→舊） ---------- */
function LuckyResultsIndex() {
  const query = trpc.luckyDraw.publicEvents.useQuery(undefined, {
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
  const events = query.data ?? [];
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
          {query.isLoading ? (
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

  const query = trpc.luckyDraw.publicEventResults.useQuery(
    { eventId: validId ? eventId : 0 },
    {
      enabled: validId,
      retry: false,
      // 公告開關會喺另一分頁改；唔可以俾 60 秒 fresh cache 令舊名單無限期留喺畫面。
      // 後台切換會即時 remove 同一 SPA 快取；其他已開分頁就喺聚焦或下一次 30 秒重查時收起。
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: true,
      refetchInterval: 30_000,
    },
  );

  const data = query.data ?? null;
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
  }, [data, eventId, notFound, validId]);

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

        {/* 引流 CTA 區（同查劵頁共用；保持原公告頁行為／文案） */}
        <div className="lr-enter mt-10" style={{ animationDelay: '0.5s' }}>
          <LuckyPublicActions shareUrl={pageUrl} copyLabel="複製公告連結" />
          <p className="mt-4 text-center text-[12px] text-txt-3">
            <Link to="/" className="underline underline-offset-4 transition-opacity hover:opacity-75">
              返去 RedCode 首頁
            </Link>
          </p>
        </div>
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
