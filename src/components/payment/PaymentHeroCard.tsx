import { useRef, useState } from 'react';
import type { JSX } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';

/**
 * PaymentHeroCard — 英倫風訂單確認卡（A5 設計，SPEC §3.5 契約）
 *
 * 設計語言：一張由香港寄出嘅紙本訂單確認書。
 * - 米白象牙紙感（暖奶油底色 + 極淡斜向紙紋 + 邊緣陳舊暈染）
 * - 經典發票 hairline 雙線框（外粗內幼）
 * - serif 中英字體 stack（Cormorant Garamond + Noto Serif TC，全站既有字體，
 *   index.html 已用 font-display: swap 載入，呢度直接用唔使再 inject）
 * - 期刊式刊頭（刊號＝訂單編號、日期行、中縫 hairline 規線）
 * - 純 SVG 圓形郵戳（弧形文字 + 雙圈）＋ 純 CSS 火漆印（RC 花押字）
 * - 收據式明細：dotted leader 虛線、金額右對齊、總計用會計式雙 hairline
 * - 條碼風 SVG 裝飾（由訂單編號 deterministic 生成，唔係真條碼）
 *
 * 兩個下載掣喺卡外（永遠唔會入鏡），並加 data-html2canvas-ignore 雙重保險；
 * html2canvas 同 jspdf 都係 dynamic import()，唔會塞首屏 bundle。
 */

/* ---------- 設計常數（全卡統一口徑；Wave 2 對齊 WMS BillPage §0 設計錨） ---------- */
const PAPER = '#fcfcf8'; // cream 底（§0）
const PAPER_LIGHT = '#fffefb'; // 紙面高光（§0）
const INK = '#2a160d'; // 深棕墨（§0）
const INK_SOFT = 'rgba(42, 22, 13, 0.62)'; // 淡墨 ink-soft（§0）
const INK_FAINT = 'rgba(42, 22, 13, 0.42)'; // 更淡墨 ink-faint（§0）
const SEAL_RED = '#9C1B32'; // 火漆／郵戳實物紅（非文字色；文字一律 ink/gold）
const GOLD_LINE = '#ab8c52'; // 青銅金（§0）
const GOLD_FAINT = 'rgba(171, 140, 82, 0.45)'; // gold hairline（§0）

/** 全網統一手續費免責聲明（F7 §0 逐字，唔准改） */
const ONLINE_PAYMENT_FEE_NOTE =
  '以信用卡或電子錢包付款，支付平台將按所選支付方式收取手續費，最終金額以支付頁顯示為準';

const SERIF = `'Cormorant Garamond', 'Noto Serif TC', serif`;
const MONO = `'DM Mono', ui-monospace, 'SFMono-Regular', monospace`;

const MONTHS_EN = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const fmtMoney = (n: number) => `HK$${n.toLocaleString('en-HK')}`;

/* ---------- 小工具 ---------- */
function splitDate(createdAt: string | Date) {
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  return {
    zh: `${safe.getFullYear()} 年 ${safe.getMonth() + 1} 月 ${safe.getDate()} 日`,
    en: `${String(safe.getDate()).padStart(2, '0')} ${MONTHS_EN[safe.getMonth()]} ${safe.getFullYear()}`,
    day: String(safe.getDate()).padStart(2, '0'),
    monthEn: MONTHS_EN[safe.getMonth()],
    year: String(safe.getFullYear()),
  };
}

/* ---------- 圓形郵戳（純 SVG，弧線文字） ---------- */
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
        <path id="rc-postmark-arc" d="M55,55 m-38,0 a38,38 0 1,1 76,0 a38,38 0 1,1 -76,0" />
      </defs>
      <circle cx="55" cy="55" r="52" fill="none" stroke={ink} strokeWidth="1.6" />
      <circle cx="55" cy="55" r="49" fill="none" stroke={ink} strokeWidth="0.7" />
      <circle cx="55" cy="55" r="27" fill="none" stroke={ink} strokeWidth="0.9" />
      <text
        fill={ink}
        fontSize="9.2"
        letterSpacing="2.6"
        style={{ fontFamily: MONO, fontWeight: 500 }}
      >
        <textPath href="#rc-postmark-arc" startOffset="2%">
          RED CODE · HONG KONG · BOUTIQUE ·
        </textPath>
      </text>
      <text
        x="55"
        y="52"
        textAnchor="middle"
        fill={ink}
        fontSize="12"
        style={{ fontFamily: MONO, fontWeight: 500 }}
      >
        {day} {monthEn}
      </text>
      <text x="55" y="66" textAnchor="middle" fill={ink} fontSize="10" style={{ fontFamily: MONO }}>
        {year}
      </text>
      {/* 銷戳波浪線 */}
      <path
        d="M4 78 q6 -5 12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0"
        fill="none"
        stroke={ink}
        strokeWidth="1.4"
        opacity="0.75"
      />
      <path
        d="M8 86 q6 -5 12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0"
        fill="none"
        stroke={ink}
        strokeWidth="1.4"
        opacity="0.6"
      />
    </svg>
  );
}

/* ---------- 火漆印（純 CSS 徑向漸層 + serif 花押字） ---------- */
function WaxSeal() {
  return (
    <div
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center"
      style={{
        width: 74,
        height: 74,
        borderRadius: '48% 52% 51% 49% / 52% 47% 53% 48%',
        background:
          `radial-gradient(circle at 36% 30%, #C23A54 0%, ${SEAL_RED} 46%, #7A1227 78%, #5F0D1F 100%)`,
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

/* ---------- 條碼風裝飾（由訂單編號 deterministic 生成嘅 SVG 幼條） ---------- */
function FauxBarcode({ seedText }: { seedText: string }) {
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  for (let i = 0; i < 34 && x < 92; i += 1) {
    const code = seedText.charCodeAt(i % seedText.length) + i * 7;
    const w = (code % 3) + 1; // 1–3px 粗幼交替
    bars.push({ x, w });
    x += w + ((code % 2) + 1.4);
  }
  return (
    <svg viewBox="0 0 96 30" width="96" height="30" aria-hidden="true" style={{ display: 'block' }}>
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y="0" width={b.w} height="30" fill={INK} opacity="0.82" />
      ))}
    </svg>
  );
}

/* ---------- hairline 小標（small caps + 兩側規線） ---------- */
function RuleLabel({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <span style={{ flex: 1, height: 1, background: GOLD_FAINT }} />
      <span
        style={{
          fontFamily: MONO,
          fontSize: 10,
          letterSpacing: '0.32em',
          color: INK_SOFT,
          textTransform: 'uppercase',
        }}
      >
        {children}
      </span>
      <span style={{ flex: 1, height: 1, background: GOLD_FAINT }} />
    </div>
  );
}

export default function PaymentHeroCard(props: {
  orderNo: string;
  createdAt: string | Date;
  statusLabel: string;
  total: number;
  discountAmount?: number;
  items?: { name: string; quantity: number; price: number }[];
  deliveryLabel?: string;
}): JSX.Element {
  const { orderNo, createdAt, statusLabel, total, discountAmount, items, deliveryLabel } = props;
  const cardRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<'png' | 'pdf' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const date = splitDate(createdAt);
  const hasItems = Array.isArray(items) && items.length > 0;
  const hasDiscount = typeof discountAmount === 'number' && discountAmount > 0;

  /* html2canvas 截卡（按鈕喺卡外，唔會入鏡；卡內以純 CSS/SVG 繪製，截圖保真） */
  const captureCard = async (): Promise<HTMLCanvasElement> => {
    const el = cardRef.current;
    if (!el) throw new Error('卡片未準備好');
    const { default: html2canvas } = await import('html2canvas');
    return html2canvas(el, {
      scale: 2,
      backgroundColor: PAPER,
      useCORS: true,
      logging: false,
    });
  };

  const handleDownloadPng = async () => {
    if (busy) return;
    setBusy('png');
    setErrorMsg(null);
    try {
      const canvas = await captureCard();
      const link = document.createElement('a');
      link.download = `redcode-${orderNo}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (err) {
      console.error('[PaymentHeroCard] PNG 下載失敗', err);
      setErrorMsg('圖片下載失敗，請稍後再試。');
    } finally {
      setBusy(null);
    }
  };

  const handleDownloadPdf = async () => {
    if (busy) return;
    setBusy('pdf');
    setErrorMsg(null);
    try {
      const canvas = await captureCard();
      const { jsPDF } = await import('jspdf');
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const margin = 40;
      let w = pageW - margin * 2;
      let h = (canvas.height * w) / canvas.width;
      const maxH = pageH - margin * 2;
      if (h > maxH) {
        h = maxH;
        w = (canvas.width * h) / canvas.height;
      }
      pdf.addImage(imgData, 'PNG', (pageW - w) / 2, margin, w, h);
      pdf.save(`redcode-${orderNo}.pdf`);
    } catch (err) {
      console.error('[PaymentHeroCard] PDF 下載失敗', err);
      setErrorMsg('PDF 下載失敗，請稍後再試。');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[680px]">
      {/* ===== 紙本確認書（下載截圖範圍） ===== */}
      <div
        ref={cardRef}
        style={{
          position: 'relative',
          backgroundColor: PAPER,
          backgroundImage: `
            repeating-linear-gradient(45deg, rgba(171, 140, 82, 0.045) 0px, rgba(171, 140, 82, 0.045) 1px, transparent 1px, transparent 9px),
            radial-gradient(ellipse 120% 90% at 50% 0%, ${PAPER_LIGHT} 0%, transparent 60%),
            radial-gradient(ellipse 140% 120% at 50% 50%, transparent 62%, rgba(171, 140, 82, 0.16) 100%)
          `,
          border: `1px solid ${GOLD_LINE}`,
          boxShadow:
            '0 1px 0 rgba(255,255,255,0.6) inset, 0 18px 50px rgba(7, 3, 15, 0.55), 0 4px 14px rgba(7, 3, 15, 0.4)',
          padding: '10px',
          color: INK,
        }}
      >
        {/* 郵戳（右上角，半透光油墨感） */}
        <div style={{ position: 'absolute', top: 18, right: 18, opacity: 0.9 }}>
          <Postmark day={date.day} monthEn={date.monthEn} year={date.year} />
        </div>

        {/* 內層雙線框：外粗內幼嘅經典發票框 */}
        <div style={{ border: `2px solid ${GOLD_LINE}`, padding: '4px' }}>
          <div style={{ border: `1px solid ${GOLD_FAINT}`, padding: '34px 30px 28px' }}>
            {/* ---- 刊頭（期刊式：刊號 + 日期 + 中縫） ---- */}
            <div
              className="flex items-baseline justify-between"
              style={{
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: '0.22em',
                color: INK_SOFT,
                paddingRight: 104, // 讓位俾右上角郵戳
              }}
            >
              <span>No. {orderNo}</span>
              <span>{date.en}</span>
            </div>
            <div style={{ marginTop: 8, borderTop: `1px solid ${GOLD_LINE}`, borderBottom: `1px solid ${GOLD_FAINT}`, height: 3 }} />

            {/* ---- 品牌字樣 ---- */}
            <div className="text-center" style={{ marginTop: 26 }}>
              <p
                style={{
                  fontFamily: MONO,
                  fontSize: 9.5,
                  letterSpacing: '0.5em',
                  color: INK_SOFT,
                  textTransform: 'uppercase',
                }}
              >
                Fashion Design · Hong Kong
              </p>
              <h2
                style={{
                  fontFamily: SERIF,
                  fontWeight: 600,
                  fontSize: 'clamp(34px, 7vw, 46px)',
                  lineHeight: 1.1,
                  letterSpacing: '0.3em',
                  margin: '10px 0 0 -0.3em', // letterSpacing 補正，視覺置中
                  textIndent: '0.3em',
                  color: INK,
                }}
              >
                RED CODE
              </h2>
              <p
                style={{
                  fontFamily: SERIF,
                  fontWeight: 700,
                  fontSize: 15,
                  letterSpacing: '0.55em',
                  textIndent: '0.55em',
                  color: INK,
                  marginTop: 8,
                }}
              >
                訂單確認書
              </p>
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
                Order Confirmation
              </p>
            </div>

            {/* ---- 訂單資料（mono 中縫表） ---- */}
            <div style={{ marginTop: 26 }}>
              <RuleLabel>Particulars · 訂單資料</RuleLabel>
              <dl style={{ marginTop: 14, display: 'grid', gap: 9 }}>
                {[
                  ['訂單編號 Order No.', orderNo],
                  ['下單日期 Date', date.zh],
                  ['訂單狀態 Status', statusLabel],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-baseline justify-between gap-4">
                    <dt style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '0.08em', color: INK_SOFT }}>
                      {label}
                    </dt>
                    <dd
                      style={{
                        fontFamily: SERIF,
                        fontWeight: 700,
                        fontSize: 15,
                        color: INK,
                        textAlign: 'right',
                      }}
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* ---- 明細（有 items 先顯示） ---- */}
            {hasItems && (
              <div style={{ marginTop: 26 }}>
                <RuleLabel>Items · 貨品明細</RuleLabel>
                <div
                  className="flex items-baseline justify-between"
                  style={{
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
                <ul>
                  {items.map((item, idx) => (
                    <li
                      key={`${item.name}-${idx}`}
                      className="flex items-baseline justify-between gap-4"
                      style={{ padding: '9px 0', borderBottom: `1px dotted ${GOLD_FAINT}` }}
                    >
                      <span style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 15, color: INK, lineHeight: 1.5 }}>
                        {item.name}
                      </span>
                      <span
                        className="shrink-0 text-right"
                        style={{
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
            )}

            {/* ---- 折扣 + 總計（會計式雙 hairline） ---- */}
            <div style={{ marginTop: 22 }}>
              {hasDiscount && (
                <div className="flex items-baseline justify-between" style={{ padding: '4px 0 10px' }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '0.1em', color: INK_SOFT }}>
                    折扣 Discount
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 13, color: INK, fontVariantNumeric: 'tabular-nums' }}>
                    −{fmtMoney(discountAmount)}
                  </span>
                </div>
              )}
              <div style={{ borderTop: `2px solid ${GOLD_LINE}`, borderBottom: `1px solid ${GOLD_FAINT}`, height: 4 }} />
              <div className="flex items-baseline justify-between" style={{ padding: '14px 0 4px' }}>
                <span
                  style={{
                    fontFamily: SERIF,
                    fontWeight: 700,
                    fontSize: 18,
                    letterSpacing: '0.28em',
                    color: INK,
                  }}
                >
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
                  }}
                >
                  {fmtMoney(total)}
                </span>
              </div>
              <div style={{ borderTop: `1px solid ${GOLD_FAINT}`, marginTop: 4 }} />
            </div>

            {/* ---- 取貨方式 ---- */}
            {deliveryLabel && (
              <div className="flex items-baseline justify-between gap-4" style={{ marginTop: 16 }}>
                <span style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '0.1em', color: INK_SOFT }}>
                  取貨方式 Delivery
                </span>
                <span style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 14.5, color: INK, textAlign: 'right' }}>
                  {deliveryLabel}
                </span>
              </div>
            )}

            {/* ---- 全網統一手續費免責聲明（§0 逐字，唔准改） ---- */}
            <p
              className="text-center"
              style={{
                fontFamily: SERIF,
                fontSize: 10.5,
                lineHeight: 1.9,
                letterSpacing: '0.05em',
                color: INK_FAINT,
                marginTop: 18,
              }}
            >
              {ONLINE_PAYMENT_FEE_NOTE}
            </p>

            {/* ---- 卡尾：火漆印 + 謝語 + 條碼 ---- */}
            <div
              className="flex items-end justify-between gap-5"
              style={{ marginTop: 30, paddingTop: 18, borderTop: `1px solid ${GOLD_FAINT}` }}
            >
              <div className="flex items-center gap-4">
                <WaxSeal />
                <div>
                  <p style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 16, color: INK, lineHeight: 1.4 }}>
                    多謝支持
                  </p>
                  <p
                    style={{
                      fontFamily: MONO,
                      fontSize: 9,
                      letterSpacing: '0.26em',
                      color: INK_SOFT,
                      marginTop: 3,
                      textTransform: 'uppercase',
                    }}
                  >
                    With Gratitude
                  </p>
                </div>
              </div>
              <div className="text-right">
                <div className="flex justify-end">
                  <FauxBarcode seedText={orderNo || 'REDCODE'} />
                </div>
                <p style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.2em', color: INK_SOFT, marginTop: 5 }}>
                  {orderNo}
                </p>
              </div>
            </div>

            <p
              className="text-center"
              style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: '0.18em', color: INK_SOFT, marginTop: 20 }}
            >
              此確認書由 RED CODE 簽發 · 如有查詢請聯絡客服 · redcode.red
            </p>
          </div>
        </div>
      </div>

      {/* ===== 下載掣（卡外，永遠唔入鏡；data-html2canvas-ignore 雙重保險） ===== */}
      <div
        data-html2canvas-ignore="true"
        className="mt-6 flex flex-wrap items-center justify-center gap-3"
      >
        <button
          type="button"
          onClick={() => void handleDownloadPng()}
          disabled={busy !== null}
          className="btn btn-primary"
          aria-label="下載訂單卡圖片"
        >
          {busy === 'png' ? (
            <Loader2 size={16} aria-hidden="true" className="animate-spin" />
          ) : (
            <Download size={16} aria-hidden="true" />
          )}
          {busy === 'png' ? '準備緊圖片…' : '下載圖片'}
        </button>
        <button
          type="button"
          onClick={() => void handleDownloadPdf()}
          disabled={busy !== null}
          className="btn btn-secondary"
          aria-label="下載訂單卡 PDF"
        >
          {busy === 'pdf' ? (
            <Loader2 size={16} aria-hidden="true" className="animate-spin" />
          ) : (
            <FileText size={16} aria-hidden="true" />
          )}
          {busy === 'pdf' ? '準備緊 PDF…' : '下載 PDF'}
        </button>
      </div>
      {errorMsg && (
        <p className="mt-3 text-center text-[13px]" style={{ color: 'var(--pink-soft)' }}>
          {errorMsg}
        </p>
      )}
    </div>
  );
}
