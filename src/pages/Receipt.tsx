import { useParams, useNavigate } from 'react-router';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';

/**
 * 訂單單據 /#/receipt/:orderId —— Wave 2 全網單據統一款式：
 * 跟 WMS BillPage v2.0.0「英式優雅精裝紙單」（cream #fcfcf8／ink #2a160d／gold #ab8c52、
 * 零圓角、雙金線內框、Playfair Display＋Noto Serif TC＋JetBrains Mono、
 * hairline 明細表、3px double 總計線、rise 動畫、呼吸 loading）。
 * 資料流唔變：trpc.orders.receipt.useQuery；server 把關會員只攞到自己嘅單。
 * 列印時用 visibility 技巧淨係印 .rcr-sheet（網站導航唔會上紙）。
 * F7 退款狀態融入單據狀態區（唔再外加 banner）；取消＋退款單成張灰階。
 */

// ---------- 組件級字體 + 樣式（跟 BillPage PAGE_CSS 模式；class 前綴 rcr-）----------
// 中文永遠唔准 italic；Playfair italic 淨係用喺拉丁副題
const PAGE_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Noto+Serif+TC:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

.rcr-root {
  --rcr-cream: #fcfcf8;
  --rcr-ink: #2a160d;
  --rcr-gold: #ab8c52;
  --rcr-gold-hair: rgba(171, 140, 82, 0.45);
  --rcr-gold-faint: rgba(171, 140, 82, 0.22);
  --rcr-ink-soft: rgba(42, 22, 13, 0.62);
  --rcr-ink-faint: rgba(42, 22, 13, 0.42);
  --rcr-error: #8c3b2e;
  --rcr-serif: 'Playfair Display', 'Noto Serif TC', serif;
  --rcr-mono: 'JetBrains Mono', monospace;
  background: var(--rcr-cream);
  color: var(--rcr-ink);
  font-family: var(--rcr-serif);
  -webkit-font-smoothing: antialiased;
  padding: 28px 14px 56px;
  box-sizing: border-box;
}
.rcr-root *, .rcr-root *::before, .rcr-root *::after { box-sizing: border-box; }

/* 進場：輕微 rise（淨係 opacity/transform） */
@keyframes rcrRise {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}
.rcr-sheet {
  max-width: 560px;
  margin: 0 auto;
  background: #fffefb;
  border: 1px solid var(--rcr-gold-hair);
  box-shadow: 0 28px 64px -36px rgba(42, 22, 13, 0.28);
  padding: 8px;
  animation: rcrRise 640ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
}
/* 雙金線內框 — 精裝紙單 letterpress 工藝 */
.rcr-frame {
  border: 1px solid var(--rcr-gold-faint);
  padding: 36px 26px 30px;
}
@media (max-width: 420px) {
  .rcr-frame { padding: 28px 16px 24px; }
}

/* 已取消／已退款：成張單灰階作廢態 */
.rcr-sheet.rcr-void { filter: grayscale(1); opacity: 0.78; }

.rcr-head { text-align: center; }
.rcr-logo { height: 46px; width: auto; display: inline-block; }
.rcr-company {
  margin: 14px 0 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.34em;
  text-indent: 0.34em; /* 視覺置中補字距 */
  text-transform: uppercase;
}
.rcr-doc-title {
  margin: 20px 0 0;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: 0.42em;
  text-indent: 0.42em;
}
.rcr-doc-sub {
  margin: 8px 0 0;
  font-family: var(--rcr-serif);
  font-style: italic; /* 淨係拉丁裝飾字用 italic */
  font-size: 11.5px;
  letter-spacing: 0.22em;
  text-indent: 0.22em;
  color: var(--rcr-ink-soft);
}
/* 標題下雙線：1px 金 + 1px gold-hair */
.rcr-head-rule {
  margin: 20px auto 0;
  border: 0;
  border-top: 1px solid var(--rcr-gold);
  width: 100%;
}
.rcr-head-rule-double {
  margin: 3px auto 0;
  border: 0;
  border-top: 1px solid var(--rcr-gold-hair);
  width: 100%;
}

.rcr-orderno {
  margin: 22px 0 0;
  text-align: center;
  font-family: var(--rcr-mono);
  font-size: 13px;
  letter-spacing: 0.08em;
}
.rcr-orderdate {
  margin: 6px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--rcr-ink-soft);
  letter-spacing: 0.12em;
}

.rcr-meta {
  margin: 24px 0 0;
  border-top: 1px solid var(--rcr-gold-hair);
  border-bottom: 1px solid var(--rcr-gold-hair);
  padding: 14px 2px;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 7px 18px;
  font-size: 13.5px;
}
.rcr-meta dt {
  margin: 0;
  font-size: 11px;
  letter-spacing: 0.24em;
  color: var(--rcr-ink-faint);
  white-space: nowrap;
  padding-top: 2px;
}
.rcr-meta dd { margin: 0; text-align: right; font-weight: 500; }
.rcr-meta dd.rcr-mono { font-family: var(--rcr-mono); font-size: 12.5px; }

/* 明細表：hairline 金線分隔、數字 tabular-nums 對齊 */
.rcr-items { margin: 26px 0 0; width: 100%; border-collapse: collapse; }
.rcr-items caption {
  text-align: left;
  font-size: 11px;
  letter-spacing: 0.3em;
  color: var(--rcr-ink-faint);
  padding-bottom: 10px;
}
.rcr-items th {
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.18em;
  color: var(--rcr-ink-soft);
  border-top: 1px solid var(--rcr-gold);
  border-bottom: 1px solid var(--rcr-gold-hair);
  padding: 8px 6px;
  text-align: left;
  white-space: nowrap;
}
.rcr-items th.rcr-num, .rcr-items td.rcr-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.rcr-items td {
  font-size: 13px;
  padding: 10px 6px;
  border-bottom: 1px solid var(--rcr-gold-faint);
  vertical-align: top;
}
.rcr-item-name { font-weight: 600; }
.rcr-item-code {
  display: block;
  font-family: var(--rcr-mono);
  font-size: 10.5px;
  color: var(--rcr-ink-soft);
  letter-spacing: 0.04em;
  margin-top: 3px;
}
.rcr-qty { font-variant-numeric: tabular-nums; }

/* 合計區 */
.rcr-totals { margin: 18px 0 0; }
.rcr-total-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 16px;
  padding: 7px 2px;
  font-size: 13.5px;
}
.rcr-total-row .rcr-l { letter-spacing: 0.2em; font-size: 12px; color: var(--rcr-ink-soft); }
.rcr-total-row .rcr-v { font-variant-numeric: tabular-nums; font-weight: 500; white-space: nowrap; }
.rcr-grand {
  margin-top: 10px;
  border-top: 1px solid var(--rcr-gold);
  border-bottom: 3px double var(--rcr-gold);
  padding: 16px 2px;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 16px;
}
.rcr-grand .rcr-l { font-size: 14px; font-weight: 600; letter-spacing: 0.3em; }
.rcr-grand .rcr-v {
  font-size: 27px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
@media (max-width: 380px) {
  .rcr-grand .rcr-v { font-size: 23px; }
}

/* 免責聲明（一字唔准改，見 component 內文） */
.rcr-disclaimer {
  margin: 18px 0 0;
  font-size: 11px;
  line-height: 1.9;
  color: var(--rcr-ink-faint);
  letter-spacing: 0.05em;
  text-align: center;
}

/* 狀態區 */
.rcr-status { margin: 26px 0 0; text-align: center; }
.rcr-status-line {
  display: inline-block;
  font-size: 12.5px;
  letter-spacing: 0.24em;
  text-indent: 0.24em;
  color: var(--rcr-ink-soft);
  border: 1px solid var(--rcr-gold-hair);
  padding: 7px 16px;
}
.rcr-status-line.rcr-strong { color: var(--rcr-ink); border-color: var(--rcr-gold); }
.rcr-status-note {
  margin: 12px auto 0;
  font-size: 12px;
  color: var(--rcr-ink-soft);
  letter-spacing: 0.08em;
  line-height: 1.8;
}
.rcr-status-note.rcr-error { color: var(--rcr-error); }

.rcr-foot {
  margin: 34px 0 0;
  border-top: 1px solid var(--rcr-gold-hair);
  padding: 16px 0 2px;
  text-align: center;
}
.rcr-foot-main { font-size: 12.5px; letter-spacing: 0.16em; }
.rcr-foot-sub {
  margin: 8px 0 0;
  font-size: 10.5px;
  color: var(--rcr-ink-faint);
  letter-spacing: 0.2em;
}

/* 載入中：唔用 spinner，淨係呼吸 opacity */
@keyframes rcrBreathe { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
.rcr-loading {
  max-width: 560px;
  margin: 18vh auto 0;
  text-align: center;
  letter-spacing: 0.3em;
  text-indent: 0.3em;
  font-size: 13px;
  color: var(--rcr-ink-soft);
  animation: rcrBreathe 1.8s ease-in-out infinite;
  will-change: opacity;
}
.rcr-loading-rule {
  margin: 18px auto 0;
  width: 56px;
  border: 0;
  border-top: 1px solid var(--rcr-gold);
}

/* 單據外工具掣（返回／列印）：hairline 金框、零圓角 */
.rcr-tool-row {
  max-width: 560px;
  margin: 0 auto 18px;
  display: flex;
  gap: 10px;
}
.rcr-tool-btn {
  flex: 1;
  border: 1px solid var(--rcr-gold);
  border-radius: 0;
  background: transparent;
  color: var(--rcr-ink);
  font-family: var(--rcr-serif);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.28em;
  text-indent: 0.28em;
  padding: 13px 10px;
  cursor: pointer;
  transition: opacity 200ms ease, transform 200ms ease, background 200ms ease;
}
.rcr-tool-btn:hover { background: rgba(171, 140, 82, 0.08); }
.rcr-tool-btn:active { transform: translateY(1px); }

/* 列印規則：淨係印張單據，網站其他嘢全部隱藏 */
@media print {
  body * { visibility: hidden; }
  .rcr-sheet, .rcr-sheet * { visibility: visible; }
  .rcr-sheet {
    position: absolute;
    inset: 0;
    width: 100%;
    max-width: none;
    box-shadow: none !important;
    filter: none !important;
    opacity: 1 !important;
    animation: none !important;
  }
  .rcr-root { background: #ffffff; padding: 0; }
}
`;

const HKT_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 金額係整數港元，直接 HK$ 顯示（唔准除 100） */
const fmtMoney = (n: number) => `HK$${n.toLocaleString('en-HK')}`;

/** HKT YYYY年M月D日 HH:MM */
function fmtDateTimeHKT(d: Date | string | null | undefined): string {
  if (!d) return '';
  const t = new Date(new Date(d).getTime() + HKT_OFFSET_MS);
  if (Number.isNaN(t.getTime())) return '';
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}年${t.getUTCMonth() + 1}月${t.getUTCDate()}日 ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

const STATUS_TEXT: Record<string, string> = {
  pending_payment: '待付款',
  payment_review: '對數中',
  approved: '已確認',
  rejected: '待重傳',
  shipped: '已發貨',
  completed: '已完成',
  cancelled: '已取消',
};

/** 付款渠道：manual＝手動過數；airwallex＝網上付款 */
const CHANNEL_TEXT: Record<string, string> = {
  manual: '手動過數',
  airwallex: 'Airwallex 網上付款',
};

/** 全網統一手續費免責聲明（F7 §0 逐字，唔准改） */
const ONLINE_PAYMENT_FEE_NOTE =
  '以信用卡或電子錢包付款，支付平台將按所選支付方式收取手續費，最終金額以支付頁顯示為準';

export default function Receipt() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const id = Number(orderId);

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

  // ---------- 載入中（呼吸 opacity，唔用 spinner）----------
  if (q.isLoading) {
    return (
      <div className="rcr-root">
        <style>{PAGE_CSS}</style>
        <div className="rcr-loading">
          正在載入單據
          <hr className="rcr-loading-rule" />
        </div>
      </div>
    );
  }

  // ---------- 錯誤態 ----------
  if (q.isError || !q.data) {
    return (
      <div className="rcr-root">
        <style>{PAGE_CSS}</style>
        <div className="rcr-tool-row">
          <button type="button" className="rcr-tool-btn" onClick={goBack}>
            返回
          </button>
        </div>
        <div className="rcr-sheet">
          <div className="rcr-frame">
            <header className="rcr-head">
              <img className="rcr-logo" src="/logo.png" alt="Red Code" />
              <div className="rcr-company">Red Code</div>
              <h1 className="rcr-doc-title">訂單單據</h1>
              <div className="rcr-doc-sub">Official Receipt</div>
              <hr className="rcr-head-rule" />
              <hr className="rcr-head-rule-double" />
            </header>
            <p
              style={{
                textAlign: 'center',
                margin: '48px 0',
                fontSize: 14,
                letterSpacing: '0.2em',
                lineHeight: 2.1,
              }}
            >
              開唔到單據
              <br />
              <span style={{ fontSize: 11.5, color: 'var(--rcr-ink-faint)', letterSpacing: '0.1em' }}>
                {q.error?.message ?? '訂單不存在'}
              </span>
            </p>
            <footer className="rcr-foot">
              <div className="rcr-foot-main">如有查詢，請聯絡 Red Code</div>
              <div className="rcr-foot-sub">多謝支持 RedCode HK直播台</div>
            </footer>
          </div>
        </div>
      </div>
    );
  }

  // ---------- 正常單據 ----------
  const order = q.data;
  const subtotal = order.items.reduce((s, i) => s + i.price * i.quantity, 0);
  const deliveryText =
    order.deliveryMethod === 'sf_station'
      ? `順豐站自取${order.pickupPoint ? `：${order.pickupPoint}` : ''}`
      : order.deliveryMethod === 'sf_locker'
        ? `順豐智能櫃${order.pickupPoint ? `：${order.pickupPoint}` : ''}`
        : '送貨上門';

  // F7 退款狀態（融入單據狀態區，唔再外加 banner）：
  // 取消單（不論退款渠道）成張灰階；refunded 顯示退款時間＋原路退回說明；
  // manual 顯示人手退款處理中；pending 顯示審批中；failed 用 error 色提示聯絡客服
  const isCancelled = order.status === 'cancelled';
  const isRefunded = isCancelled && order.refundStatus === 'refunded';
  const isManualRefund = isCancelled && order.refundStatus === 'manual';
  const isVoid = isCancelled;
  const statusText = isRefunded ? '已取消 · 已退款' : (STATUS_TEXT[order.status] ?? order.status);

  return (
    <div className="rcr-root">
      <style>{PAGE_CSS}</style>

      {/* 操作列（列印時隱藏） */}
      <div className="rcr-tool-row">
        <button type="button" className="rcr-tool-btn" onClick={goBack}>
          返回
        </button>
        <button type="button" className="rcr-tool-btn" onClick={() => window.print()}>
          列印／儲存 PDF
        </button>
      </div>

      {/* 單據紙（列印就係呢張） */}
      <div className={`rcr-sheet${isVoid ? ' rcr-void' : ''}`}>
        <div className="rcr-frame">
          {/* 頂：logo + 品牌 + 單據標題 */}
          <header className="rcr-head">
            <img className="rcr-logo" src="/logo.png" alt="Red Code" />
            <div className="rcr-company">Red Code</div>
            <h1 className="rcr-doc-title">訂單單據</h1>
            <div className="rcr-doc-sub">Official Receipt</div>
            <hr className="rcr-head-rule" />
            <hr className="rcr-head-rule-double" />
          </header>

          {/* 單號（mono）+ 落單日期 */}
          <div className="rcr-orderno">{order.orderNo}</div>
          <div className="rcr-orderdate">落單日期　{fmtDateTimeHKT(order.createdAt)}</div>

          {/* 客戶／取貨／付款資料（有值先顯示） */}
          <dl className="rcr-meta">
            <dt>會員姓名</dt>
            <dd>{order.user.name}</dd>
            <dt>聯絡電話</dt>
            <dd className="rcr-mono">{order.user.phone}</dd>
            <dt>取貨方式</dt>
            <dd>{deliveryText}</dd>
            {order.deliveryMethod === 'address' && order.address && (
              <>
                <dt>送貨地址</dt>
                <dd>{order.address}</dd>
              </>
            )}
            <dt>付款渠道</dt>
            <dd>{CHANNEL_TEXT[order.paymentChannel] ?? order.paymentChannel}</dd>
            {order.paidAt && (
              <>
                <dt>付款時間</dt>
                <dd>{fmtDateTimeHKT(order.paidAt)}</dd>
              </>
            )}
            {order.note && (
              <>
                <dt>備註</dt>
                <dd>{order.note}</dd>
              </>
            )}
          </dl>

          {/* 明細表 */}
          <table className="rcr-items">
            <caption>明細</caption>
            <thead>
              <tr>
                <th>貨品</th>
                <th className="rcr-num">數量</th>
                <th className="rcr-num">單價</th>
                <th className="rcr-num">小計</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="rcr-item-name">{item.productName}</span>
                    <span className="rcr-item-code">
                      {item.sku}
                      {item.size ? `　・　${item.size}` : ''}
                    </span>
                  </td>
                  <td className="rcr-num rcr-qty">{item.quantity}</td>
                  <td className="rcr-num">{fmtMoney(item.price)}</td>
                  <td className="rcr-num">{fmtMoney(item.price * item.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 小計 → 優惠 → 總計（3px double 金線大行） */}
          <div className="rcr-totals">
            <div className="rcr-total-row">
              <span className="rcr-l">小計</span>
              <span className="rcr-v">{fmtMoney(subtotal)}</span>
            </div>
            {order.discountAmount > 0 && (
              <div className="rcr-total-row">
                <span className="rcr-l">優惠</span>
                <span className="rcr-v">
                  −{fmtMoney(order.discountAmount)}
                  {order.promoCode ? `（優惠碼 ${order.promoCode}）` : ''}
                </span>
              </div>
            )}
            <div className="rcr-grand">
              <span className="rcr-l">總計</span>
              <span className="rcr-v">{fmtMoney(order.total)}</span>
            </div>
          </div>

          {/* 全網統一手續費免責聲明（逐字，唔准改） */}
          <p className="rcr-disclaimer">{ONLINE_PAYMENT_FEE_NOTE}</p>

          {/* 狀態區（pill＋退款細字，F7 退款邏輯融入呢度） */}
          <div className="rcr-status">
            <span className={`rcr-status-line${isRefunded || order.status === 'completed' ? ' rcr-strong' : ''}`}>
              {statusText}
            </span>
            {isRefunded && (
              <div className="rcr-status-note">
                {order.refundedAt && (
                  <>
                    退款時間　{fmtDateTimeHKT(order.refundedAt)}
                    <br />
                  </>
                )}
                款項 3–10 個工作天原路退回
              </div>
            )}
            {isManualRefund && <div className="rcr-status-note">人手退款處理中</div>}
            {order.refundStatus === 'pending' && (
              <div className="rcr-status-note">⏳ 退款審批中</div>
            )}
            {order.refundStatus === 'failed' && (
              <div className="rcr-status-note rcr-error">退款失敗 · 請聯絡客服</div>
            )}
          </div>

          {/* 底 */}
          <footer className="rcr-foot">
            <div className="rcr-foot-main">如有查詢，請聯絡 Red Code</div>
            <div className="rcr-foot-sub">多謝支持 RedCode HK直播台</div>
          </footer>
        </div>
      </div>
    </div>
  );
}
