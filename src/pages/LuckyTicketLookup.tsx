import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import {
  AlertCircle,
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  Gift,
  Repeat2,
  Search,
  Sparkles,
  Ticket,
  Trophy,
} from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { LuckyPublicActions } from '@/components/lucky/LuckyPublicActions';

/**
 * LuckyTicketLookup（2026-11-08）
 * ------------------------------
 * 公開抽獎劵查詢頁：/lucky-tickets/:eventId（noindex）。
 * - publicTicketEvent 只回活動名、預定抽獎日、每人限中次數及公告開關；唔會預載任何參加者名單。
 * - 完整姓名先可以 submit（POST mutation）；唔提供部份名搜尋、wildcard、自動建議，亦唔寫入瀏覽器持久儲存。
 * - winnersPublic=true 先顯示返回該場中獎名單；false 時呢頁冇任何該場公告入口。
 * - 視覺：深色沉浸舞台＋暖金 metadata＋分層 3D 票劵；連續動畫只用 transform/opacity，
 *   prefers-reduced-motion 會全部停晒。
 */

/** Route param 必須係正整數；其他格式直接當壞 link，唔會打 API。 */
export function parseLuckyTicketEventId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const eventId = Number(raw);
  return Number.isSafeInteger(eventId) && eventId > 0 ? eventId : null;
}

/** YYYYMMDD → YYYY-MM-DD；null 如實顯示「待公佈」。 */
export function formatLuckyDrawDate(value: string | null): string {
  if (value == null) return '待公佈';
  if (!/^\d{8}$/.test(value)) return value;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

/** 只 trim 頭尾空白；大小寫正規化由後端 contract 做，前端唔改寫客人姓名。 */
export function normalizeTicketHolderName(value: string): string {
  return value.trim();
}

export default function LuckyTicketLookup() {
  const params = useParams();
  const eventId = parseLuckyTicketEventId(params.eventId);
  const [holderName, setHolderName] = useState('');

  const eventQuery = trpc.luckyDraw.publicTicketEvent.useQuery(
    { eventId: eventId ?? 0 },
    { enabled: eventId != null, retry: false, refetchOnWindowFocus: false },
  );
  const lookupMutation = trpc.luckyDraw.publicLookupEventTicket.useMutation();

  const event = eventQuery.data?.event ?? null;
  const lookupResult = lookupMutation.data ?? null;
  const normalizedName = normalizeTicketHolderName(holderName);
  const canSubmit = eventId != null && normalizedName.length > 0 && !lookupMutation.isPending;
  const pageUrl = typeof window !== 'undefined' ? window.location.href : '';
  const eventNotFound =
    eventQuery.isError &&
    (eventQuery.error.message.includes('唔存在') || eventQuery.error.message.includes('已刪除'));

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSubmit || eventId == null) return;
    lookupMutation.mutate({ eventId, holderName: normalizedName });
  };

  return (
    <div className="lt-page">
      {/* 星光閃爍層（純 transform/opacity；reduced-motion 停） */}
      <div aria-hidden="true" className="lt-stars">
        {Array.from({ length: 14 }, (_, i) => (
          <span key={i} className={`lt-star lt-star-${i % 7}`} />
        ))}
      </div>

      <section className="lt-shell">
        <p className="lt-enter lt-eyebrow" style={{ animationDelay: '0.05s' }}>
          RedCode ✦ Lucky Ticket Lookup
        </p>
        <h1 className="lt-enter lt-title" style={{ animationDelay: '0.15s' }}>
          抽獎劵查詢
        </h1>
        <p className="lt-enter lt-subtitle" style={{ animationDelay: '0.23s' }}>
          輸入報名時嘅完整姓名，即刻知道自己喺呢場活動有幾多張抽獎劵。
        </p>

        <div className="lt-enter lt-stage" style={{ animationDelay: '0.32s' }}>
          {/* 左欄：暖金活動資料＋完整姓名查詢 */}
          <div className="lt-panel">
            <span aria-hidden="true" className="lt-panel-shine" />
            {eventId == null ? (
              <div className="lt-state" role="alert">
                <AlertCircle size={22} aria-hidden="true" className="mx-auto mb-3 text-pink-soft" />
                <p className="lt-state-title">查劵連結唔啱</p>
                <p className="mt-2 text-[13.5px] leading-relaxed text-txt-3">
                  請向店家攞正確嘅查劵連結。
                </p>
              </div>
            ) : eventQuery.isLoading ? (
              <div className="lt-state" role="status">
                <Sparkles size={20} aria-hidden="true" className="mx-auto mb-3 text-gold" />
                <p className="lt-state-title">許願星搬緊活動資料…</p>
              </div>
            ) : eventQuery.isError ? (
              <div className="lt-state" role="alert">
                <Gift size={22} aria-hidden="true" className="mx-auto mb-3 text-txt-3" />
                <p className="lt-state-title">
                  {eventNotFound ? '呢場抽獎活動唔存在或已刪除' : '活動資料載入失敗'}
                </p>
                <p className="mt-2 text-[13.5px] leading-relaxed text-txt-3">
                  {eventNotFound
                    ? '查劵連結可能已過期或活動已移除。'
                    : eventQuery.error.message}
                </p>
                {!eventNotFound && (
                  <button type="button" onClick={() => void eventQuery.refetch()} className="lt-retry">
                    重試
                  </button>
                )}
              </div>
            ) : event ? (
              <>
                <div className="lt-event-head">
                  <span className="lt-event-kicker">EVENT</span>
                  <h2 className="lt-event-name">{event.name}</h2>
                </div>

                <div className="lt-meta-grid" aria-label="活動資料">
                  <div className="lt-meta-card">
                    <CalendarDays size={17} aria-hidden="true" className="text-gold" />
                    <span>
                      <span className="lt-meta-label">預定抽獎日</span>
                      <strong className="lt-meta-value">{formatLuckyDrawDate(event.scheduledDrawDate)}</strong>
                    </span>
                  </div>
                  <div className="lt-meta-card">
                    <Repeat2 size={17} aria-hidden="true" className="text-gold" />
                    <span>
                      <span className="lt-meta-label">每人限中次數</span>
                      <strong className="lt-meta-value">{event.maxWinsPerPerson} 次</strong>
                    </span>
                  </div>
                </div>

                {event.winnersPublic && (
                  <Link to={`/lucky-results/${event.id}`} className="lt-results-link">
                    <Trophy size={15} aria-hidden="true" />
                    返回該場中獎名單
                    <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                )}

                <form className="lt-form" onSubmit={onSubmit}>
                  <label htmlFor="lucky-holder-name" className="lt-label">
                    完整姓名
                  </label>
                  <div className="lt-input-wrap">
                    <Search size={17} aria-hidden="true" className="lt-input-icon" />
                    <input
                      id="lucky-holder-name"
                      value={holderName}
                      onChange={(e) => {
                        setHolderName(e.target.value);
                        if (lookupMutation.data || lookupMutation.isError) lookupMutation.reset();
                      }}
                      className="lt-input"
                      type="text"
                      inputMode="text"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={255}
                      placeholder="同報名時一致嘅完整姓名"
                      aria-describedby="lucky-holder-help"
                    />
                  </div>
                  <p id="lucky-holder-help" className="lt-help">
                    系統只會用完整姓名精確查詢；唔支援部份姓名，亦唔會顯示其他人名單。
                  </p>
                  <button type="submit" disabled={!canSubmit} className="lt-submit">
                    {lookupMutation.isPending ? '查詢中…' : '查看抽獎劵數量'}
                  </button>
                </form>

                <div className="lt-result-region" aria-live="polite" aria-atomic="true">
                  {lookupMutation.isPending ? (
                    <div className="lt-result lt-result-pending" role="status">
                      <Sparkles size={18} aria-hidden="true" />
                      正在核對完整姓名…
                    </div>
                  ) : lookupMutation.isError ? (
                    <div className="lt-result lt-result-error" role="alert">
                      <AlertCircle size={18} aria-hidden="true" />
                      查詢失敗，請稍後再試。
                    </div>
                  ) : lookupResult?.found ? (
                    <div className="lt-result lt-result-found" role="status">
                      <BadgeCheck size={19} aria-hidden="true" />
                      <span>
                        你有 <strong>{lookupResult.ticketCount}</strong> 張抽獎劵
                      </span>
                    </div>
                  ) : lookupResult ? (
                    <div className="lt-result lt-result-missing" role="status">
                      <Search size={18} aria-hidden="true" />
                      搵唔到呢個完整姓名嘅抽獎劵。請確認姓名同報名時完全一致。
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>

          {/* 右欄：分層立體票劵（純 CSS，無改動原有 logo／人物／批准素材） */}
          <TicketConstellation />
        </div>

        <div className="lt-enter lt-actions" style={{ animationDelay: '0.46s' }}>
          <LuckyPublicActions shareUrl={pageUrl} copyLabel="複製查劵連結" />
          <p className="mt-4 text-center text-[12px] text-txt-3">
            <Link to="/" className="underline underline-offset-4 transition-opacity hover:opacity-75">
              返去 RedCode 首頁
            </Link>
          </p>
        </div>
      </section>
      <LuckyTicketLookupStyles />
    </div>
  );
}

/** 三層票劵星座：多軸 continuous ambient drift，全部淨 transform/opacity。 */
function TicketConstellation() {
  return (
    <div className="lt-ticket-scene" aria-hidden="true">
      <div className="lt-orbit-glow" />
      <div className="lt-ticket-orbit">
        <div className="lt-ticket lt-ticket-back">
          <span className="lt-ticket-brand">RedCode</span>
          <span className="lt-ticket-kind">LUCKY TICKET</span>
          <span className="lt-ticket-line" />
          <span className="lt-ticket-serial">STARLIGHT DRAW</span>
        </div>
        <div className="lt-ticket lt-ticket-mid">
          <span className="lt-ticket-brand">RedCode</span>
          <span className="lt-ticket-kind">星願抽獎劵</span>
          <span className="lt-ticket-line" />
          <span className="lt-ticket-serial">ADMIT ONE ✦</span>
        </div>
        <div className="lt-ticket lt-ticket-front">
          <span className="lt-ticket-shine" />
          <span className="lt-ticket-brand">RedCode</span>
          <span className="lt-ticket-kind">幸運入場劵</span>
          <span className="lt-ticket-line" />
          <span className="lt-ticket-serial">CHECK YOUR STARS</span>
          <Ticket size={30} className="lt-ticket-icon" />
        </div>
      </div>
      <span className="lt-orbit-star lt-orbit-star-a" />
      <span className="lt-orbit-star lt-orbit-star-b" />
      <span className="lt-orbit-star lt-orbit-star-c" />
    </div>
  );
}

/** 頁面 scoped 樣式（lt- 前綴；CJK 字體用設計系統 token，無假斜體） */
function LuckyTicketLookupStyles() {
  return (
    <style>{`
      .lt-page {
        position: relative;
        min-height: 80vh;
        overflow: hidden;
        background:
          radial-gradient(circle at 82% 16%, rgba(245,197,24,0.12) 0%, rgba(245,197,24,0) 28%),
          radial-gradient(circle at 10% 76%, rgba(255,0,84,0.13) 0%, rgba(255,0,84,0) 31%),
          linear-gradient(135deg, #07030F 0%, #0A0614 45%, #120C24 100%);
        font-family: var(--font-body);
      }
      .lt-shell {
        position: relative;
        z-index: 1;
        width: 100%;
        max-width: 1120px;
        margin: 0 auto;
        padding: 56px 20px 64px;
      }
      .lt-enter { opacity: 0; animation: lt-enter 700ms var(--ease-expo, ease-out) both; }
      @keyframes lt-enter {
        from { opacity: 0; transform: translateY(18px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .lt-eyebrow {
        text-align: center;
        font-family: var(--font-mono);
        font-size: 11px;
        letter-spacing: 0.3em;
        text-transform: uppercase;
        color: var(--gold);
      }
      .lt-title {
        margin-top: 12px;
        text-align: center;
        font-family: var(--font-serif-tc);
        font-size: clamp(38px, 8vw, 60px);
        font-weight: 800;
        line-height: 1.18;
        color: var(--starlight);
        letter-spacing: 0.02em;
      }
      .lt-subtitle {
        max-width: 680px;
        margin: 12px auto 0;
        text-align: center;
        color: var(--text-2);
        font-size: 15px;
        line-height: 1.8;
      }

      /* 星光層：位置錯開＋各自 delay，淨 scale/opacity */
      .lt-stars { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
      .lt-star {
        position: absolute;
        width: 5px; height: 5px; border-radius: 9999px;
        background: radial-gradient(circle, #FFF7E8 0%, rgba(245,197,24,0.55) 36%, rgba(245,197,24,0) 72%);
        animation: lt-twinkle 3.8s ease-in-out infinite;
      }
      .lt-star-0 { left: 7%; top: 12%; animation-delay: 0s; }
      .lt-star-1 { left: 90%; top: 10%; animation-delay: 0.55s; }
      .lt-star-2 { left: 18%; top: 43%; animation-delay: 1.1s; }
      .lt-star-3 { left: 78%; top: 38%; animation-delay: 1.65s; }
      .lt-star-4 { left: 28%; top: 82%; animation-delay: 2.2s; }
      .lt-star-5 { left: 68%; top: 86%; animation-delay: 2.75s; }
      .lt-star-6 { left: 48%; top: 7%; animation-delay: 3.3s; }
      .lt-stars .lt-star:nth-child(7n+8)  { left: 58%; top: 15%; animation-delay: 0.3s; }
      .lt-stars .lt-star:nth-child(7n+9)  { left: 5%; top: 31%; animation-delay: 0.85s; }
      .lt-stars .lt-star:nth-child(7n+10) { left: 94%; top: 29%; animation-delay: 1.4s; }
      .lt-stars .lt-star:nth-child(7n+11) { left: 12%; top: 66%; animation-delay: 1.95s; }
      .lt-stars .lt-star:nth-child(7n+12) { left: 88%; top: 63%; animation-delay: 2.5s; }
      .lt-stars .lt-star:nth-child(7n+13) { left: 39%; top: 24%; animation-delay: 3.05s; }
      .lt-stars .lt-star:nth-child(7n+14) { left: 71%; top: 73%; animation-delay: 3.6s; }
      @keyframes lt-twinkle {
        0%, 100% { opacity: 0.18; transform: translate3d(0,0,0) scale(0.55); }
        50% { opacity: 0.95; transform: translate3d(2px,-4px,0) scale(1.45); }
      }

      /* 桌面雙欄沉浸舞台；minmax(0,…) 保證 375px 無橫向 overflow */
      .lt-stage {
        display: grid;
        grid-template-columns: minmax(0, 1.04fr) minmax(320px, 0.96fr);
        gap: 28px;
        align-items: stretch;
        margin-top: 36px;
        perspective: 1200px;
      }
      .lt-panel {
        position: relative;
        min-width: 0;
        overflow: hidden;
        border-radius: 28px;
        border: 1px solid rgba(245,197,24,0.5);
        background:
          linear-gradient(145deg, rgba(27,19,54,0.92), rgba(10,6,20,0.86)),
          radial-gradient(circle at 16% 0%, rgba(245,197,24,0.12), rgba(245,197,24,0) 42%);
        box-shadow:
          inset 0 0 0 1px rgba(255,247,232,0.05),
          0 24px 70px rgba(0,0,0,0.48);
        padding: clamp(24px, 4vw, 38px);
        transform: translateZ(0);
      }
      .lt-panel-shine {
        position: absolute;
        top: -15%; bottom: -15%; left: 0; width: 32%;
        pointer-events: none;
        background: linear-gradient(100deg, transparent, rgba(255,226,143,0.09), transparent);
        opacity: 0;
        transform: translateX(-170%) skewX(-14deg);
        animation: lt-panel-shine 5.4s ease-in-out infinite;
      }
      @keyframes lt-panel-shine {
        0% { opacity: 0; transform: translateX(-170%) skewX(-14deg); }
        18% { opacity: 1; }
        48%, 100% { opacity: 0; transform: translateX(390%) skewX(-14deg); }
      }
      .lt-event-head { position: relative; z-index: 1; }
      .lt-event-kicker {
        display: inline-flex;
        border: 1px solid rgba(245,197,24,0.45);
        border-radius: 9999px;
        padding: 4px 10px;
        color: var(--gold);
        font-family: var(--font-mono);
        font-size: 10px;
        letter-spacing: 0.22em;
      }
      .lt-event-name {
        margin-top: 12px;
        overflow-wrap: anywhere;
        font-family: var(--font-serif-tc);
        font-size: clamp(25px, 4vw, 36px);
        font-weight: 800;
        line-height: 1.35;
        color: var(--gold-soft);
      }
      .lt-meta-grid {
        position: relative;
        z-index: 1;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        margin-top: 22px;
      }
      .lt-meta-card {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
        border-radius: 18px;
        border: 1px solid rgba(245,197,24,0.34);
        background: rgba(245,197,24,0.08);
        padding: 13px 14px;
      }
      .lt-meta-label {
        display: block;
        color: var(--text-3);
        font-size: 11px;
        line-height: 1.3;
      }
      .lt-meta-value {
        display: block;
        margin-top: 2px;
        color: var(--starlight);
        font-family: var(--font-serif-tc);
        font-size: 16px;
        line-height: 1.35;
      }
      .lt-results-link {
        position: relative;
        z-index: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        min-height: 44px;
        margin-top: 18px;
        border-radius: 9999px;
        border: 1px solid rgba(245,197,24,0.55);
        background: rgba(10,6,20,0.72);
        color: var(--gold-soft);
        padding: 10px 16px;
        font-size: 13px;
        font-weight: 700;
        text-decoration: none;
        transition: transform 200ms ease-out, border-color 200ms ease-out;
      }
      .lt-results-link:hover { transform: translateY(-1px); border-color: rgba(245,197,24,0.9); }

      .lt-form { position: relative; z-index: 1; margin-top: 26px; }
      .lt-label {
        display: block;
        color: var(--starlight);
        font-size: 14px;
        font-weight: 800;
      }
      .lt-input-wrap { position: relative; margin-top: 8px; }
      .lt-input-icon {
        position: absolute;
        left: 15px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--gold);
        pointer-events: none;
      }
      .lt-input {
        width: 100%;
        min-height: 52px;
        border: 1px solid var(--space-line);
        border-radius: 16px;
        background: rgba(7,3,15,0.72);
        color: var(--text-1);
        padding: 12px 14px 12px 44px;
        font-family: var(--font-body);
        font-size: 16px;
        outline: none;
        transition: border-color 180ms ease-out, transform 180ms ease-out;
      }
      .lt-input::placeholder { color: var(--text-disabled); }
      .lt-input:focus { border-color: var(--gold); }
      .lt-help {
        margin-top: 8px;
        color: var(--text-3);
        font-size: 12.5px;
        line-height: 1.65;
      }
      .lt-submit, .lt-retry {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 48px;
        border: 0;
        border-radius: 9999px;
        background: var(--gold);
        color: var(--space-1);
        padding: 12px 24px;
        font-size: 14px;
        font-weight: 900;
        letter-spacing: 0.04em;
        cursor: pointer;
        transition: transform 180ms ease-out, opacity 180ms ease-out;
      }
      .lt-submit { width: 100%; margin-top: 14px; }
      .lt-retry { margin-top: 18px; }
      .lt-submit:hover:not(:disabled), .lt-retry:hover { transform: translateY(-1px); }
      .lt-submit:disabled { cursor: not-allowed; opacity: 0.48; }
      .lt-result-region { min-height: 58px; margin-top: 16px; }
      .lt-result {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 9px;
        min-height: 52px;
        border-radius: 18px;
        padding: 12px 14px;
        text-align: center;
        font-size: 14px;
        font-weight: 700;
      }
      .lt-result strong {
        color: var(--starlight);
        font-family: var(--font-serif-tc);
        font-size: 26px;
        line-height: 1;
      }
      .lt-result-pending { border: 1px solid rgba(245,197,24,0.32); background: rgba(245,197,24,0.08); color: var(--gold-soft); }
      .lt-result-error { border: 1px solid rgba(255,0,84,0.38); background: rgba(255,0,84,0.10); color: var(--pink-tint); }
      .lt-result-found { border: 1px solid rgba(94,224,160,0.42); background: rgba(94,224,160,0.10); color: var(--success); }
      .lt-result-missing { border: 1px solid rgba(201,166,255,0.24); background: rgba(201,166,255,0.08); color: var(--text-2); }
      .lt-state { position: relative; z-index: 1; padding: 46px 4px; text-align: center; color: var(--text-2); }
      .lt-state-title { font-family: var(--font-serif-tc); font-size: 20px; font-weight: 800; color: var(--text-1); }

      /* 右欄立體票劵舞台 */
      .lt-ticket-scene {
        position: relative;
        min-width: 0;
        min-height: 520px;
        overflow: hidden;
        border-radius: 30px;
        border: 1px solid rgba(201,166,255,0.16);
        background:
          radial-gradient(circle at 50% 48%, rgba(245,197,24,0.14) 0%, rgba(245,197,24,0.05) 34%, rgba(245,197,24,0) 62%),
          linear-gradient(160deg, rgba(18,12,36,0.86), rgba(7,3,15,0.94));
        box-shadow: inset 0 0 60px rgba(143,0,255,0.10), 0 24px 70px rgba(0,0,0,0.38);
        perspective: 1100px;
      }
      .lt-orbit-glow {
        position: absolute;
        left: 50%; top: 50%;
        width: 58%; aspect-ratio: 1;
        border-radius: 9999px;
        background: radial-gradient(circle, rgba(245,197,24,0.18), rgba(245,197,24,0));
        opacity: 0.72;
        transform: translate(-50%, -50%) scale(0.9);
        animation: lt-glow-pulse 6.4s ease-in-out infinite;
      }
      @keyframes lt-glow-pulse {
        0%, 100% { opacity: 0.42; transform: translate(-50%, -50%) scale(0.82); }
        50% { opacity: 0.82; transform: translate(-50%, -50%) scale(1.08); }
      }
      .lt-ticket-orbit {
        position: absolute;
        inset: 0;
        transform-style: preserve-3d;
        animation: lt-orbit-drift 10s ease-in-out infinite;
        will-change: transform;
      }
      @keyframes lt-orbit-drift {
        0%, 100% { transform: translate3d(0,0,0) rotateX(52deg) rotateY(-8deg) rotateZ(-5deg); }
        33% { transform: translate3d(9px,-14px,0) rotateX(57deg) rotateY(7deg) rotateZ(-2deg); }
        66% { transform: translate3d(-8px,10px,0) rotateX(48deg) rotateY(-13deg) rotateZ(-8deg); }
      }
      .lt-ticket {
        position: absolute;
        left: 50%; top: 50%;
        width: min(340px, 82vw);
        min-height: 178px;
        border-radius: 24px;
        border: 1px solid rgba(245,197,24,0.58);
        background:
          radial-gradient(circle at 8% 50%, #07030F 0 13px, transparent 14px),
          radial-gradient(circle at 92% 50%, #07030F 0 13px, transparent 14px),
          linear-gradient(135deg, rgba(255,247,232,0.12), rgba(245,197,24,0.08)),
          #120C24;
        box-shadow: 0 24px 44px rgba(0,0,0,0.42), inset 0 0 0 1px rgba(255,247,232,0.08);
        padding: 24px 28px;
        transform-style: preserve-3d;
        will-change: transform, opacity;
      }
      .lt-ticket-back {
        opacity: 0.46;
        animation: lt-ticket-back 8.8s ease-in-out infinite;
      }
      .lt-ticket-mid {
        opacity: 0.72;
        animation: lt-ticket-mid 7.4s ease-in-out infinite;
      }
      .lt-ticket-front {
        overflow: hidden;
        opacity: 0.98;
        animation: lt-ticket-front 6.6s ease-in-out infinite;
      }
      @keyframes lt-ticket-back {
        0%, 100% { transform: translate3d(calc(-50% - 46px), calc(-50% - 50px), -110px) rotateZ(-11deg) rotateY(-13deg); }
        50% { transform: translate3d(calc(-50% - 34px), calc(-50% - 62px), -96px) rotateZ(-8deg) rotateY(-6deg); }
      }
      @keyframes lt-ticket-mid {
        0%, 100% { transform: translate3d(calc(-50% + 34px), calc(-50% - 12px), -35px) rotateZ(8deg) rotateY(10deg); }
        50% { transform: translate3d(calc(-50% + 24px), calc(-50% - 24px), -20px) rotateZ(11deg) rotateY(4deg); }
      }
      @keyframes lt-ticket-front {
        0%, 100% { transform: translate3d(-50%, calc(-50% + 54px), 85px) rotateZ(-3deg) rotateX(3deg); }
        50% { transform: translate3d(-50%, calc(-50% + 38px), 104px) rotateZ(1deg) rotateX(-4deg); }
      }
      .lt-ticket-brand {
        display: block;
        color: var(--gold);
        font-family: var(--font-mono);
        font-size: 11px;
        letter-spacing: 0.28em;
        text-transform: uppercase;
      }
      .lt-ticket-kind {
        display: block;
        margin-top: 14px;
        color: var(--starlight);
        font-family: var(--font-serif-tc);
        font-size: 27px;
        font-weight: 900;
        line-height: 1.2;
      }
      .lt-ticket-line {
        display: block;
        height: 1px;
        margin-top: 16px;
        background: linear-gradient(90deg, rgba(245,197,24,0.75), rgba(245,197,24,0.08));
      }
      .lt-ticket-serial {
        display: block;
        margin-top: 11px;
        color: var(--text-3);
        font-family: var(--font-mono);
        font-size: 10px;
        letter-spacing: 0.18em;
      }
      .lt-ticket-icon { position: absolute; right: 24px; bottom: 20px; color: rgba(245,197,24,0.55); }
      .lt-ticket-shine {
        position: absolute;
        top: -20%; bottom: -20%; left: 0;
        width: 34%;
        background: linear-gradient(100deg, transparent, rgba(255,247,232,0.18), transparent);
        opacity: 0;
        transform: translateX(-180%) skewX(-16deg);
        animation: lt-ticket-shine 4.6s ease-in-out infinite;
      }
      @keyframes lt-ticket-shine {
        0% { opacity: 0; transform: translateX(-180%) skewX(-16deg); }
        24% { opacity: 1; }
        56%, 100% { opacity: 0; transform: translateX(390%) skewX(-16deg); }
      }
      .lt-orbit-star {
        position: absolute;
        width: 9px; height: 9px;
        background: var(--gold-soft);
        clip-path: polygon(50% 0%, 63% 37%, 100% 50%, 63% 63%, 50% 100%, 37% 63%, 0% 50%, 37% 37%);
        animation: lt-orbit-star 4.2s ease-in-out infinite;
      }
      .lt-orbit-star-a { left: 18%; top: 18%; }
      .lt-orbit-star-b { right: 16%; top: 31%; animation-delay: 1.4s; }
      .lt-orbit-star-c { left: 23%; bottom: 18%; animation-delay: 2.8s; }
      @keyframes lt-orbit-star {
        0%, 100% { opacity: 0.2; transform: translate3d(0,0,0) rotate(0deg) scale(0.65); }
        50% { opacity: 0.95; transform: translate3d(8px,-10px,0) rotate(25deg) scale(1.3); }
      }
      .lt-actions { margin-top: 40px; }

      /* 手機（包括 375px）單欄：票劵喺表單下方，所有內容 min-width:0 */
      @media (max-width: 820px) {
        .lt-shell { padding: 44px 16px 54px; }
        .lt-stage { grid-template-columns: minmax(0, 1fr); gap: 18px; margin-top: 28px; }
        .lt-meta-grid { grid-template-columns: minmax(0, 1fr); }
        .lt-ticket-scene { min-height: 330px; }
        .lt-ticket { width: min(310px, 82vw); min-height: 158px; padding: 20px 22px; }
        .lt-ticket-kind { font-size: 23px; }
      }
      @media (max-width: 420px) {
        .lt-stage { perspective: 900px; }
        .lt-panel { border-radius: 24px; }
        .lt-results-link { width: 100%; }
      }

      @media (prefers-reduced-motion: reduce) {
        .lt-enter { opacity: 1; animation: none; transform: none; }
        .lt-star,
        .lt-panel-shine,
        .lt-orbit-glow,
        .lt-ticket-orbit,
        .lt-ticket,
        .lt-ticket-shine,
        .lt-orbit-star { animation: none; }
        .lt-panel-shine, .lt-ticket-shine { display: none; }
        .lt-results-link, .lt-input, .lt-submit, .lt-retry { transition: none; }
        .lt-results-link:hover, .lt-submit:hover:not(:disabled), .lt-retry:hover { transform: none; }
        .lt-ticket-back { transform: translate3d(calc(-50% - 34px), calc(-50% - 42px), -80px) rotateZ(-9deg); }
        .lt-ticket-mid { transform: translate3d(calc(-50% + 28px), calc(-50% - 8px), -25px) rotateZ(8deg); }
        .lt-ticket-front { transform: translate3d(-50%, calc(-50% + 42px), 70px) rotateZ(-2deg); }
      }
    `}</style>
  );
}
