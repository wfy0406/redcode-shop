import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useParams, useNavigate } from 'react-router';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';

/**
 * 訂單單據 /#/receipt/:orderId —— 2026-09-29 全網單據統一（Glo 指示）：
 * 換上「訂單確認書」同款英倫紙本設計（PaymentHeroCard 設計語言：米白紙紋、
 * hairline 雙金線框、圓形郵戳、CSS 火漆印、dotted leader 明細、會計式雙線總計），
 * 並加返 Red Code logo（確認書冇 logo，單據要有）。
 *
 * 私隱（Glo 指示）：聯絡電話淨係顯示頭 4 位（其餘 ****）；
 * 取貨方式淨係顯示方法（順豐站自取／順豐智能櫃自取／送貨上門），
 * 唔顯示詳細取貨點同送貨地址。
 *
 * v2.1.0（VIP+免運，2026-09-29；Glo：全網所有單據都要睇到折扣同會員級別）：
 * 訂單資料加「會員級別」（銀/金先顯示）＋「運費」（免運 ✓／順豐到付連地區註記）；
 * 總計區 VIP 折扣行排優惠碼折扣行上面（落單次序先 VIP 後 coupon）；
 * remark（澳門單／VIP金會員全年免運等系統備註）喺備註位顯示。
 * 新行全部喺 .rcr-sheet 入面，列印／下載圖片自動入鏡。
 *
 * 下載：「下載圖片」html2canvas 出 PNG（dynamic import，唔塞首屏）；
 * 「列印／儲存 PDF」用 visibility 技巧淨係印 .rcr-sheet。
 * 資料流唔變：trpc.orders.receipt.useQuery；server 把關會員只攞到自己嘅單。
 * F7 退款狀態照舊融入（取消＋退款單成張灰階）。
 */

/* ---------- 設計常數（同確認書統一口徑） ---------- */
const PAPER = '#fcfcf8';
const PAPER_LIGHT = '#fffefb';
const INK = '#2a160d';
const INK_SOFT = 'rgba(42, 22, 13, 0.62)';
const INK_FAINT = 'rgba(42, 22, 13, 0.42)';
const SEAL_RED = '#9C1B32';
const GOLD_LINE = '#ab8c52';
const GOLD_FAINT = 'rgba(171, 140, 82, 0.45)';

const SERIF = `'Cormorant Garamond', 'Noto Serif TC', serif`;
const MONO = `'DM Mono', ui-monospace, 'SFMono-Regular', monospace`;

const MONTHS_EN = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** 全網統一手續費免責聲明（F7 §0 逐字，唔准改） */
const ONLINE_PAYMENT_FEE_NOTE =
  '以信用卡或電子錢包付款，支付平台將按所選支付方式收取手續費，最終金額以支付頁顯示為準';

const HKT_OFFSET_MS = 8 * 60 * 60 * 1000;

const fmtMoney = (n: number) => `HK$${n.toLocaleString('en-HK')}`;

/** HKT 日期件：中文長日期＋英文報頭日期＋郵戳用日/月/年 */
function hkDateParts(d: Date | string | null | undefined) {
  const safe0 = d ? new Date(d) : null;
  if (!safe0 || Number.isNaN(safe0.getTime())) return null;
  const t = new Date(safe0.getTime() + HKT_OFFSET_MS);
  const pad = (x: number) => String(x).padStart(2, '0');
  return {
    zh: `${t.getUTCFullYear()} 年 ${t.getUTCMonth() + 1} 月 ${t.getUTCDate()} 日`,
    zhTime: `${t.getUTCFullYear()}年${t.getUTCMonth() + 1}月${t.getUTCDate()}日 ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
    en: `${pad(t.getUTCDate())} ${MONTHS_EN[t.getUTCMonth()]} ${t.getUTCFullYear()}`,
    day: pad(t.getUTCDate()),
    monthEn: MONTHS_EN[t.getUTCMonth()],
    year: String(t.getUTCFullYear()),
  };
}

/** 私隱：電話淨係顯示頭 4 位（Glo 指示 2026-09-29） */
function maskPhone(phone: string | null | undefined): string {
  const p = (phone ?? '').trim();
  if (!p) return '—';
  return p.length > 4 ? `${p.slice(0, 4)}****` : p;
}

const STATUS_TEXT: Record<string, string> = {
  pending_payment: '待付款',
  payment_review: '對數中',
  approved: '已確認',
  rejected: '待重傳',
  shipped: '已寄出', // v2.4.0（Wave 2）：出貨同步終態統一口徑
  completed: '已完成',
  cancelled: '已取消',
};

/** 付款渠道：manual＝手動過數；airwallex＝網上付款 */
const CHANNEL_TEXT: Record<string, string> = {
  manual: '手動過數',
  airwallex: 'Airwallex 網上付款',
};

// ---------- 頁面級字體 + 列印規則（跟確認書同一套 serif/mono）----------
const PAGE_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Noto+Serif+TC:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');

@keyframes rcrRise {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}
.rcr-sheet { animation: rcrRise 640ms cubic-bezier(0.22, 0.61, 0.36, 1) both; }
.rcr-sheet.rcr-void { filter: grayscale(1); opacity: 0.78; }

@keyframes rcrBreathe { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
.rcr-loading {
  max-width: 560px; margin: 18vh auto 0; text-align: center;
  letter-spacing: 0.3em; text-indent: 0.3em; font-size: 13px;
  animation: rcrBreathe 1.8s ease-in-out infinite; will-change: opacity;
}

.rcr-tool-row { max-width: 680px; margin: 0 auto 18px; display: flex; gap: 10px; }
.rcr-tool-btn {
  flex: 1; border: 1px solid ${GOLD_LINE}; border-radius: 0; background: transparent;
  color: ${INK}; font-family: ${SERIF}; font-size: 13px; font-weight: 600;
  letter-spacing: 0.22em; text-indent: 0.22em; padding: 13px 10px; cursor: pointer;
  transition: opacity 200ms ease, transform 200ms ease, background 200ms ease;
}
.rcr-tool-btn:hover { background: rgba(171, 140, 82, 0.08); }
.rcr-tool-btn:active { transform: translateY(1px); }
.rcr-tool-btn:disabled { opacity: 0.55; cursor: wait; }

/* 列印規則：淨係印張單據，網站其他嘢全部隱藏 */
@media print {
  body * { visibility: hidden; }
  .rcr-sheet, .rcr-sheet * { visibility: visible; }
  .rcr-sheet {
    position: absolute; inset: 0; width: 100%; max-width: none;
    box-shadow: none !important; filter: none !important; opacity: 1 !important; animation: none !important;
  }
}
`;

/* ---------- 圓形郵戳（純 SVG，同確認書同款） ---------- */
function Postmark({ day, monthEn, year }: { day: string; monthEn: string; year: string }) {
  const ink = 'rgba(156, 27, 50, 0.58)';
  return (
    <svg
      viewBox="0 0 110 110"
      width="96"
      height="96"
      aria-hidden="true"
      style={{ transform: 'rotate(-14deg)', display: 'block' }}
    >
      <defs>
        <path id="rcr-postmark-arc" d="M55,55 m-38,0 a38,38 0 1,1 76,0 a38,38 0 1,1 -76,0" />
      </defs>
      <circle cx="55" cy="55" r="52" fill="none" stroke={ink} strokeWidth="1.6" />
      <circle cx="55" cy="55" r="49" fill="none" stroke={ink} strokeWidth="0.7" />
      <circle cx="55" cy="55" r="27" fill="none" stroke={ink} strokeWidth="0.9" />
      <text fill={ink} fontSize="9.2" letterSpacing="2.6" style={{ fontFamily: MONO, fontWeight: 500 }}>
        <textPath href="#rcr-postmark-arc" startOffset="2%">
          RED CODE · HONG KONG · BOUTIQUE ·
        </textPath>
      </text>
      <text x="55" y="52" textAnchor="middle" fill={ink} fontSize="12" style={{ fontFamily: MONO, fontWeight: 500 }}>
        {day} {monthEn}
      </text>
      <text x="55" y="66" textAnchor="middle" fill={ink} fontSize="10" style={{ fontFamily: MONO }}>
        {year}
      </text>
      <path d="M4 78 q6 -5 12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0" fill="none" stroke={ink} strokeWidth="1.4" opacity="0.75" />
      <path d="M8 86 q6 -5 12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0" fill="none" stroke={ink} strokeWidth="1.4" opacity="0.6" />
    </svg>
  );
}

/* ---------- 火漆印（純 CSS 徑向漸層 + serif 花押字，同確認書同款） ---------- */
function WaxSeal() {
  return (
    <div
      aria-hidden="true"
      style={{
        width: 74,
        height: 74,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '48% 52% 51% 49% / 52% 47% 53% 48%',
        background: `radial-gradient(circle at 36% 30%, #C23A54 0%, ${SEAL_RED} 46%, #7A1227 78%, #5F0D1F 100%)`,
        boxShadow:
          'inset 0 0 0 2px rgba(255, 232, 214, 0.28), inset 0 0 0 5px rgba(122, 18, 39, 0.85), inset 0 -8px 14px rgba(70, 6, 18, 0.55), inset 0 6px 10px rgba(255, 190, 170, 0.25), 0 4px 10px rgba(68, 57, 44, 0.35)',
      }}
    >
      <span
        style={{
          fontFamily: SERIF,
          fontWeight: 600,
          fontSize: 26,
          letterSpacing: '0.08em',
          color: '#F6E3CE',
          textShadow: '0 -1px 1px rgba(70, 6, 18, 0.8), 0 1px 1px rgba(255, 200, 180, 0.35)',
          transform: 'translateY(1px)',
        }}
      >
        RC
      </span>
    </div>
  );
}

/* ---------- hairline 小標（small caps + 兩側規線） ---------- */
function RuleLabel({ children }: { children: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }} aria-hidden="true">
      <span style={{ flex: 1, height: 1, background: GOLD_FAINT }} />
      <span
        style={{
          fontFamily: MONO,
          fontSize: 10,
          letterSpacing: '0.32em',
          color: INK_SOFT,
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
      >
        {children}
      </span>
      <span style={{ flex: 1, height: 1, background: GOLD_FAINT }} />
    </div>
  );
}

/** 資料行（mono label 左、serif 粗體值右對齊）；value 可以係節點（免運金漆字等上色用） */
function MetaRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 }}>
      <span style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '0.08em', color: INK_SOFT, whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <span style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 15, color: INK, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

export default function Receipt() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const id = Number(orderId);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // 後台「單據」係新分頁開——分頁冇瀏覽歷史，navigate(-1) 會冇反應；
  // 冇歷史就按身份返去所屬頁（員工 → 後台，會員 → 會員中心）
  const goBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate(user?.role === 'staff' || user?.role === 'admin' ? '/admin' : '/account');
    }
  };
  const q = trpc.orders.receipt.useQuery(
    { orderId: id },
    { enabled: Number.isInteger(id) && id > 0, retry: false, refetchOnWindowFocus: false },
  );

  /** 下載圖片（PNG）：html2canvas 截 .rcr-sheet；按鈕喺卡外唔會入鏡 */
  const handleDownloadPng = async (orderNo: string) => {
    if (downloading) return;
    const el = sheetRef.current;
    if (!el) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const { default: html2canvas } = await import('html2canvas');
      const canvas = await html2canvas(el, {
        scale: 2,
        backgroundColor: PAPER,
        useCORS: true,
        logging: false,
      });
      const link = document.createElement('a');
      link.download = `redcode-單據-${orderNo}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (err) {
      console.error('[Receipt] PNG 下載失敗', err);
      setDownloadError('圖片下載失敗，請稍後再試。');
    } finally {
      setDownloading(false);
    }
  };

  // ---------- 載入中（呼吸 opacity，唔用 spinner）----------
  if (q.isLoading) {
    return (
      <div style={{ background: PAPER, minHeight: '60vh', color: INK_SOFT, fontFamily: SERIF }}>
        <style>{PAGE_CSS}</style>
        <div className="rcr-loading">
          正在載入單據
          <hr style={{ margin: '18px auto 0', width: 56, border: 0, borderTop: `1px solid ${GOLD_LINE}` }} />
        </div>
      </div>
    );
  }

  // ---------- 錯誤態 ----------
  if (q.isError || !q.data) {
    return (
      <div style={{ background: PAPER, minHeight: '100vh', padding: '28px 14px 56px', boxSizing: 'border-box' }}>
        <style>{PAGE_CSS}</style>
        <div className="rcr-tool-row">
          <button type="button" className="rcr-tool-btn" onClick={goBack}>
            返回
          </button>
        </div>
        <div
          className="rcr-sheet"
          style={{
            maxWidth: 560,
            margin: '0 auto',
            background: PAPER_LIGHT,
            border: `1px solid ${GOLD_FAINT}`,
            boxShadow: '0 28px 64px -36px rgba(42, 22, 13, 0.28)',
            padding: '44px 26px 36px',
            textAlign: 'center',
            color: INK,
            fontFamily: SERIF,
          }}
        >
          <img src="/logo.png" alt="Red Code" style={{ height: 46, width: 'auto', display: 'inline-block' }} />
          <p style={{ margin: '32px 0 0', fontSize: 15, letterSpacing: '0.2em', lineHeight: 2.1 }}>
            開唔到單據
            <br />
            <span style={{ fontSize: 11.5, color: INK_FAINT, letterSpacing: '0.1em' }}>
              {q.error?.message ?? '訂單不存在'}
            </span>
          </p>
          <p style={{ margin: '32px 0 0', fontSize: 12, letterSpacing: '0.16em' }}>如有查詢，請聯絡 Red Code</p>
        </div>
      </div>
    );
  }

  // ---------- 正常單據 ----------
  const order = q.data;
  const subtotal = order.items.reduce((s, i) => s + i.price * i.quantity, 0);
  const date = hkDateParts(order.createdAt);
  const paidDate = hkDateParts(order.paidAt);

  // 私隱（Glo 指示）：取貨方式淨係顯示方法，詳細取貨點／送貨地址唔上單
  const deliveryText =
    order.deliveryMethod === 'sf_station'
      ? '順豐站自取'
      : order.deliveryMethod === 'sf_locker'
        ? '順豐智能櫃自取'
        : '送貨上門';

  // v2.1.0：VIP 級別（銀/金先上單；普通會員唔顯示，保持版面簡潔）
  const vipTierText =
    order.vipTierAtPurchase === 'GOLD'
      ? 'VIP 金會員'
      : order.vipTierAtPurchase === 'SILVER'
        ? 'VIP 銀會員'
        : null;

  // v2.1.0：運費——免運 ✓（金漆字）；非免運按地區註記；舊單（region 係 null）唔加呢行
  const shippingText = order.shippingFree
    ? 'free'
    : order.region === 'MO'
      ? '順豐到付（澳門單・不包郵）'
      : order.region === 'OVERSEAS'
        ? '順豐到付（國外單・不包郵）'
        : order.region === 'HK'
          ? '順豐到付'
          : null;

  // v2.1.0：VIP 折扣（DB 存整數仙 → 顯示港元）
  const vipDiscount = Math.round((order.vipDiscountCents ?? 0) / 100);

  // F7 退款狀態：取消單成張灰階；refunded 顯示退款時間＋原路退回說明
  const isCancelled = order.status === 'cancelled';
  const isRefunded = isCancelled && order.refundStatus === 'refunded';
  const isManualRefund = isCancelled && order.refundStatus === 'manual';
  const refundedDate = hkDateParts(order.refundedAt);
  const statusText = isRefunded ? '已取消 · 已退款' : (STATUS_TEXT[order.status] ?? order.status);

  return (
    <div
      style={{
        background: PAPER,
        minHeight: '100vh',
        padding: '28px 14px 56px',
        boxSizing: 'border-box',
        color: INK,
        fontFamily: SERIF,
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      <style>{PAGE_CSS}</style>

      {/* 操作列（列印／下載時唔入鏡） */}
      <div className="rcr-tool-row">
        <button type="button" className="rcr-tool-btn" onClick={goBack}>
          返回
        </button>
        <button
          type="button"
          className="rcr-tool-btn"
          disabled={downloading}
          onClick={() => void handleDownloadPng(order.orderNo)}
        >
          {downloading ? '準備緊圖片…' : '下載圖片'}
        </button>
        <button type="button" className="rcr-tool-btn" onClick={() => window.print()}>
          列印／儲存 PDF
        </button>
      </div>
      {downloadError && (
        <p style={{ maxWidth: 680, margin: '0 auto 14px', textAlign: 'center', fontSize: 12, color: '#8c3b2e' }}>
          {downloadError}
        </p>
      )}

      {/* ===== 單據紙（下載圖片／列印就係呢張） ===== */}
      <div
        ref={sheetRef}
        className={`rcr-sheet${isCancelled ? ' rcr-void' : ''}`}
        style={{
          position: 'relative',
          maxWidth: 680,
          margin: '0 auto',
          backgroundColor: PAPER,
          backgroundImage: `
            repeating-linear-gradient(45deg, rgba(171, 140, 82, 0.045) 0px, rgba(171, 140, 82, 0.045) 1px, transparent 1px, transparent 9px),
            radial-gradient(ellipse 120% 90% at 50% 0%, ${PAPER_LIGHT} 0%, transparent 60%),
            radial-gradient(ellipse 140% 120% at 50% 50%, transparent 62%, rgba(171, 140, 82, 0.16) 100%)
          `,
          border: `1px solid ${GOLD_LINE}`,
          boxShadow:
            '0 1px 0 rgba(255,255,255,0.6) inset, 0 18px 50px rgba(7, 3, 15, 0.28), 0 4px 14px rgba(7, 3, 15, 0.18)',
          padding: 10,
          boxSizing: 'border-box',
        }}
      >
        {/* 郵戳（右上角） */}
        {date && (
          <div style={{ position: 'absolute', top: 18, right: 18, opacity: 0.9 }}>
            <Postmark day={date.day} monthEn={date.monthEn} year={date.year} />
          </div>
        )}

        {/* 內層雙線框：外粗內幼 */}
        <div style={{ border: `2px solid ${GOLD_LINE}`, padding: 4 }}>
          <div style={{ border: `1px solid ${GOLD_FAINT}`, padding: '34px 30px 28px' }}>
            {/* ---- 刊頭（刊號 + 日期 + 中縫） ---- */}
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: '0.22em',
                color: INK_SOFT,
                paddingRight: 104,
              }}
            >
              <span>No. {order.orderNo}</span>
              <span>{date?.en ?? ''}</span>
            </div>
            <div style={{ marginTop: 8, borderTop: `1px solid ${GOLD_LINE}`, borderBottom: `1px solid ${GOLD_FAINT}`, height: 3 }} />

            {/* ---- Red Code logo + 單據標題（Glo 指示：加返 logo） ---- */}
            <div style={{ textAlign: 'center', marginTop: 26 }}>
              <img src="/logo.png" alt="Red Code" style={{ height: 64, width: 'auto', display: 'inline-block' }} />
              <p
                style={{
                  fontFamily: MONO,
                  fontSize: 9.5,
                  letterSpacing: '0.5em',
                  color: INK_SOFT,
                  textTransform: 'uppercase',
                  margin: '14px 0 0',
                }}
              >
                Fashion Design · Hong Kong
              </p>
              <h1
                style={{
                  fontFamily: SERIF,
                  fontWeight: 700,
                  fontSize: 17,
                  letterSpacing: '0.55em',
                  textIndent: '0.55em',
                  color: INK,
                  margin: '12px 0 0',
                }}
              >
                訂單單據
              </h1>
              <p
                style={{
                  fontFamily: MONO,
                  fontSize: 9.5,
                  letterSpacing: '0.4em',
                  textIndent: '0.4em',
                  color: INK_SOFT,
                  marginTop: 6,
                  textTransform: 'uppercase',
                }}
              >
                Official Receipt
              </p>
            </div>

            {/* ---- 訂單資料（私隱版：電話頭 4 位、唔顯示詳細地址） ---- */}
            <div style={{ marginTop: 26 }}>
              <RuleLabel>Particulars · 訂單資料</RuleLabel>
              <div style={{ marginTop: 14, display: 'grid', gap: 9 }}>
                <MetaRow label="訂單編號 Order No." value={order.orderNo} />
                <MetaRow label="落單日期 Date" value={date?.zhTime ?? ''} />
                <MetaRow label="訂單狀態 Status" value={statusText} />
                <MetaRow label="會員姓名 Member" value={order.user?.name ?? (order.guestName ? `【訪客】${order.guestName}` : "—")} />
                <MetaRow label="聯絡電話 Phone" value={maskPhone(order.user?.phone ?? order.guestPhone ?? "")} />
                <MetaRow label="取貨方式 Delivery" value={deliveryText} />
                {/* v2.1.0：會員級別（銀/金先上單）＋ 運費（免運 ✓／到付連地區註記） */}
                {vipTierText && <MetaRow label="會員級別 Tier" value={vipTierText} />}
                {shippingText === 'free' && (
                  <MetaRow
                    label="運費 Shipping"
                    value={<span style={{ color: '#8a6d1f' }}>免運 ✓</span>}
                  />
                )}
                {shippingText !== null && shippingText !== 'free' && (
                  <MetaRow label="運費 Shipping" value={shippingText} />
                )}
                <MetaRow label="付款渠道 Payment" value={CHANNEL_TEXT[order.paymentChannel] ?? order.paymentChannel} />
                {paidDate && <MetaRow label="付款時間 Paid At" value={paidDate.zhTime} />}
                {order.note && <MetaRow label="備註 Note" value={order.note} />}
                {/* v2.1.0：系統備註（澳門單・不包郵／VIP金會員全年免運等，WMS 同一字串） */}
                {order.remark && <MetaRow label="訂單備註 Remark" value={order.remark} />}
              </div>
            </div>

            {/* ---- 明細（dotted leader） ---- */}
            <div style={{ marginTop: 26 }}>
              <RuleLabel>Items · 貨品明細</RuleLabel>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  marginTop: 14,
                  paddingBottom: 6,
                  borderBottom: `1px solid ${GOLD_LINE}`,
                  fontFamily: MONO,
                  fontSize: 9.5,
                  letterSpacing: '0.24em',
                  color: INK_SOFT,
                  textTransform: 'uppercase',
                }}
              >
                <span>貨品 Item</span>
                <span>數量 × 單價 · 金額</span>
              </div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {order.items.map((item) => (
                  <li
                    key={item.id}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      gap: 16,
                      padding: '9px 0',
                      borderBottom: `1px dotted ${GOLD_FAINT}`,
                    }}
                  >
                    <span style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 15, color: INK, lineHeight: 1.5 }}>
                      <span style={item.shipStatus === 'cancelled' ? { textDecoration: 'line-through', color: INK_SOFT } : undefined}>
                        {item.productName}
                      </span>
                      <span
                        style={{
                          display: 'block',
                          fontFamily: MONO,
                          fontWeight: 400,
                          fontSize: 10.5,
                          color: INK_SOFT,
                          letterSpacing: '0.04em',
                          marginTop: 3,
                        }}
                      >
                        {item.sku}
                        {item.size ? `　・　${item.size}` : ''}
                      </span>
                      {/* v2.4.0（Wave 2）：逐件出貨狀態／取消原因／員工更改（單據都顯示，白紙黑字） */}
                      {item.shipStatus === 'shipped' && (
                        <span style={{ display: 'block', fontFamily: MONO, fontSize: 10.5, color: GOLD_LINE, marginTop: 3, letterSpacing: '0.06em' }}>
                          ✓ 已寄出
                        </span>
                      )}
                      {item.shipStatus === 'cancelled' && (
                        <span style={{ display: 'block', fontFamily: MONO, fontSize: 10.5, color: '#8c3b2e', marginTop: 3, letterSpacing: '0.04em' }}>
                          ✕ 已取消{item.cancelReason ? `——${item.cancelReason}` : ''}
                        </span>
                      )}
                      {/* v2.5.4：同款多件部分取消（未全取消先顯示） */}
                      {item.shipStatus !== 'cancelled' && (item.cancelledQty ?? 0) > 0 && (
                        <span style={{ display: 'block', fontFamily: MONO, fontSize: 10.5, color: '#B45309', marginTop: 3, letterSpacing: '0.04em' }}>
                          ✕ 部分取消 {item.cancelledQty} 件{item.cancelReason ? `——${item.cancelReason}` : ''}
                        </span>
                      )}
                      {item.staffChangedAt && (
                        <span style={{ display: 'block', fontFamily: MONO, fontSize: 10.5, color: GOLD_LINE, marginTop: 3, letterSpacing: '0.04em' }}>
                          ✎ 員工更改{item.staffChangeNote ? `——${item.staffChangeNote}` : ''}
                        </span>
                      )}
                    </span>
                    <span
                      style={{
                        flexShrink: 0,
                        textAlign: 'right',
                        fontFamily: MONO,
                        fontSize: 12,
                        color: INK,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      <span style={{ color: INK_SOFT, marginRight: 12 }}>
                        {item.quantity} × {fmtMoney(item.price)}
                      </span>
                      {fmtMoney(item.price * item.quantity)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* ---- v2.4.0（Wave 2）：出貨紀錄（順豐單號＋追蹤連結＋寄出時間） ---- */}
            {(order.shipments ?? []).filter((s) => s.reversedAt == null).length > 0 && (
              <div style={{ marginTop: 20 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    paddingBottom: 6,
                    borderBottom: `1px solid ${GOLD_LINE}`,
                    fontFamily: MONO,
                    fontSize: 9.5,
                    letterSpacing: '0.24em',
                    color: INK_SOFT,
                    textTransform: 'uppercase',
                  }}
                >
                  <span>出貨紀錄 Shipments</span>
                </div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {(order.shipments ?? [])
                    .filter((s) => s.reversedAt == null)
                    .map((s) => {
                      const methodLabel =
                        s.shipMethod === 'sf'
                          ? '順豐速運'
                          : s.shipMethod === 'face'
                            ? '面交交收'
                            : s.shipMethod === 'pickup'
                              ? '上門自取'
                              : '已入倉儲存';
                      const dt = new Date(s.shippedAt);
                      return (
                        <li
                          key={s.id}
                          style={{
                            padding: '9px 0',
                            borderBottom: `1px dotted ${GOLD_FAINT}`,
                            fontFamily: MONO,
                            fontSize: 11.5,
                            color: INK,
                            lineHeight: 1.7,
                          }}
                        >
                          {methodLabel}
                          {s.shipMethod === 'sf' && s.sfNo ? `　單號 ${s.sfNo}` : ''}
                          　・　{dt.toLocaleString('zh-HK', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
                          {s.shipMethod === 'sf' && s.sfNo && (
                            <span style={{ display: 'block', color: INK_SOFT, fontSize: 10.5 }}>
                              追蹤：https://www.sf-express.com/hk/tc/dynamic_function/waybill/#search/bill-number/{s.sfNo}
                              　（順豐系統一般需要 2–10 小時先更新追蹤狀態）
                            </span>
                          )}
                        </li>
                      );
                    })}
                </ul>
              </div>
            )}

            {/* ---- 小計 → 折扣 → 總計（會計式雙 hairline） ---- */}
            <div style={{ marginTop: 22 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '4px 0 6px' }}>
                <span style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '0.1em', color: INK_SOFT }}>小計 Subtotal</span>
                <span style={{ fontFamily: MONO, fontSize: 13, color: INK, fontVariantNumeric: 'tabular-nums' }}>
                  {fmtMoney(subtotal)}
                </span>
              </div>
              {/* v2.1.0：VIP 折扣行排優惠碼折扣行上面（落單次序先 VIP 後 coupon） */}
              {vipDiscount > 0 && (
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '4px 0 6px' }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '0.1em', color: INK_SOFT }}>
                    VIP 折扣{vipTierText ? `（${vipTierText}）` : ''}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 13, color: '#8a6d1f', fontVariantNumeric: 'tabular-nums' }}>
                    −{fmtMoney(vipDiscount)}
                  </span>
                </div>
              )}
              {order.discountAmount > 0 && (
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '4px 0 10px' }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '0.1em', color: INK_SOFT }}>
                    折扣 Discount{order.promoCode ? `（${order.promoCode}）` : ''}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 13, color: INK, fontVariantNumeric: 'tabular-nums' }}>
                    −{fmtMoney(order.discountAmount)}
                  </span>
                </div>
              )}
              <div style={{ borderTop: `2px solid ${GOLD_LINE}`, borderBottom: `1px solid ${GOLD_FAINT}`, height: 4 }} />
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '14px 0 4px' }}>
                <span style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 18, letterSpacing: '0.28em', color: INK }}>
                  總計
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 10,
                      letterSpacing: '0.3em',
                      color: INK_SOFT,
                      marginLeft: 10,
                      textTransform: 'uppercase',
                    }}
                  >
                    Total
                  </span>
                </span>
                <span
                  style={{
                    fontFamily: SERIF,
                    fontWeight: 600,
                    fontSize: 30,
                    lineHeight: 1,
                    color: INK,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {fmtMoney(order.total)}
                </span>
              </div>
              <div style={{ borderTop: `1px solid ${GOLD_FAINT}`, marginTop: 4 }} />
            </div>

            {/* ---- 全網統一手續費免責聲明（§0 逐字，唔准改） ---- */}
            <p
              style={{
                textAlign: 'center',
                fontFamily: SERIF,
                fontSize: 10.5,
                lineHeight: 1.9,
                letterSpacing: '0.05em',
                color: INK_FAINT,
                margin: '18px 0 0',
              }}
            >
              {ONLINE_PAYMENT_FEE_NOTE}
            </p>

            {/* ---- F7 退款狀態細字（融入卡內，唔外加 banner） ---- */}
            {isRefunded && (
              <p style={{ textAlign: 'center', fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.12em', color: INK_SOFT, margin: '14px 0 0', lineHeight: 1.9 }}>
                {refundedDate && (
                  <>
                    退款時間　{refundedDate.zhTime}
                    <br />
                  </>
                )}
                款項 3–10 個工作天原路退回
              </p>
            )}
            {isManualRefund && (
              <p style={{ textAlign: 'center', fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.12em', color: INK_SOFT, margin: '14px 0 0' }}>
                人手退款處理中
              </p>
            )}
            {order.refundStatus === 'pending' && (
              <p style={{ textAlign: 'center', fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.12em', color: INK_SOFT, margin: '14px 0 0' }}>
                ⏳ 退款審批中
              </p>
            )}
            {order.refundStatus === 'failed' && (
              <p style={{ textAlign: 'center', fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.12em', color: '#8c3b2e', margin: '14px 0 0' }}>
                退款失敗 · 請聯絡客服
              </p>
            )}

            {/* ---- 卡尾：火漆印 + 謝語 + 單號 ---- */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'space-between',
                gap: 20,
                marginTop: 30,
                paddingTop: 18,
                borderTop: `1px solid ${GOLD_FAINT}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <WaxSeal />
                <div>
                  <p style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 16, color: INK, lineHeight: 1.4, margin: 0 }}>
                    多謝支持
                  </p>
                  <p
                    style={{
                      fontFamily: MONO,
                      fontSize: 9,
                      letterSpacing: '0.26em',
                      color: INK_SOFT,
                      margin: '3px 0 0',
                      textTransform: 'uppercase',
                    }}
                  >
                    With Gratitude
                  </p>
                </div>
              </div>
              <p style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.2em', color: INK_SOFT, margin: 0, textAlign: 'right' }}>
                {order.orderNo}
              </p>
            </div>

            <p
              style={{
                textAlign: 'center',
                fontFamily: MONO,
                fontSize: 8.5,
                letterSpacing: '0.18em',
                color: INK_SOFT,
                margin: '20px 0 0',
              }}
            >
              此單據由 RED CODE 簽發 · 如有查詢請聯絡客服 · redcode.red
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
