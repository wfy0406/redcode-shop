/**
 * RedCode 寄信基建（2026-09 Wave 2 第四版：WMS 出單同款「英式精裝紙單」）
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
 * 2026-09 第四版設計方向（跟 WMS BillPage v2.0.0「英式優雅精裝紙單」）：
 * 奶油底 #fcfcf8／紙面 #fffefb／深棕墨 #2a160d／青銅金 #ab8c52；hairline 金線；
 * 零圓角；serif 雙字體（拉丁 Playfair Display／中文宋體系）；mono 單號；
 * 標題闊字距＋標題下雙金線；明細表 hairline 金線；總計行 3px double 金線封口；
 * 金實底墨字 CTA。中文永遠唔用 italic（中文冇真斜體）。
 * Email client 兼容：table 排版＋全部 inline CSS，唔用 flex/grid/@import。
 */

import fs from "node:fs";
import path from "node:path";
import { buildVipCertJpeg, buildVipVerifyUrl } from "./vipCert";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
/* ── 精裝紙單色板（同 WMS BillPage §0 設計錨逐字對齊） ── */
const CREAM = "#fcfcf8"; // 外層奶油底
const PAPER = "#fffefb"; // 內層紙面
const INK = "#2a160d"; // 深棕墨：標題／總額／主字
const GOLD = "#ab8c52"; // 青銅金：金線／強調／CTA 底
const GOLD_HAIR = "rgba(171,140,82,.45)"; // hairline 金線
const GOLD_FAINT = "rgba(171,140,82,.22)"; // faint 金線（行間）
const GOLD_TINT = "rgba(171,140,82,.07)"; // 極淺金底（提示盒）
const INK_SOFT = "rgba(42,22,13,.62)"; // 次要文字
const INK_FAINT = "rgba(42,22,13,.42)"; // 極次要（表頭／footer／免責聲明）
const ERROR = "#8c3b2e"; // 錯誤／取消原因強調

// 精裝紙單 serif 字腔：拉丁 Playfair Display，中文宋體系；webfont 唔保證載到，
// fallback 順序 Georgia → Songti TC → serif，邊個 client 都睇得順
const SERIF_STACK =
  "'Playfair Display','Noto Serif TC',Georgia,'Songti TC','Songti SC','STSong',serif";
// 單號用 monospace（BillPage 用 JetBrains Mono；email client fallback Courier New）
const MONO_STACK = "'JetBrains Mono','Courier New',monospace";

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

/**
 * v2.1.0（VIP+免運）／v2.1.1（Wave 2，2026-09-30）：訂單電郵／單據嘅 VIP 顯示資料。
 * 全部 optional——舊 caller 唔傳都 compile 到、版面同以前一樣。
 * ─ tierLabel：「VIP 銀會員」／「VIP 金會員」（infoBox 加「會員級別」行）
 * ─ discountAmount：VIP 折扣（整數港元；總計區加「VIP 折扣 −HK$X」行，排優惠碼折扣行上面）
 * ─ shippingFreeLabel：「免運 ✓」／「澳門單・順豐到付」等（送貨方式後面加括號）
 */
export type OrderEmailVip = {
  tierLabel?: string | null;
  discountAmount?: number;
  shippingFreeLabel?: string | null;
};

/**
 * 由 order row 嘅 v2.1.0 欄位砌 email 用嘅 VIP 顯示資料（call sites 統一用呢個，口徑一致）：
 * ─ vipDiscountCents > 0 先有折扣行（記住 /100 轉返整數港元）
 * ─ vipTierAtPurchase 'SILVER'→VIP 銀會員／'GOLD'→VIP 金會員／'NONE' 或 null→唔顯示
 * ─ shippingFree=true →「免運 ✓」；否則澳門單／國外單要到付標示
 * 三樣都冇 → 回 undefined（caller 直接 vip: orderVipEmailInfo(order) 咁用）
 */
export function orderVipEmailInfo(order: {
  vipTierAtPurchase?: string | null;
  vipDiscountCents?: number | null;
  shippingFree?: boolean | null;
  region?: string | null;
}): OrderEmailVip | undefined {
  const tierLabel =
    order.vipTierAtPurchase === "GOLD"
      ? "VIP 金會員"
      : order.vipTierAtPurchase === "SILVER"
        ? "VIP 銀會員"
        : null;
  const discountAmount = (order.vipDiscountCents ?? 0) > 0 ? Math.round((order.vipDiscountCents ?? 0) / 100) : 0;
  const shippingFreeLabel = order.shippingFree
    ? "免運 ✓"
    : order.region === "MO"
      ? "澳門單・順豐到付"
      : order.region === "OVERSEAS"
        ? "國外單・順豐到付"
        : null;
  if (!tierLabel && discountAmount <= 0 && !shippingFreeLabel) return undefined;
  return { tierLabel, discountAmount, shippingFreeLabel };
}

/** 送貨方式＋VIP 運費標示（有 label 就喺後面加括號，例如「順豐站自取：XX站（免運 ✓）」） */
function fmtDeliveryWithVip(d: OrderEmailDelivery, label?: string | null): string {
  return fmtDelivery(d) + (label ? `（${escapeHtml(label)}）` : "");
}

/** 官網地址（email 連結／VIP 證書驗證 QR 都用呢個；export 畀 vip.ts／membersRouter.ts 砌 verifyUrl 用，口徑一致） */
export function siteUrl(): string {
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
 * 品牌模板（每封 email 共用，2026-09 WMS 精裝紙單版）：
 * 奶油外底 → 白紙卡（1px gold-hair 外框）→ 雙金線內框（1px gold-faint）；
 * 卡頂置中 logo＋公司名（uppercase 闊字距）；
 * 內文頂有金 kicker（闊字距）＋serif 闊字距大標題（置中）＋標題下雙金線
 * （table row 做 1px gold＋1px gold-hair 兩條）；卡尾免責聲明＋署名。
 * Email client 兼容做法：table 排版＋全部 inline CSS，零圓角。
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
<body style="margin:0;padding:0;background:${CREAM};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM};">
<tr><td align="center" style="padding:44px 16px 40px;">
  <table role="presentation" width="580" cellpadding="0" cellspacing="0" style="width:100%;max-width:580px;">
    <tr>
      <td align="center" style="padding:0 0 26px;">
        <img src="${site}/logo.png" alt="RedCode Fashion Design" width="150"
          style="display:block;width:150px;max-width:52%;height:auto;margin:0 auto;" />
        <p style="margin:14px 0 0;font-family:${SERIF_STACK};font-size:13px;font-weight:600;letter-spacing:5px;text-indent:5px;color:${INK};">REDCODE HK直播台</p>
      </td>
    </tr>
    <tr>
      <td style="background:${PAPER};border:1px solid ${GOLD_HAIR};padding:8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="border:1px solid ${GOLD_FAINT};padding:36px 30px 30px;font-family:${SERIF_STACK};">
              <p style="margin:0 0 14px;text-align:center;font-size:10.5px;font-weight:700;letter-spacing:3px;text-indent:3px;color:${GOLD};">${escapeHtml(opts.kicker)}</p>
              <h1 style="margin:0;text-align:center;font-family:${SERIF_STACK};font-size:24px;line-height:1.5;letter-spacing:7px;text-indent:7px;color:${INK};font-weight:700;">${escapeHtml(opts.title)}</h1>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 26px;">
                <tr><td style="border-top:1px solid ${GOLD};font-size:0;line-height:0;height:0;">&nbsp;</td></tr>
                <tr><td style="height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>
                <tr><td style="border-top:1px solid ${GOLD_HAIR};font-size:0;line-height:0;height:0;">&nbsp;</td></tr>
              </table>
              <div style="font-size:15px;line-height:1.95;color:${INK};">
                ${opts.contentHtml}
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:26px 8px 0;">
        <p style="margin:0;text-align:center;font-family:${SERIF_STACK};font-size:12.5px;line-height:1.9;color:${INK_SOFT};">如非本人操作，則不用理會本電郵。</p>
        <p style="margin:12px 0 0;text-align:center;font-family:${SERIF_STACK};font-size:12px;line-height:1.9;color:${INK_FAINT};">
          呢封電郵由系統自動發出，請唔好直接回覆。<br />
          RedCode Fashion Design · <a href="${site}" style="color:${GOLD};text-decoration:none;">redcode.red</a>
        </p>
      </td>
    </tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

/** 內容小組件：單號用 monospace（BillPage 嘅 mono 單號感） */
function mono(s: string): string {
  return `<span style="font-family:${MONO_STACK};letter-spacing:1px;">${s}</span>`;
}

/** 內容小組件：資料列（訂單編號／金額嗰類）——上下 hairline 金線框住，行間 faint 金線；dt 細字闊字距 */
function infoBox(rows: [string, string][]): string {
  const trs = rows
    .map(
      ([k, v], i) => `<tr>
        <td style="padding:11px 0;font-size:11px;letter-spacing:2px;color:${INK_FAINT};vertical-align:top;width:104px;${i > 0 ? `border-top:1px solid ${GOLD_FAINT};` : ""}">${k}</td>
        <td style="padding:11px 0;font-size:14.5px;color:${INK};font-weight:600;${i > 0 ? `border-top:1px solid ${GOLD_FAINT};` : ""}">${v}</td>
      </tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
    style="margin:22px 0;border-top:1px solid ${GOLD_HAIR};border-bottom:1px solid ${GOLD_HAIR};">${trs}</table>`;
}

/** 內容小組件：訂單明細表（商品／尺碼／數量／小計）——表頭上下金線，行間 faint 金線，金額右對齊 tabular-nums */
function itemsTable(items: OrderEmailItem[]): string {
  const th = `padding:8px 0;font-size:10.5px;font-weight:500;letter-spacing:2px;color:${INK_SOFT};border-top:1px solid ${GOLD};border-bottom:1px solid ${GOLD_HAIR};white-space:nowrap;`;
  const td = `padding:11px 0;border-bottom:1px solid ${GOLD_FAINT};vertical-align:top;`;
  const rows = items
    .map(
      (it) => `<tr>
        <td style="${td}font-size:14px;color:${INK};">${escapeHtml(it.productName)}</td>
        <td style="${td}padding:11px 8px;font-size:13.5px;color:${INK_SOFT};white-space:nowrap;">${it.size ? escapeHtml(it.size) : "—"}</td>
        <td align="center" style="${td}padding:11px 8px;font-size:14px;color:${INK_SOFT};white-space:nowrap;font-variant-numeric:tabular-nums;">× ${it.quantity}</td>
        <td align="right" style="${td}font-size:14px;color:${INK};font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums;">${fmtMoney(it.price * it.quantity)}</td>
      </tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 4px;">
    <tr>
      <td style="${th}">商品</td>
      <td style="${th}padding:8px 8px;">尺碼</td>
      <td align="center" style="${th}padding:8px 8px;">數量</td>
      <td align="right" style="${th}">小計</td>
    </tr>
    ${rows}
  </table>`;
}

/** 內容小組件：金額總結（小計／VIP 折扣／優惠碼折扣／總額）——總計行上 1px 金線＋下 3px double 金線，大字粗體 serif */
// v2.1.1（Wave 2）：加 optional vip 參數——VIP 折扣行排優惠碼折扣行**上面**（折扣次序：先 VIP 後 coupon）。
// 注意 orders.discountAmount 係「VIP 折扣＋優惠碼折扣」嘅總和，所以優惠碼行要減返 VIP 部分先顯示。
function totalsBlock(total: number, discountAmount: number, vip?: OrderEmailVip): string {
  const vipDiscount = vip?.discountAmount ?? 0;
  const couponDiscount = Math.max(0, discountAmount - vipDiscount);
  const subtotal = total + discountAmount;
  const vipRow =
    vipDiscount > 0
      ? `<tr>
          <td style="padding:4px 0;font-size:13.5px;color:${INK_SOFT};">VIP 折扣</td>
          <td align="right" style="padding:4px 0;font-size:13.5px;color:${INK_SOFT};font-variant-numeric:tabular-nums;">−${fmtMoney(vipDiscount)}</td>
        </tr>`
      : "";
  const discountRow =
    couponDiscount > 0
      ? `<tr>
          <td style="padding:4px 0;font-size:13.5px;color:${INK_SOFT};">優惠碼折扣</td>
          <td align="right" style="padding:4px 0;font-size:13.5px;color:${INK_SOFT};font-variant-numeric:tabular-nums;">−${fmtMoney(couponDiscount)}</td>
        </tr>`
      : "";
  const subtotalRow =
    discountAmount > 0
      ? `<tr>
          <td style="padding:4px 0;font-size:13.5px;color:${INK_SOFT};">小計</td>
          <td align="right" style="padding:4px 0;font-size:13.5px;color:${INK_SOFT};font-variant-numeric:tabular-nums;">${fmtMoney(subtotal)}</td>
        </tr>`
      : "";
  const grand = `padding:14px 2px;border-top:1px solid ${GOLD};border-bottom:3px double ${GOLD};`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 6px;">
    ${subtotalRow}
    ${vipRow}
    ${discountRow}
    <tr>
      <td style="${grand}font-size:12px;font-weight:700;letter-spacing:3px;color:${INK};">應付總額</td>
      <td align="right" style="${grand}font-family:${SERIF_STACK};font-size:23px;font-weight:700;color:${INK};font-variant-numeric:tabular-nums;white-space:nowrap;">${fmtMoney(total)}</td>
    </tr>
  </table>`;
}

/** 內容小組件：主掣——金實底、墨字、零圓角、闊字距（padded anchor，email-safe） */
function ctaButton(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 10px;">
    <tr><td align="center" bgcolor="${GOLD}" style="background:${GOLD};">
      <a href="${href}" style="display:inline-block;padding:15px 40px;font-family:${SERIF_STACK};font-size:13px;font-weight:700;letter-spacing:4px;text-indent:4px;color:${INK};text-decoration:none;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}

/** 內容小組件：溫馨提示（細字、墨灰） */
function note(text: string): string {
  return `<p style="margin:18px 0 0;font-size:13px;line-height:1.9;color:${INK_SOFT};">${text}</p>`;
}

/** 內容小組件：警告盒（自動取消嗰類要醒目嘅提示）——極淺金底＋hairline 金框，零圓角 */
function warnBox(text: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0;">
    <tr><td style="background:${GOLD_TINT};border:1px solid ${GOLD_HAIR};padding:14px 18px;">
      <p style="margin:0;font-size:13px;line-height:1.85;color:${INK};">${text}</p>
    </td></tr>
  </table>`;
}

/**
 * 內容小組件：支付手續費免責聲明（涉及付款嘅信尾部用，一字唔准改）：
 * 「以信用卡或電子錢包付款，支付平台將按所選支付方式收取手續費，最終金額以支付頁顯示為準」
 */
function feeDisclaimer(): string {
  return `<p style="margin:20px 0 0;text-align:center;font-size:11px;line-height:1.9;letter-spacing:1px;color:${INK_FAINT};">以信用卡或電子錢包付款，支付平台將按所選支付方式收取手續費，最終金額以支付頁顯示為準。</p>`;
}

/* ───────────────────────── 訂單單據（確認信附件） ───────────────────────── */

/**
 * 獨立訂單單據 HTML（經瀏覽器打開，現代 CSS 用得）：
 * 頂部工具條（列印／存 PDF）→ logo＋訂單單據 → 訂單資料 → 收件資料 → 明細表 →
 * 總額 → 出貨說明 → 免責聲明。列印時工具條自動收埋。同 email 同一套精裝紙單語言
 * （cream／白紙／棕墨／青銅金 hairline，零圓角，mono 單號）。
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
  /** v2.1.1（Wave 2）：VIP 級別／折扣／免運標示（optional，舊 caller 唔傳都得） */
  vip?: OrderEmailVip;
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
  const vipDiscount = args.vip?.discountAmount ?? 0;
  const couponDiscount = Math.max(0, args.discountAmount - vipDiscount);
  const subtotal = args.total + args.discountAmount;
  // VIP 折扣行排優惠碼折扣行上面（折扣次序：先 VIP 後 coupon）
  const vipRow = vipDiscount > 0 ? `<tr><td>VIP 折扣</td><td class="num">−${fmtMoney(vipDiscount)}</td></tr>` : "";
  const discountRow =
    couponDiscount > 0
      ? `<tr><td>優惠碼折扣</td><td class="num">−${fmtMoney(couponDiscount)}</td></tr>`
      : "";
  // 有級別就喺訂單資料區加「會員級別」一欄
  const tierCell = args.vip?.tierLabel
    ? `<div><div class="k">會員級別</div><div class="v"><span class="gold">${escapeHtml(args.vip.tierLabel)}</span></div></div>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>RedCode 訂單單據 ${orderNo}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 16px; background:${CREAM}; color:${INK};
    font-family:${SERIF_STACK}; font-size:14px; line-height:1.85; }
  .toolbar { max-width:680px; margin:0 auto 16px; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
  .toolbar p { margin:0; font-size:13px; color:${INK_SOFT}; }
  .toolbar button { background:${GOLD}; color:${INK}; border:none; border-radius:0;
    padding:11px 26px; font-size:12.5px; font-weight:700; letter-spacing:2.5px; cursor:pointer; font-family:inherit; }
  .card { max-width:680px; margin:0 auto; background:${PAPER}; border:1px solid ${GOLD_HAIR}; padding:8px; }
  .frame { border:1px solid ${GOLD_FAINT}; padding:34px 32px 28px; }
  .head { text-align:center; }
  .head img { width:140px; height:auto; }
  .head .doc h1 { margin:14px 0 0; font-family:${SERIF_STACK}; font-size:24px; letter-spacing:7px; text-indent:7px; color:${INK}; }
  .head .doc p { margin:6px 0 0; font-size:10.5px; letter-spacing:4px; text-indent:4px; color:${INK_FAINT}; }
  .rule { border:none; border-top:1px solid ${GOLD}; margin:20px 0 0; }
  .rule2 { border:none; border-top:1px solid ${GOLD_HAIR}; margin:3px 0 24px; }
  hr { border:none; border-top:1px solid ${GOLD_FAINT}; margin:24px 0; }
  .meta { display:grid; grid-template-columns:1fr 1fr; gap:8px 24px; }
  .meta .k { font-size:10.5px; letter-spacing:2px; color:${INK_FAINT}; }
  .meta .v { font-weight:600; color:${INK}; }
  .mono { font-family:${MONO_STACK}; letter-spacing:1px; }
  .gold { color:${GOLD}; font-weight:700; }
  table.items { width:100%; border-collapse:collapse; margin-top:8px; }
  table.items th { text-align:left; font-size:10.5px; font-weight:500; letter-spacing:2px; color:${INK_SOFT};
    padding:8px 6px; border-top:1px solid ${GOLD}; border-bottom:1px solid ${GOLD_HAIR}; }
  table.items td { padding:11px 6px; border-bottom:1px solid ${GOLD_FAINT}; vertical-align:top; }
  .num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  table.totals { width:100%; border-collapse:collapse; margin-top:14px; }
  table.totals td { padding:4px 6px; }
  table.totals .grand td { border-top:1px solid ${GOLD}; border-bottom:3px double ${GOLD}; padding:14px 6px;
    font-family:${SERIF_STACK}; font-size:19px; font-weight:700; color:${INK}; }
  table.totals .grand td:first-child { font-size:12px; letter-spacing:2.5px; }
  .box { background:${GOLD_TINT}; border:1px solid ${GOLD_HAIR}; padding:14px 18px; margin-top:20px; }
  .foot { margin-top:28px; padding-top:18px; border-top:1px solid ${GOLD_HAIR};
    text-align:center; font-size:12px; color:${INK_FAINT}; }
  a { color:${GOLD}; text-decoration:none; }
  @media print {
    body { background:#fff; padding:0; }
    .toolbar { display:none; }
    .card { border:none; padding:0; max-width:none; }
    .frame { border:none; padding:0; }
  }
</style>
</head>
<body>
  <div class="toolbar">
    <p>呢張係你嘅訂單單據，可以列印或用瀏覽器「另存為 PDF」收藏。</p>
    <button onclick="window.print()">列印 / 存 PDF</button>
  </div>
  <div class="card">
    <div class="frame">
      <div class="head">
        <img src="${site}/logo.png" alt="RedCode Fashion Design" />
        <div class="doc">
          <h1>訂單單據</h1>
          <p>ORDER INVOICE</p>
        </div>
      </div>
      <hr class="rule" />
      <hr class="rule2" />
      <div class="meta">
        <div><div class="k">訂單編號</div><div class="v mono">${orderNo}</div></div>
        <div><div class="k">落單日期</div><div class="v">${fmtDateHK(args.createdAt)}</div></div>
        <div><div class="k">訂單狀態</div><div class="v"><span class="gold">已確認 ✓</span></div></div>
        <div><div class="k">付款狀態</div><div class="v">已確認付款</div></div>
        ${tierCell}
      </div>
      <div class="box">
        <div class="k" style="font-size:10.5px;letter-spacing:2px;color:${INK_FAINT};">收件資料</div>
        <div style="font-weight:600;color:${INK};">${escapeHtml(args.name)}${args.phone ? ` · ${escapeHtml(args.phone)}` : ""}</div>
        <div>${fmtDeliveryWithVip(args.delivery, args.vip?.shippingFreeLabel)}</div>
      </div>
      <hr />
      <table class="items">
        <tr><th>商品</th><th>尺碼</th><th class="num">數量</th><th class="num">單價</th><th class="num">小計</th></tr>
        ${itemRows}
      </table>
      <table class="totals">
        ${args.discountAmount > 0 ? `<tr><td>小計</td><td class="num">${fmtMoney(subtotal)}</td></tr>` : ""}
        ${vipRow}
        ${discountRow}
        <tr class="grand"><td>應付總額</td><td class="num">${fmtMoney(args.total)}</td></tr>
      </table>
      <hr />
      <p style="margin:0;font-size:13px;color:${INK_SOFT};">
        同事會安排出貨，一般情況下會喺 <b>7-10 個工作天</b>內寄出，請留意收件。<br />
        如有疑問，請到 <a href="${site}">redcode.red</a> 「我的訂單」揾返呢張單。
      </p>
      <div class="foot">
        如非本人操作，則不用理會本電郵。<br />
        呢封電郵由系統自動發出，請唔好直接回覆。<br />
        RedCode Fashion Design · redcode.red
      </div>
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
        <tr><td align="center" style="background:${GOLD_TINT};border:1px solid ${GOLD_HAIR};padding:30px 12px 24px;">
          <span style="font-family:${SERIF_STACK};font-size:38px;font-weight:700;letter-spacing:14px;text-indent:14px;color:${INK};">${escapeHtml(code)}</span>
          <p style="margin:14px 0 0;font-size:12.5px;letter-spacing:1px;color:${INK_SOFT};">有效時間 <b style="color:${GOLD};">10 分鐘</b></p>
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
        kicker: "REDCODE HK直播台 · 帳號安全",
        title: "重設密碼驗證碼",
        contentHtml: content,
      }),
    });
  } catch (e) {
    console.error(`[email] 砌驗證碼信出錯 → ${to}`, e);
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/** ② 落單後：待付款通知（48 小時內付款＋上傳截圖指引；2026-09 F7 加即時網上付款主 CTA） */
export async function sendOrderPendingEmail(args: {
  to: string;
  name: string;
  orderNo: string;
  /** 訂單 id：即時網上付款 CTA 嘅 #/payment?orderId= 連結用 */
  orderId: number;
  total: number;
  discountAmount: number;
  createdAt: Date | string;
  items: OrderEmailItem[];
  /** v2.1.1（Wave 2）：VIP 級別／折扣顯示（optional） */
  vip?: OrderEmailVip;
}): Promise<SendResult> {
  try {
    const orderNo = escapeHtml(args.orderNo);
    const content = `
      <p style="margin:0 0 14px;">你好，${escapeHtml(args.name)}：</p>
      <p style="margin:0;">多謝你喺 RedCode 落單！你嘅訂單已經建立，而家等緊你付款：</p>
      ${infoBox([
        ["訂單編號", mono(orderNo)],
        ["落單時間", fmtDateHK(args.createdAt)],
        ...(args.vip?.tierLabel ? ([["會員級別", `<span style="color:${GOLD};">${escapeHtml(args.vip.tierLabel)}</span>`]] as [string, string][]) : []),
        ["付款期限", `<span style="color:${GOLD};">48 小時內</span>`],
      ])}
      ${itemsTable(args.items)}
      ${totalsBlock(args.total, args.discountAmount, args.vip)}
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
                <span style="font-family:${SERIF_STACK};font-size:16px;font-weight:700;color:${GOLD};">${i + 1}.</span>
              </td>
              <td style="padding:4px 0;font-size:14.5px;line-height:1.75;color:${INK_SOFT};">${t}</td>
            </tr>`,
          )
          .join("")}
      </table>
      ${ctaButton("💳 立即網上付款", `${siteUrl()}/#/payment?orderId=${args.orderId}`)}
      <p style="margin:4px 0 0;text-align:center;font-size:12.5px;line-height:1.9;color:${INK_SOFT};">支援信用卡／AlipayHK／FPS／PayMe，由 Airwallex 安全處理，本站唔會儲存你嘅卡資料。<br />以信用卡或電子錢包付款，支付平台將按所選支付方式收取手續費，最終金額以支付頁顯示為準。</p>
      ${ctaButton("前往「我的訂單」上傳截圖", `${siteUrl()}/#/orders`)}
      ${warnBox("溫馨提示：落單後 <b>2 天（48 小時）</b>仍未付款上傳截圖，訂單會自動取消，貨品會放返出嚟賣。")}
    `;
    return await sendEmail({
      to: args.to,
      subject: `【RedCode】訂單 ${args.orderNo} 待付款 — 請於 48 小時內付款`,
      html: brandedEmail({
        preheader: `訂單 ${orderNo} 待付款，請於 48 小時內付款`,
        kicker: "REDCODE HK直播台 · 待付款通知",
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
  /** v2.1.1（Wave 2）：VIP 級別／折扣／免運標示（optional） */
  vip?: OrderEmailVip;
}): Promise<SendResult> {
  try {
    const orderNo = escapeHtml(args.orderNo);
    const content = `
      <p style="margin:0 0 14px;">你好，${escapeHtml(args.name)}：</p>
      <p style="margin:0;">好消息！你嘅訂單付款已經確認，多謝你支持 RedCode：</p>
      ${infoBox([
        ["訂單編號", mono(orderNo)],
        ["確認時間", fmtDateHK(new Date())],
        ["訂單狀態", `<span style="color:${GOLD};">已確認 ✓</span>`],
        ...(args.vip?.tierLabel ? ([["會員級別", `<span style="color:${GOLD};">${escapeHtml(args.vip.tierLabel)}</span>`]] as [string, string][]) : []),
        ["送貨方式", fmtDeliveryWithVip(args.delivery, args.vip?.shippingFreeLabel)],
      ])}
      ${itemsTable(args.items)}
      ${totalsBlock(args.total, args.discountAmount, args.vip)}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0;">
        <tr><td style="background:${GOLD_TINT};border:1px solid ${GOLD_HAIR};padding:14px 18px;">
          <p style="margin:0;font-size:13px;line-height:1.85;color:${INK};">
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
        kicker: "REDCODE HK直播台 · 訂單確認",
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
          vip: args.vip,
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
 * 「官網訂單審批」處理；跟返官網統一信件格式（brandedEmail 精裝紙單模板）。
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
        ["訂單編號", mono(orderNo)],
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
        kicker: "REDCODE HK直播台 · 訂單審批通知",
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
        <tr><td align="center" style="background:${GOLD_TINT};border:1px solid ${GOLD_HAIR};padding:30px 18px 26px;">
          <p style="margin:0;font-size:10.5px;font-weight:700;letter-spacing:2.5px;color:${INK_FAINT};">新會員限定 · 迎新優惠碼</p>
          <span style="display:block;margin:14px 0 10px;font-family:${SERIF_STACK};font-size:34px;font-weight:700;letter-spacing:8px;text-indent:8px;color:${INK};">WELLCOMEYOU</span>
          <p style="margin:0 0 8px;font-size:15px;color:${INK};">全單 <b style="color:${GOLD};">92 折</b> · 無消費金額門檻</p>
          <p style="margin:0;font-size:12.5px;line-height:1.8;color:${INK_SOFT};">買幾多錢都用得 ✦ 每個帳號限用一次<br />結帳時喺「優惠碼」一欄輸入，折扣即時自動扣減。</p>
        </td></tr>
      </table>
      ${ctaButton("去揀今日嘅靚衫", `${site}/#/products`)}
      <img src="${site}/email/welcome-dress.jpg" alt="今晚直播見" width="390"
        style="display:block;width:78%;max-width:390px;height:auto;margin:26px auto 6px;" />
      ${note(`以後有咩唔明，隨時 WhatsApp <a href="https://wa.me/85254835368" style="color:${GOLD};text-decoration:none;">5483 5368</a> 或者 E-Mail 去 <a href="mailto:service.support@ows.redcode.red" style="color:${GOLD};text-decoration:none;">service.support@ows.redcode.red</a> 搵我哋，Glo Glo 同小幫手會好快覆你 💕`)}
      <p style="margin:18px 0 0;">期待喺直播間見到你 ✦<br />Glo Glo 上</p>
    `;
    return await sendEmail({
      to: args.to,
      subject: "【RedCode】寶寶，歡迎你加入我哋嘅小星球 💕",
      html: brandedEmail({
        preheader: "你嘅迎新優惠碼 WELLCOMEYOU 已經準備好——全單 92 折，無消費金額門檻",
        kicker: "REDCODE HK直播台 · 歡迎加入",
        title: "寶寶，歡迎你呀 ✦",
        contentHtml: content,
      }),
    });
  } catch (e) {
    console.error(`[email] 砌歡迎信出錯 → ${args.to}`, e);
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/**
 * 優惠促銷電郵（2026-08-05 Glo 要求）：後台「促銷電郵」頁用，
 * 只寄畀註冊時剔咗同意接收推廣嘅會員（promo.sendMarketingEmail 把關）。
 *
 * 款同官網其他電郵一樣（brandedEmail 精裝紙單模板）：
 * 內文由員工喺後台撰寫（純文字；空行分段、單行換行變 <br>），
 * 可選加圖（最多 3 張，顯示喺內文下面、優惠碼之前；2026-08-05 Glo 要求），
 * 可選優惠碼用品牌盒突出（同歡迎信嘅優惠碼盒同款），主旨會自動加「【RedCode】」前綴。
 *
 * 合規位（PDPO 第 6A 部＋私隱政策第 7 節承諾）：每封促銷電郵底部一定要話收件人知
 * 可以免費拒絕再收（會員中心「優惠資訊」開關自助停用）——呢段由系統自動附加，員工改唔到。
 */
export async function sendMarketingEmail(args: {
  to: string;
  name: string;
  subject: string; // 員工寫嘅主旨（唔使加【RedCode】，系統會加）
  bodyText: string; // 員工寫嘅內文（純文字；空行分段）
  promoCode?: string; // 選填：優惠碼盒
  imageUrls?: string[]; // 選填：內文下面嘅圖（本站 /uploads/ 相對路徑，會砌成絕對 URL）
}): Promise<SendResult> {
  try {
    const site = siteUrl();
    const paragraphs = args.bodyText
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map(
        (p) =>
          `<p style="margin:0 0 14px;">${escapeHtml(p).replace(/\n/g, "<br />")}</p>`,
      )
      .join("");
    // 圖片（選填，最多 3 張）：順序顯示喺內文下面、優惠碼之前；
    // 電郵 client 要用絕對 URL 先載入到（site + /uploads/xxx）；零圓角（精裝紙單規矩）
    const images = (args.imageUrls ?? [])
      .map(
        (u) =>
          `<div style="margin:20px 0 0;"><img src="${site}${escapeHtml(u)}" alt="RedCode 推廣圖片" width="560" style="display:block;width:100%;max-width:560px;height:auto;" /></div>`,
      )
      .join("");
    const promoBox = args.promoCode
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
        <tr><td align="center" style="background:${GOLD_TINT};border:1px solid ${GOLD_HAIR};padding:26px 18px 22px;">
          <p style="margin:0;font-size:10.5px;font-weight:700;letter-spacing:2.5px;color:${INK_FAINT};">今期優惠碼</p>
          <span style="display:block;margin:12px 0 8px;font-family:${SERIF_STACK};font-size:30px;font-weight:700;letter-spacing:6px;text-indent:6px;color:${INK};">${escapeHtml(args.promoCode)}</span>
          <p style="margin:0;font-size:12.5px;line-height:1.8;color:${INK_SOFT};">結帳時喺「優惠碼」一欄輸入，折扣即時自動扣減。</p>
        </td></tr>
      </table>`
      : "";
    const content = `
      <p style="margin:0 0 14px;">${escapeHtml(args.name)}寶寶，你好呀 💕</p>
      ${paragraphs}
      ${images}
      ${promoBox}
      ${ctaButton("去官網睇新貨", `${site}/#/products`)}
      ${note(`呢封係推廣電郵，你喺註冊時同意咗接收 RedCode 嘅優惠資訊先會收到。如果唔想再收到，隨時可以去我哋官網<a href="${site}/#/account" style="color:${GOLD};text-decoration:none;">會員中心</a>嘅「優惠資訊」停用咗佢，系統會將你喺推廣名單剔除（訂單相關嘅電郵唔受影響）。`)}
      <p style="margin:18px 0 0;">期待喺直播間見到你 ✦<br />Glo Glo 上</p>
    `;
    return await sendEmail({
      to: args.to,
      subject: `【RedCode】${args.subject}`,
      html: brandedEmail({
        preheader: args.bodyText.replace(/\s+/g, " ").slice(0, 90),
        kicker: "REDCODE HK直播台 · 優惠速遞",
        title: args.subject,
        contentHtml: content,
      }),
    });
  } catch (e) {
    console.error(`[email] 砌促銷電郵出錯 → ${args.to}`, e);
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/** ⑥ 訂單自動取消（2026-08-06 Glo 要求）：落單滿 48 小時未上傳付款截圖，系統自動取消後寄出 */
export async function sendOrderCancelledEmail(args: {
  to: string;
  name: string;
  orderNo: string;
  total: number;
  discountAmount: number;
  createdAt: Date | string;
  items: OrderEmailItem[];
  /** v2.1.1（Wave 2）：VIP 級別／折扣顯示（optional） */
  vip?: OrderEmailVip;
}): Promise<SendResult> {
  try {
    const orderNo = escapeHtml(args.orderNo);
    const content = `
      <p style="margin:0 0 14px;">你好，${escapeHtml(args.name)}：</p>
      <p style="margin:0;">你嘅訂單因為落單後超過 <b>48 小時</b>仍未收到付款截圖，系統已經自動取消，貨品已放返出嚟發售：</p>
      ${infoBox([
        ["訂單編號", mono(orderNo)],
        ["落單時間", fmtDateHK(args.createdAt)],
        ...(args.vip?.tierLabel ? ([["會員級別", `<span style="color:${GOLD};">${escapeHtml(args.vip.tierLabel)}</span>`]] as [string, string][]) : []),
        ["取消原因", `<span style="color:${ERROR};">超過 48 小時未收到付款截圖</span>`],
      ])}
      ${itemsTable(args.items)}
      ${totalsBlock(args.total, args.discountAmount, args.vip)}
      <p style="margin:22px 0 0;">如果你其實已經付咗款，請盡快聯絡我哋提供付款證明，同事會幫你跟進；想買返嘅話，亦可以隨時再落單。</p>
      ${ctaButton("再去逛逛", `${siteUrl()}/#/products`)}
      ${note("呢張訂單已經取消，唔使再付款。多謝你對 RedCode 嘅支持 ♥")}
    `;
    return await sendEmail({
      to: args.to,
      subject: `【RedCode】訂單 ${args.orderNo} 已取消 — 超過 48 小時未收到付款截圖`,
      html: brandedEmail({
        preheader: `訂單 ${orderNo} 已取消（超過 48 小時未收到付款截圖）`,
        kicker: "REDCODE HK直播台 · 訂單取消",
        title: "訂單已取消",
        contentHtml: content,
      }),
    });
  } catch (e) {
    console.error(`[email] 砌取消信出錯 → ${args.to}`, e);
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/**
 * ⑦ 網上付款成功確認（2026-09 Airwallex 網上付款新增）：
 * webhook 確認收款成功、訂單轉 payment_review 嗰刻即寄畀客人。
 * 同截圖流程匯合——同事照舊人手確認，確認後會再收到 sendOrderApprovedEmail。
 * never-throw：任何失敗淨係 console.error 兼回 SendResult，唔會阻到 webhook 主流程。
 */
export async function sendOrderPaidOnlineEmail(args: {
  to: string;
  orderNo: string;
  items: OrderEmailItem[];
  total: number;
  delivery: OrderEmailDelivery;
  paidAt: Date;
  /** v2.1.1（Wave 2）：VIP 級別／折扣／免運標示（optional）；discountAmount 呢封信本來冇，VIP 折扣由 vip 參數帶入 */
  vip?: OrderEmailVip & { discountAmount?: number };
}): Promise<SendResult> {
  try {
    const orderNo = escapeHtml(args.orderNo);
    const vipDiscount = args.vip?.discountAmount ?? 0;
    const content = `
      <p style="margin:0 0 14px;">你好：</p>
      <p style="margin:0;">多謝你喺 RedCode 購物！我哋已透過網上付款安全收到你嘅款項 <b>${fmtMoney(args.total)}</b>（付款時間：${fmtDateHK(args.paidAt)}）。同事而家正確認你嘅訂單，確認後你會再收到確認電郵（附訂單單據）。</p>
      ${infoBox([
        ["訂單編號", mono(orderNo)],
        ["付款時間", fmtDateHK(args.paidAt)],
        ["訂單狀態", `<span style="color:${GOLD};">已收款，確認中</span>`],
        ...(args.vip?.tierLabel ? ([["會員級別", `<span style="color:${GOLD};">${escapeHtml(args.vip.tierLabel)}</span>`]] as [string, string][]) : []),
        ["取貨方式", fmtDeliveryWithVip(args.delivery, args.vip?.shippingFreeLabel)],
      ])}
      ${itemsTable(args.items)}
      ${totalsBlock(args.total, vipDiscount, args.vip)}
      ${ctaButton("查看我嘅訂單", `${siteUrl()}/#/orders`)}
      ${note("你嘅付款資料由安全支付平台處理，本站不會儲存信用卡資料，請放心使用。")}
      ${feeDisclaimer()}
    `;
    return await sendEmail({
      to: args.to,
      subject: `【RedCode】訂單 ${args.orderNo} 已收到網上付款 ✓`,
      html: brandedEmail({
        preheader: `訂單 ${orderNo} 已收到你嘅網上付款（${fmtMoney(args.total)}），同事確認中`,
        kicker: "REDCODE HK直播台 · 付款確認",
        title: "已收到你嘅網上付款",
        contentHtml: content,
      }),
    });
  } catch (e) {
    console.error(`[email] 砌網上付款確認信出錯 → ${args.to}`, e);
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/**
 * ⑧ 退款通知（2026-09 F7 WMS↔官網原路退款）：WMS 主管批准退款、官網執行完嗰刻寄畀客人。
 * channel='airwallex'＝已原路退回（信用卡／電子錢包，一般 3–10 個工作天到賬）；
 * channel='manual'＝手動過數單，同事會用原付款方式（FPS／PayMe 等）人手退回。
 * 金額單位：total／refundAmount 都係整數港元（同全站一致，唔乘除 100）。
 * never-throw：任何失敗淨係 console.error 兼回 SendResult（同 sendOrderPaidOnlineEmail 同款），
 * 唔會阻到 refund-callback 主流程。
 */
export async function sendOrderRefundedEmail(args: {
  to: string;
  name: string;
  orderNo: string;
  items: OrderEmailItem[];
  total: number;
  refundAmount: number;
  channel: "airwallex" | "manual";
  refundedAt: Date;
  /** v2.1.1（Wave 2）：VIP 級別／折扣顯示（optional） */
  vip?: OrderEmailVip;
}): Promise<SendResult> {
  try {
    const orderNo = escapeHtml(args.orderNo);
    const refundText = fmtMoney(args.refundAmount);
    const vipDiscount = args.vip?.discountAmount ?? 0;
    const refundLine =
      args.channel === "airwallex"
        ? `你嘅退款 <b>${refundText}</b> 已經原路退回（信用卡／電子錢包），款項一般 3–10 個工作天到賬，實際時間以發卡行／電子錢包為準。`
        : `同事會盡快以你原來嘅付款方式（FPS／PayMe 等）人手退回 <b>${refundText}</b>，請留意收款通知。`;
    const content = `
      <p style="margin:0 0 14px;">你好，${escapeHtml(args.name)}：</p>
      <p style="margin:0;">你嘅訂單 ${mono(orderNo)} 已經取消，我哋已為你安排退款：</p>
      ${infoBox([
        ["訂單編號", mono(orderNo)],
        ["退款金額", `<span style="color:${GOLD};">${refundText}</span>`],
        ...(args.vip?.tierLabel ? ([["會員級別", escapeHtml(args.vip.tierLabel)]] as [string, string][]) : []),
        ["退款方式", args.channel === "airwallex" ? "原路退回（信用卡／電子錢包）" : "人手退款（FPS／PayMe 等）"],
        ["退款時間", fmtDateHK(args.refundedAt)],
      ])}
      <p style="margin:0;">${refundLine}</p>
      ${itemsTable(args.items)}
      ${totalsBlock(args.total, vipDiscount, args.vip)}
      ${ctaButton("查看訂單", `${siteUrl()}/#/orders`)}
      ${note("如有疑問，請到 redcode.red 「我的訂單」揾返呢張單，或者聯絡我哋客服跟進。")}
      ${feeDisclaimer()}
    `;
    return await sendEmail({
      to: args.to,
      subject: `【RedCode】訂單 ${args.orderNo} 退款通知`,
      html: brandedEmail({
        preheader: `訂單 ${orderNo} 已為你安排退款 ${refundText}`,
        kicker: "REDCODE HK直播台 · 退款通知",
        title: "已為你安排退款",
        contentHtml: content,
      }),
    });
  } catch (e) {
    console.error(`[email] 砌退款通知信出錯 → ${args.to}`, e);
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/* ──────────────────── VIP 晉升恭賀信（v2.2.0 個人化恭賀信，2026-09-30） ──────────────────── */

/**
 * VIP 晉升恭賀信（老闆原話：「晉升為vip每一級要收到一封好靚既電郵，要有附件圖片，
 * 係晉升會員恭賀信，email要列明會員期限，簽署係係Gloria。內容要提及客人係有份成就redcode」；
 * v2.2.0 追加：「張相要係一封晉升恭賀信，要有會員編號、客戶電話、客戶名、會員期限，
 * 跟住要有gloria簽名（你整個潦草簽名）」）。
 *
 * ─ 觸發：vip.ts recomputeVipTier 真・升級（NONE→SILVER/GOLD、SILVER→GOLD）＋
 *   membersRouter setVipTier 手動升級；同級續期／降級唔寄。
 * ─ 模板：brandedEmail 精裝紙單；內嵌 ${site}/email/vip-upgrade-{silver,gold}.jpg
 *   （圖放 public/email/，vite build 會抄落 dist/public/email/）；落款有
 *   gloria-sign.png 手寫簽名圖＋「Gloria 上」。
 * ─ 附件（v2.2.0 證書版）：個人化「會員證書」JPG（vipCert.ts 取代 vipLetter.ts——
 *   證書底圖＋客戶名／會員編號／客戶電話／級別／消費成就／生效日期／有效期至／
 *   會員期限／專屬禮遇＋左下 QR 驗證碼＋右下 Gloria 潦草簽名）；
 *   生成失敗（冇 sharp／冇中文字型／回 null）→ 跌落靜態花咭附件；再失敗 → 唔附圖照寄。
 *   無論如何唔准因附件失敗而唔寄。
 * ─ never-throw：同其他 sendXxxEmail 一致。
 */
export async function sendVipUpgradeEmail(args: {
  to: string;
  name: string;
  tier: "SILVER" | "GOLD";
  effectiveAt: Date;
  expiresAt: Date;
  memberNo: string; // v2.2.0：會員編號（RC-000128 款），寫入證書圖＋infoBox
  phone: string | null; // v2.2.0：客戶電話，寫入證書圖
  /** v2.2.0 證書版：呢級嘅年度消費門檻（整數仙，證書顯示時先除 100） */
  thresholdCents: number;
  /** v2.2.0 證書版：會籍期限（月，rules.durationMonths） */
  durationMonths: number;
  /** v2.2.0 證書版：驗證連結（QR 內容，caller 用 buildVipVerifyUrl(siteUrl(), memberNo) 砌） */
  verifyUrl: string;
}): Promise<SendResult> {
  try {
    const site = siteUrl();
    const isGold = args.tier === "GOLD";
    const tierLabel = isGold ? "VIP 金會員" : "VIP 銀會員";
    const imgFile = isGold ? "vip-upgrade-gold.jpg" : "vip-upgrade-silver.jpg";
    // v2.2.0 證書版：附件檔名跟合約「RedCode-會員證書-{金會員|銀會員}-{memberNo}.jpg」
    const attachmentName = `RedCode-會員證書-${isGold ? "金會員" : "銀會員"}-${args.memberNo}.jpg`;
    // 禮遇 recap（同後台 VIP 規則預設一致；改咗規則都係以結帳時為準，信內寫到明）
    const benefits = isGold
      ? ["全年所有訂單 <b>9 折</b>", "全年<b>免運</b>（一件都免，僅限順豐站及自提點）"]
      : ["全年所有訂單 <b>92 折</b>"];

    const content = `
      <p style="margin:0 0 14px;">${escapeHtml(args.name)}寶寶，你好呀 💕</p>
      <p style="margin:0 0 14px;">好開心同你講——你喺 RedCode 嘅累積消費已經達標，由今日起正式晉升做 <b>${tierLabel}</b>！✨</p>
      <p style="margin:0;">RedCode 可以行到今日，係因為有你一路支持——<b>你嘅支持成就咗 RedCode</b>，呢份會員禮遇係我哋小小嘅心意，多謝你陪我哋一齊行 ♥</p>
      <img src="${site}/email/${imgFile}" alt="${tierLabel} 恭賀圖" width="504"
        style="display:block;width:100%;max-width:100%;height:auto;margin:22px 0;" />
      ${infoBox([
        ["會員級別", `<span style="color:${GOLD};">${tierLabel} ✦</span>`],
        ["會員編號", escapeHtml(args.memberNo)],
        ["生效日期", fmtDateHK(args.effectiveAt)],
        ["有效期至", fmtDateHK(args.expiresAt)],
        ["會員期限", "由生效日起計一年"],
      ])}
      <p style="margin:0 0 8px;font-weight:700;color:${INK};">你嘅會員禮遇：</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 0;">
        ${benefits
          .map(
            (b) => `<tr>
              <td style="width:26px;vertical-align:top;padding:4px 0;color:${GOLD};font-weight:700;">✦</td>
              <td style="padding:4px 0;font-size:14.5px;line-height:1.75;color:${INK_SOFT};">${b}</td>
            </tr>`,
          )
          .join("")}
      </table>
      ${note("期限內級別唔會降；到期後會按你嗰年嘅消費重新判定。實際折扣同免運規則以結帳時官網顯示為準。")}
      ${ctaButton("睇我嘅會員制度", `${site}/#/vip`)}
      <p style="margin:22px 0 0;">多謝你 ♥</p>
      <img src="${site}/email/gloria-sign.png" alt="Gloria 簽名" width="168"
        style="display:block;width:168px;height:auto;margin:10px 0 2px;" />
      <p style="margin:0;">Gloria 上</p>
    `;

    // v2.2.0 證書版：附件 = 個人化「會員證書」（vipCert.ts 用 sharp 即場畫：客戶名／
    // 會員編號／電話／級別／消費成就／生效／到期／期限／禮遇＋QR 驗證碼＋Gloria 潦草簽名）。
    // buildVipCertJpeg never-throw（失敗回 null）；呢度照包 try 防意外，
    // 證書返 null／出錯 → 跌落靜態花咭附件；再失敗 → 唔附圖照寄。
    // 無論如何唔准因附件失敗而唔寄。
    let attachments: { filename: string; content: string }[] | undefined;
    try {
      const cert = await buildVipCertJpeg({
        name: args.name,
        memberNo: args.memberNo,
        phone: args.phone,
        tier: args.tier,
        effectiveAt: args.effectiveAt,
        expiresAt: args.expiresAt,
        thresholdCents: args.thresholdCents,
        durationMonths: args.durationMonths,
        verifyUrl: args.verifyUrl || buildVipVerifyUrl(site, args.memberNo),
      });
      if (cert) {
        attachments = [{ filename: attachmentName, content: cert.toString("base64") }];
      }
    } catch (e) {
      console.warn("[email] 個人化會員證書生成出錯，試跌落靜態花咭:", e);
    }
    if (!attachments) {
      try {
        const candidates = [
          path.resolve(process.cwd(), "dist/public/email", imgFile),
          path.resolve(process.cwd(), "public/email", imgFile),
          path.resolve(import.meta.dirname, "../dist/public/email", imgFile),
          path.resolve(import.meta.dirname, "../../dist/public/email", imgFile),
          path.resolve(import.meta.dirname, "../public/email", imgFile),
        ];
        const found = candidates.find((p) => fs.existsSync(p));
        if (found) {
          const fallbackName = isGold ? "RedCode-VIP-gold.jpg" : "RedCode-VIP-silver.jpg";
          attachments = [{ filename: fallbackName, content: fs.readFileSync(found).toString("base64") }];
          console.warn(`[email] 個人化會員證書整唔到，今次用靜態花咭附件（${imgFile}）`);
        } else {
          console.warn(`[email] VIP 恭賀圖附件搵唔到（${imgFile}），照寄唔附圖；試過嘅路徑：${candidates.join(" , ")}`);
        }
      } catch (e) {
        console.warn(`[email] 讀 VIP 恭賀圖附件失敗（${imgFile}），照寄唔附圖:`, e);
      }
    }

    return await sendEmail({
      to: args.to,
      subject: `【RedCode】恭賀你晉升 ${tierLabel} ✦`,
      html: brandedEmail({
        preheader: `恭賀你晉升 RedCode ${tierLabel}——你嘅支持成就咗 RedCode ♥`,
        kicker: "REDCODE HK直播台 · 會員晉升",
        title: `恭賀晉升 ${tierLabel} ✦`,
        contentHtml: content,
      }),
      attachments,
    });
  } catch (e) {
    console.error(`[email] 砌 VIP 晉升信出錯 → ${args.to}`, e);
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}
