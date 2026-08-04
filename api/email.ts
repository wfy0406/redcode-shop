/**
 * RedCode 寄信基建（2026-08-04 第三版：安靜奢華風＋訂單單據附件）
 * --------------------------------
 * 用 Resend REST API 直 call（fetch），零新 npm dependency，唔會影響 Docker build。
 *
 * Render 要設嘅環境變數：
 * - RESEND_API_KEY：Resend 攞嘅 API key（冇設＝全部 email 靜默 skip，網站照常運作）
 * - EMAIL_FROM：寄件人，例如 `RedCode官方購物網站 <noreply@ows.redcode.red>`（域名要喺 Resend 驗證咗先用得）
 * - SITE_URL：網站地址，預設 https://redcode.red（email 入面 logo 同掣嘅連結用）
 * - REVIEW_ALERT_EMAIL：訂單待審批通知收件人，預設 leader@ows.redcode.red（2026-08-04 加）
 *
 * 所有 sendXxxEmail 都係 never-throw：任何失敗（包括砌 HTML 出錯）淨係 console.error 兼回 SendResult，
 * 唔會阻到主流程（落單／審批唔會因為寄信失敗而彈錯）。
 *
 * 訂單確認信會附上「訂單單據」HTML 附件（base64，經 Resend attachments 寄出），
 * 客人打開可以睇返成張單，仲可以列印或另存 PDF。
 *
 * 2026-08-04 第三版設計方向（安靜奢華 quiet luxury）：
 * 暖白紙底＋白卡配髮絲線框（去圓角、去陰影）；近黑暖調墨色；雙字體系統——
 * sans 做正文、serif（宋體系）做標題同金額等品牌時刻；品牌粉紅只留小面積點綴
 * （kicker／狀態字／連結）；用留白、字距同髮絲線代替色塊同卡片疊卡片。
 * 中文唔用 italic（中文冇真斜體，機械斜體會影響閱讀）。
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const BRAND_PINK = "#e6007e"; // 品牌粉紅：只做小面積點綴（kicker／狀態字／連結）
const INK = "#17140f"; // 近黑（暖調）：標題／總額／主掣／表頭墨線
const BODY = "#3f3a33"; // 正文墨色
const MUTED = "#8d857a"; // 次要文字
const FAINT = "#b3aa9c"; // 極次要（表頭／footer）
const HAIRLINE = "#e7e1d6"; // 髮絲分隔線（暖灰）
const PAPER = "#f5f2ec"; // 外層暖白紙底
const BOX_BG = "#faf8f2"; // 提示盒極淺暖底
const WARN_BG = "#fbf6ea";
const WARN_LINE = "#eadfc2";
const WARN_TEXT = "#7a6520";

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'PingFang HK','PingFang TC','Microsoft JhengHei','Noto Sans TC',sans-serif";
// 標題／金額用 serif：拉丁 Georgia，中文宋體系（宋體先係中文嘅「編輯奢華」字腔）
const SERIF_STACK =
  "Georgia,'Times New Roman','Songti SC','STSong','Noto Serif TC','Noto Serif CJK TC','SimSun',serif";

/** email 入面訂單明細嘅統一格式 */
export type OrderEmailItem = {
  productName: string;
  size: string | null;
  price: number;
  quantity: number;
};

/** 送貨資料（email 內格式化用） */
export type OrderEmailDelivery = {
  method: string; // address / sf_station / sf_locker
  pickupPoint: string | null;
  address: string | null;
};

function siteUrl(): string {
  return (process.env.SITE_URL || "https://redcode.red").replace(/\/+$/, "");
}

/** 用戶資料（名、單號）放入 HTML 前一定要 escape */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** HK$ 金額格式（千分位） */
function fmtMoney(n: number): string {
  try {
    return `HK$${n.toLocaleString("en-US")}`;
  } catch {
    return `HK$${n}`;
  }
}

/** 香港時間日期格式：2026年8月4日 15:30 */
function fmtDateHK(d: Date | string): string {
  try {
    return new Intl.DateTimeFormat("zh-HK", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(d));
  } catch {
    return new Date(d).toISOString().slice(0, 16).replace("T", " ");
  }
}

/** 送貨方式寫成一句人話 */
function fmtDelivery(d: OrderEmailDelivery): string {
  if (d.method === "sf_station") return `順豐站自取${d.pickupPoint ? `：${escapeHtml(d.pickupPoint)}` : ""}`;
  if (d.method === "sf_locker") return `順豐智能櫃自取${d.pickupPoint ? `：${escapeHtml(d.pickupPoint)}` : ""}`;
  return d.address ? `送貨上門：${escapeHtml(d.address)}` : "送貨上門";
}

/** 寄信結果：ok + 失敗原因（畀日誌／後台 toast 直接顯示，唔使再去 Render 掘 log） */
export type SendResult = { ok: boolean; error?: string };

/** 底層寄信：冇 API key 靜默 skip；任何失敗回 { ok:false, error }，絕對唔會 throw */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  /** Resend attachments：filename + base64 content */
  attachments?: { filename: string; content: string }[];
}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[email] RESEND_API_KEY 未設定，略過寄信：「${opts.subject}」→ ${opts.to}`);
    return { ok: false, error: "RESEND_API_KEY 未設定" };
  }
  const from = process.env.EMAIL_FROM || "RedCode官方購物網站 <noreply@ows.redcode.red>";
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        ...(opts.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      console.error(`[email] 寄信失敗（${res.status}）：「${opts.subject}」→ ${opts.to}`, body);
      return { ok: false, error: `Resend ${res.status}: ${body}` };
    }
    console.log(`[email] 已寄出：「${opts.subject}」→ ${opts.to}`);
    return { ok: true };
  } catch (e) {
    console.error(`[email] 寄信錯誤：「${opts.subject}」→ ${opts.to}`, e);
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/* ───────────────────────── 品牌模板＋內容小組件 ───────────────────────── */

/**
 * 品牌模板（每封 email 共用，2026-08-04 安靜奢華版）：
 * 暖白紙底＋白卡（髮絲線框、無圓角、無陰影）；卡頂 logo；
 * 內文頂有粉紅 kicker（闊字距）＋serif 大標題＋髮絲線；卡尾免責聲明＋署名。
 * Email client 兼容做法：table 排版＋全部 inline CSS。
 * 免責聲明（老闆要求）：每封都有「如非本人操作，則不用理會本電郵。」
 */
function brandedEmail(opts: { preheader: string; kicker: string; title: string; contentHtml: string }): string {
  const site = siteUrl();
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:${PAPER};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};">
<tr><td align="center" style="padding:44px 16px 40px;">
  <table role="presentation" width="580" cellpadding="0" cellspacing="0" style="width:100%;max-width:580px;">
    <tr>
      <td align="center" style="padding:0 0 28px;">
        <img src="${site}/logo.png" alt="RedCode Fashion Design" width="190"
          style="display:block;width:190px;max-width:60%;height:auto;" />
      </td>
    </tr>
    <tr>
      <td style="background:#ffffff;border:1px solid ${HAIRLINE};padding:42px 38px 36px;font-family:${FONT_STACK};">
        <p style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:4px;color:${BRAND_PINK};">${escapeHtml(opts.kicker)}</p>
        <h1 style="margin:0;font-family:${SERIF_STACK};font-size:26px;line-height:1.4;letter-spacing:1.5px;color:${INK};font-weight:700;">${escapeHtml(opts.title)}</h1>
        <div style="margin:20px 0 28px;border-top:1px solid ${HAIRLINE};"></div>
        <div style="font-size:15px;line-height:1.95;color:${BODY};">
          ${opts.contentHtml}
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding:26px 8px 0;">
        <p style="margin:0;text-align:center;font-family:${FONT_STACK};font-size:12.5px;line-height:1.9;color:${MUTED};">如非本人操作，則不用理會本電郵。</p>
        <p style="margin:12px 0 0;text-align:center;font-family:${FONT_STACK};font-size:12px;line-height:1.9;color:${FAINT};">
          呢封電郵由系統自動發出，請唔好直接回覆。<br />
          RedCode Fashion Design · <a href="${site}" style="color:${BRAND_PINK};text-decoration:none;">redcode.red</a>
        </p>
      </td>
    </tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

/** 內容小組件：資料列（訂單編號／金額嗰類）——去咗色盒，用上下髮絲線框住，行間幼線 */
function infoBox(rows: [string, string][]): string {
  const trs = rows
    .map(
      ([k, v], i) => `<tr>
        <td style="padding:11px 0;font-size:11px;letter-spacing:2px;color:${MUTED};vertical-align:top;width:104px;${i > 0 ? `border-top:1px solid ${HAIRLINE};` : ""}">${k}</td>
        <td style="padding:11px 0;font-size:14.5px;color:${INK};font-weight:600;${i > 0 ? `border-top:1px solid ${HAIRLINE};` : ""}">${v}</td>
      </tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
    style="margin:22px 0;border-top:1px solid ${HAIRLINE};border-bottom:1px solid ${HAIRLINE};">${trs}</table>`;
}

/** 內容小組件：訂單明細表（商品／尺碼／數量／小計）——表頭用墨線，行間髮絲線，似名店收據 */
function itemsTable(items: OrderEmailItem[]): string {
  const rows = items
    .map(
      (it) => `<tr>
        <td style="padding:11px 0;font-size:14px;color:${INK};border-top:1px solid ${HAIRLINE};">${escapeHtml(it.productName)}</td>
        <td style="padding:11px 8px;font-size:13.5px;color:${MUTED};border-top:1px solid ${HAIRLINE};white-space:nowrap;">${it.size ? escapeHtml(it.size) : "—"}</td>
        <td align="center" style="padding:11px 8px;font-size:14px;color:${BODY};border-top:1px solid ${HAIRLINE};white-space:nowrap;">× ${it.quantity}</td>
        <td align="right" style="padding:11px 0;font-size:14px;color:${INK};font-weight:600;border-top:1px solid ${HAIRLINE};white-space:nowrap;">${fmtMoney(it.price * it.quantity)}</td>
      </tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 4px;">
    <tr>
      <td style="padding:0 0 9px;font-size:10.5px;font-weight:700;letter-spacing:2.5px;color:${FAINT};border-bottom:1px solid ${INK};">商品</td>
      <td style="padding:0 8px 9px;font-size:10.5px;font-weight:700;letter-spacing:2.5px;color:${FAINT};border-bottom:1px solid ${INK};">尺碼</td>
      <td align="center" style="padding:0 8px 9px;font-size:10.5px;font-weight:700;letter-spacing:2.5px;color:${FAINT};border-bottom:1px solid ${INK};">數量</td>
      <td align="right" style="padding:0 0 9px;font-size:10.5px;font-weight:700;letter-spacing:2.5px;color:${FAINT};border-bottom:1px solid ${INK};">小計</td>
    </tr>
    ${rows}
  </table>`;
}

/** 內容小組件：金額總結（小計／折扣／總額）——總額用 serif 墨字，墨線封口 */
function totalsBlock(total: number, discountAmount: number): string {
  const subtotal = total + discountAmount;
  const discountRow =
    discountAmount > 0
      ? `<tr>
          <td style="padding:4px 0;font-size:13.5px;color:${MUTED};">優惠碼折扣</td>
          <td align="right" style="padding:4px 0;font-size:13.5px;color:${MUTED};">−${fmtMoney(discountAmount)}</td>
        </tr>`
      : "";
  const subtotalRow =
    discountAmount > 0
      ? `<tr>
          <td style="padding:4px 0;font-size:13.5px;color:${MUTED};">小計</td>
          <td align="right" style="padding:4px 0;font-size:13.5px;color:${MUTED};">${fmtMoney(subtotal)}</td>
        </tr>`
      : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 6px;">
    ${subtotalRow}
    ${discountRow}
    <tr>
      <td style="padding:14px 0 2px;font-size:12px;font-weight:700;letter-spacing:2.5px;color:${INK};border-top:1px solid ${INK};">應付總額</td>
      <td align="right" style="padding:14px 0 2px;font-family:${SERIF_STACK};font-size:23px;font-weight:700;color:${INK};border-top:1px solid ${INK};">${fmtMoney(total)}</td>
    </tr>
  </table>`;
}

/** 內容小組件：主掣——墨底白字方掣（闊字距），名店式克制 */
function ctaButton(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 10px;">
    <tr><td align="center" style="background:${INK};">
      <a href="${href}" style="display:inline-block;padding:15px 44px;font-family:${FONT_STACK};font-size:12.5px;font-weight:700;letter-spacing:3px;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}

/** 內容小組件：溫馨提示（細字、暖灰） */
function note(text: string): string {
  return `<p style="margin:18px 0 0;font-size:13px;line-height:1.9;color:${MUTED};">${text}</p>`;
}

/** 內容小組件：警告盒（自動取消嗰類要醒目嘅提示）——淺暖底＋髮絲線，去圓角 */
function warnBox(text: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0;">
    <tr><td style="background:${WARN_BG};border:1px solid ${WARN_LINE};padding:14px 18px;">
      <p style="margin:0;font-size:13px;line-height:1.85;color:${WARN_TEXT};">${text}</p>
    </td></tr>
  </table>`;
}

/* ───────────────────────── 訂單單據（確認信附件） ───────────────────────── */

/**
 * 獨立訂單單據 HTML（經瀏覽器打開，現代 CSS 用得）：
 * 頂部工具條（列印／存 PDF）→ logo＋訂單單據 → 訂單資料 → 收件資料 → 明細表 →
 * 總額 → 出貨說明 → 免責聲明。列印時工具條自動收埋。同 email 同一套安靜奢華語言。
 */
function buildInvoiceHtml(args: {
  orderNo: string;
  createdAt: Date | string;
  name: string;
  phone: string | null;
  delivery: OrderEmailDelivery;
  items: OrderEmailItem[];
  total: number;
  discountAmount: number;
}): string {
  const site = siteUrl();
  const orderNo = escapeHtml(args.orderNo);
  const itemRows = args.items
    .map(
      (it) => `<tr>
        <td>${escapeHtml(it.productName)}</td>
        <td>${it.size ? escapeHtml(it.size) : "—"}</td>
        <td class="num">× ${it.quantity}</td>
        <td class="num">${fmtMoney(it.price)}</td>
        <td class="num">${fmtMoney(it.price * it.quantity)}</td>
      </tr>`,
    )
    .join("");
  const subtotal = args.total + args.discountAmount;
  const discountRow =
    args.discountAmount > 0
      ? `<tr><td>優惠碼折扣</td><td class="num">−${fmtMoney(args.discountAmount)}</td></tr>`
      : "";

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>RedCode 訂單單據 ${orderNo}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 16px; background:${PAPER}; color:${BODY};
    font-family:${FONT_STACK}; font-size:14px; line-height:1.85; }
  .toolbar { max-width:680px; margin:0 auto 16px; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
  .toolbar p { margin:0; font-size:13px; color:${MUTED}; }
  .toolbar button { background:${INK}; color:#fff; border:none;
    padding:11px 26px; font-size:12.5px; font-weight:700; letter-spacing:2.5px; cursor:pointer; font-family:inherit; }
  .card { max-width:680px; margin:0 auto; background:#fff; border:1px solid ${HAIRLINE}; padding:42px 40px; }
  .head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; }
  .head img { width:160px; height:auto; }
  .head .doc { text-align:right; }
  .head .doc h1 { margin:0; font-family:${SERIF_STACK}; font-size:26px; letter-spacing:3px; color:${INK}; }
  .head .doc p { margin:5px 0 0; font-size:10.5px; letter-spacing:4px; color:${FAINT}; }
  hr { border:none; border-top:1px solid ${HAIRLINE}; margin:24px 0; }
  .meta { display:grid; grid-template-columns:1fr 1fr; gap:8px 24px; }
  .meta .k { font-size:10.5px; letter-spacing:2px; color:${MUTED}; }
  .meta .v { font-weight:600; color:${INK}; }
  .pink { color:${BRAND_PINK}; font-weight:700; }
  table.items { width:100%; border-collapse:collapse; margin-top:8px; }
  table.items th { text-align:left; font-size:10.5px; letter-spacing:2.5px; color:${FAINT};
    padding:0 6px 9px; border-bottom:1px solid ${INK}; }
  table.items td { padding:11px 6px; border-bottom:1px solid ${HAIRLINE}; vertical-align:top; }
  .num { text-align:right; white-space:nowrap; }
  table.totals { width:100%; border-collapse:collapse; margin-top:14px; }
  table.totals td { padding:4px 6px; }
  table.totals .grand td { border-top:1px solid ${INK}; padding-top:14px;
    font-family:${SERIF_STACK}; font-size:19px; font-weight:700; color:${INK}; }
  table.totals .grand td:first-child { font-family:${FONT_STACK}; font-size:12px; letter-spacing:2.5px; }
  .box { background:${BOX_BG}; border:1px solid ${HAIRLINE}; padding:14px 18px; margin-top:20px; }
  .foot { margin-top:28px; padding-top:18px; border-top:1px solid ${HAIRLINE};
    text-align:center; font-size:12px; color:${FAINT}; }
  @media print {
    body { background:#fff; padding:0; }
    .toolbar { display:none; }
    .card { border:none; padding:0; max-width:none; }
  }
</style>
</head>
<body>
  <div class="toolbar">
    <p>呢張係你嘅訂單單據，可以列印或用瀏覽器「另存為 PDF」收藏。</p>
    <button onclick="window.print()">列印 / 存 PDF</button>
  </div>
  <div class="card">
    <div class="head">
      <img src="${site}/logo.png" alt="RedCode Fashion Design" />
      <div class="doc">
        <h1>訂單單據</h1>
        <p>ORDER INVOICE</p>
      </div>
    </div>
    <hr />
    <div class="meta">
      <div><div class="k">訂單編號</div><div class="v">${orderNo}</div></div>
      <div><div class="k">落單日期</div><div class="v">${fmtDateHK(args.createdAt)}</div></div>
      <div><div class="k">訂單狀態</div><div class="v"><span class="pink">已確認 ✓</span></div></div>
      <div><div class="k">付款狀態</div><div class="v">已確認付款</div></div>
    </div>
    <div class="box">
      <div class="k" style="font-size:10.5px;letter-spacing:2px;color:${MUTED};">收件資料</div>
      <div style="font-weight:600;color:${INK};">${escapeHtml(args.name)}${args.phone ? ` · ${escapeHtml(args.phone)}` : ""}</div>
      <div>${fmtDelivery(args.delivery)}</div>
    </div>
    <hr />
    <table class="items">
      <tr><th>商品</th><th>尺碼</th><th class="num">數量</th><th class="num">單價</th><th class="num">小計</th></tr>
      ${itemRows}
    </table>
    <table class="totals">
      ${args.discountAmount > 0 ? `<tr><td>小計</td><td class="num">${fmtMoney(subtotal)}</td></tr>` : ""}
      ${discountRow}
      <tr class="grand"><td>應付總額</td><td class="num">${fmtMoney(args.total)}</td></tr>
    </table>
    <hr />
    <p style="margin:0;font-size:13px;color:${MUTED};">
      同事會安排出貨，一般情況下會喺 <b>7-10 個工作天</b>內寄出，請留意收件。<br />
      如有疑問，請到 <a href="${site}" style="color:${BRAND_PINK};text-decoration:none;">redcode.red</a> 「我的訂單」揾返呢張單。
    </p>
    <div class="foot">
      如非本人操作，則不用理會本電郵。<br />
      呢封電郵由系統自動發出，請唔好直接回覆。<br />
      RedCode Fashion Design · redcode.red
    </div>
  </div>
</body>
</html>`;
}

/** 訂單單據附件（base64 HTML），檔名全 ASCII 確保所有 email client 睇得明 */
function invoiceAttachment(args: Parameters<typeof buildInvoiceHtml>[0]): {
  filename: string;
  content: string;
} {
  const safeNo = args.orderNo.replace(/[^A-Za-z0-9_-]/g, "-");
  return {
    filename: `RedCode-Invoice-${safeNo}.html`,
    content: Buffer.from(buildInvoiceHtml(args), "utf8").toString("base64"),
  };
}

/* ───────────────────────── 三封 transactional email ───────────────────────── */

/** ① 忘記密碼：6 位驗證碼（10 分鐘有效） */
export async function sendPasswordResetEmail(
  to: string,
  code: string,
  name?: string | null,
): Promise<SendResult> {
  try {
    const greeting = name ? `你好，${escapeHtml(name)}：` : "你好：";
    const content = `
      <p style="margin:0 0 14px;">${greeting}</p>
      <p style="margin:0 0 6px;">我哋收到你重設密碼嘅要求，你嘅 6 位驗證碼係：</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
        <tr><td align="center" style="background:${BOX_BG};border:1px solid ${HAIRLINE};padding:30px 12px 24px;">
          <span style="font-family:${SERIF_STACK};font-size:38px;font-weight:700;letter-spacing:14px;text-indent:14px;color:${INK};">${escapeHtml(code)}</span>
          <p style="margin:14px 0 0;font-size:12.5px;letter-spacing:1px;color:${MUTED};">有效時間 <b style="color:${BRAND_PINK};">10 分鐘</b></p>
        </td></tr>
      </table>
      <p style="margin:0;">請返到登入頁輸入驗證碼同設定新密碼；過咗時效就要撳「重新寄出」攞新碼（新碼會作廢晒舊碼）。</p>
      ${note("溫馨提示：驗證碼唔好話俾任何人知，RedCode 職員絕對唔會向你索取驗證碼。")}
    `;
    return await sendEmail({
      to,
      subject: "【RedCode】重設密碼驗證碼",
      html: brandedEmail({
        preheader: `你嘅 RedCode 重設密碼驗證碼：${escapeHtml(code)}（10 分鐘內有效）`,
        kicker: "REDCODE · 帳號安全",
        title: "重設密碼驗證碼",
        contentHtml: content,
      }),
    });
  } catch (e) {
    console.error(`[email] 砌驗證碼信出錯 → ${to}`, e);
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/** ② 落單後：待付款通知（48 小時內付款＋上傳截圖指引） */
export async function sendOrderPendingEmail(args: {
  to: string;
  name: string;
  orderNo: string;
  total: number;
  discountAmount: number;
  createdAt: Date | string;
  items: OrderEmailItem[];
}): Promise<SendResult> {
  try {
    const orderNo = escapeHtml(args.orderNo);
    const content = `
      <p style="margin:0 0 14px;">你好，${escapeHtml(args.name)}：</p>
      <p style="margin:0;">多謝你喺 RedCode 落單！你嘅訂單已經建立，而家等緊你付款：</p>
      ${infoBox([
        ["訂單編號", orderNo],
        ["落單時間", fmtDateHK(args.createdAt)],
        ["付款期限", `<span style="color:${BRAND_PINK};">48 小時內</span>`],
      ])}
      ${itemsTable(args.items)}
      ${totalsBlock(args.total, args.discountAmount)}
      <p style="margin:22px 0 10px;font-weight:700;color:${INK};">付款之後，記得做埋呢步先算完成：</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${[
          "登入 redcode.red，入去「<b>我的訂單</b>」揾返呢張單",
          "上傳<b>付款截圖或單據</b>",
          "上傳後工作人員會盡快審批，批咗你會再收到確認電郵（附訂單單據）",
        ]
          .map(
            (t, i) => `<tr>
              <td style="width:34px;vertical-align:top;padding:5px 0;">
                <span style="font-family:${SERIF_STACK};font-size:16px;font-weight:700;color:${INK};">${i + 1}.</span>
              </td>
              <td style="padding:4px 0;font-size:14.5px;line-height:1.75;color:${BODY};">${t}</td>
            </tr>`,
          )
          .join("")}
      </table>
      ${ctaButton("前往「我的訂單」", `${siteUrl()}/#/orders`)}
      ${warnBox("溫馨提示：落單後 <b>2 天（48 小時）</b>仍未付款上傳截圖，訂單會自動取消，貨品會放返出嚟賣。")}
    `;
    return await sendEmail({
      to: args.to,
      subject: `【RedCode】訂單 ${args.orderNo} 待付款 — 請於 48 小時內付款`,
      html: brandedEmail({
        preheader: `訂單 ${orderNo} 待付款，請於 48 小時內付款`,
        kicker: "REDCODE · 訂單通知",
        title: "訂單待付款",
        contentHtml: content,
      }),
    });
  } catch (e) {
    console.error(`[email] 砌待付款信出錯 → ${args.to}`, e);
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/** ③ 審批通過後：訂單已確認（7-10 個工作天寄出）＋附訂單單據 HTML 附件 */
export async function sendOrderApprovedEmail(args: {
  to: string;
  name: string;
  phone?: string | null;
  orderNo: string;
  createdAt: Date | string;
  items: OrderEmailItem[];
  total: number;
  discountAmount: number;
  delivery: OrderEmailDelivery;
}): Promise<SendResult> {
  try {
    const orderNo = escapeHtml(args.orderNo);
    const content = `
      <p style="margin:0 0 14px;">你好，${escapeHtml(args.name)}：</p>
      <p style="margin:0;">好消息！你嘅訂單付款已經確認，多謝你支持 RedCode：</p>
      ${infoBox([
        ["訂單編號", orderNo],
        ["確認時間", fmtDateHK(new Date())],
        ["訂單狀態", `<span style="color:${BRAND_PINK};">已確認 ✓</span>`],
        ["送貨方式", fmtDelivery(args.delivery)],
      ])}
      ${itemsTable(args.items)}
      ${totalsBlock(args.total, args.discountAmount)}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0;">
        <tr><td style="background:${BOX_BG};border:1px solid ${HAIRLINE};padding:14px 18px;">
          <p style="margin:0;font-size:13px;line-height:1.85;color:${BODY};">
            <b>附件：</b>呢封電郵附埋你嘅<b>訂單單據</b>（HTML 檔案），打開可以睇返成張單，仲可以列印或另存 PDF 收藏。
          </p>
        </td></tr>
      </table>
      <p style="margin:22px 0 0;">同事將安排出貨，一般情況下會喺 <b>7-10 個工作天</b>內寄出，請留意收件。</p>
      ${ctaButton("查看我嘅訂單", `${siteUrl()}/#/orders`)}
    `;
    return await sendEmail({
      to: args.to,
      subject: `【RedCode】訂單 ${args.orderNo} 已確認 ✓`,
      html: brandedEmail({
        preheader: `訂單 ${orderNo} 已確認，訂單單據已附上`,
        kicker: "REDCODE · 訂單通知",
        title: "訂單已確認 ✓",
        contentHtml: content,
      }),
      attachments: [
        invoiceAttachment({
          orderNo: args.orderNo,
          createdAt: args.createdAt,
          name: args.name,
          phone: args.phone ?? null,
          delivery: args.delivery,
          items: args.items,
          total: args.total,
          discountAmount: args.discountAmount,
        }),
      ],
    });
  } catch (e) {
    console.error(`[email] 砌確認信出錯 → ${args.to}`, e);
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/**
 * ④ 訂單待審批通知（2026-08-04 Glo 要求）：
 * 客人（或員工代客）上傳付款截圖、訂單轉 payment_review 嗰刻，發去審批負責人
 * （預設 leader@ows.redcode.red，可用 REVIEW_ALERT_EMAIL 環境變數改）。
 * 內含完整客戶資料＋訂單內容（編號／時間／姓名／電話／Email／取貨／明細／總額／備註）。
 * 2026-08-04（Glo 更新）：唔再放「前往後台審批」按鈕——信內文字提示主管到內部系統嘅
 * 「官網訂單審批」處理；跟返官網統一信件格式（brandedEmail 安靜奢華模板）。
 */
export async function sendOrderReviewAlertEmail(args: {
  orderNo: string;
  createdAt: Date | string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  delivery: OrderEmailDelivery;
  note: string | null;
  promoCode: string | null;
  items: OrderEmailItem[];
  total: number;
  discountAmount: number;
}): Promise<SendResult> {
  const to = process.env.REVIEW_ALERT_EMAIL || "leader@ows.redcode.red";
  try {
    const orderNo = escapeHtml(args.orderNo);
    const content = `
      <p style="margin:0;">有會員啱啱上傳咗付款截圖，以下訂單而家<b>待審批</b>，請主管到內部系統嘅「官網訂單審批」處理：</p>
      ${infoBox([
        ["訂單編號", orderNo],
        ["落單時間", fmtDateHK(args.createdAt)],
        ["客戶姓名", escapeHtml(args.customerName)],
        ["客戶電話", escapeHtml(args.customerPhone)],
        ["客戶 Email", args.customerEmail ? escapeHtml(args.customerEmail) : "—"],
        ["取貨方式", fmtDelivery(args.delivery)],
        ...(args.promoCode ? ([["優惠碼", escapeHtml(args.promoCode)]] as [string, string][]) : []),
      ])}
      ${itemsTable(args.items)}
      ${totalsBlock(args.total, args.discountAmount)}
      ${args.note ? note(`客戶備註：${escapeHtml(args.note)}`) : ""}
      ${note("請主管到內部系統嘅「官網訂單審批」處理呢張訂單。")}
      ${note("審批通過後，系統會自動發確認電郵（附訂單單據）俾客戶。")}
    `;
    return await sendEmail({
      to,
      subject: `【RedCode 後台】訂單 ${args.orderNo} 待審批 — ${args.customerName}`,
      html: brandedEmail({
        preheader: `訂單 ${orderNo}（${escapeHtml(args.customerName)}）有待審批付款截圖`,
        kicker: "REDCODE · 訂單審批通知",
        title: "訂單待審批",
        contentHtml: content,
      }),
    });
  } catch (e) {
    console.error(`[email] 砌待審批通知出錯 → ${to}`, e);
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/**
 * ⑤ 會員歡迎信（2026-08-04 Glo 要求）：註冊成功即發（電話註冊有填 email 先寄得到；Google 開戶必寄）。
 * 內附迎新優惠碼 WELLCOMEYOU（全單 92 折、無消費金額門檻、每個帳號限用一次），
 * 兩張品牌圖放喺 public/email/，用 ${site} 絕對 URL 引用。
 */
export async function sendWelcomeEmail(args: {
  to: string;
  name: string;
}): Promise<SendResult> {
  try {
    const site = siteUrl();
    const content = `
      <p style="margin:0 0 14px;">${escapeHtml(args.name)}寶寶，你好呀 💕</p>
      <p style="margin:0;">歡迎你正式成為 RedCode 嘅一份子！由今日起，每晚 Glo Glo 都會喺 Facebook 直播同你逐件衫慢慢揀、講質地、講襯法。我地官網成日都會有衫、褲、鞋、襪、小飾物或其他唔同貨推出 ♡</p>
      <img src="${site}/email/welcome-hero.jpg" alt="迎新小禮物" width="504"
        style="display:block;width:100%;max-width:100%;height:auto;margin:22px 0;" />
      <p style="margin:0;">第一次見面，Glo Glo 一早準備咗份迎新小禮物俾你 ✨</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
        <tr><td align="center" style="background:${BOX_BG};border:1px solid ${HAIRLINE};padding:30px 18px 26px;">
          <p style="margin:0;font-size:10.5px;font-weight:700;letter-spacing:2.5px;color:${FAINT};">新會員限定 · 迎新優惠碼</p>
          <span style="display:block;margin:14px 0 10px;font-family:${SERIF_STACK};font-size:34px;font-weight:700;letter-spacing:8px;text-indent:8px;color:${INK};">WELLCOMEYOU</span>
          <p style="margin:0 0 8px;font-size:15px;color:${BODY};">全單 <b style="color:${BRAND_PINK};">92 折</b> · 無消費金額門檻</p>
          <p style="margin:0;font-size:12.5px;line-height:1.8;color:${MUTED};">買幾多錢都用得 ✦ 每個帳號限用一次<br />結帳時喺「優惠碼」一欄輸入，折扣即時自動扣減。</p>
        </td></tr>
      </table>
      ${ctaButton("去揀今日嘅靚衫", `${site}/#/products`)}
      <img src="${site}/email/welcome-dress.jpg" alt="今晚直播見" width="390"
        style="display:block;width:78%;max-width:390px;height:auto;margin:26px auto 6px;" />
      ${note(`以後有咩唔明，隨時 WhatsApp <a href="https://wa.me/85254835368" style="color:${BRAND_PINK};text-decoration:none;">5483 5368</a> 或者 E-Mail 去 <a href="mailto:service.support@ows.redcode.red" style="color:${BRAND_PINK};text-decoration:none;">service.support@ows.redcode.red</a> 搵我哋，Glo Glo 同小幫手會好快覆你 💕`)}
      <p style="margin:18px 0 0;">期待喺直播間見到你 ✦<br />Glo Glo 上</p>
    `;
    return await sendEmail({
      to: args.to,
      subject: "【RedCode】寶寶，歡迎你加入我哋嘅小星球 💕",
      html: brandedEmail({
        preheader: "你嘅迎新優惠碼 WELLCOMEYOU 已經準備好——全單 92 折，無消費金額門檻",
        kicker: "REDCODE · 歡迎加入",
        title: "寶寶，歡迎你呀 ✦",
        contentHtml: content,
      }),
    });
  } catch (e) {
    console.error(`[email] 砌歡迎信出錯 → ${args.to}`, e);
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}
