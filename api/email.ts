/**
 * RedCode 寄信基建（2026-08-04）
 * --------------------------------
 * 用 Resend REST API 直 call（fetch），零新 npm dependency，唔會影響 Docker build。
 *
 * Render 要設嘅環境變數：
 * - RESEND_API_KEY：Resend 攞嘅 API key（冇設＝全部 email 靜默 skip，網站照常運作）
 * - EMAIL_FROM：寄件人，例如 `RedCode官方購物網站 <noreply@ows.redcode.red>`（域名要喺 Resend 驗證咗先用得）
 * - SITE_URL：網站地址，預設 https://redcode.red（email 入面 logo 同掣嘅連結用）
 *
 * 所有 sendXxxEmail 都係 never-throw：失敗淨係 console.error 兼回 false，唔會阻到主流程。
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const BRAND_PINK = "#e6007e";
const INK = "#2a2230";
const MUTED = "#8a7f92";
const FAINT = "#b3a8ba";

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'PingFang HK','PingFang TC','Microsoft JhengHei','Noto Sans TC',sans-serif";

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

/** 底層寄信：冇 API key 靜默 skip；任何失敗回 false，絕對唔會 throw */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[email] RESEND_API_KEY 未設定，略過寄信：「${opts.subject}」→ ${opts.to}`);
    return false;
  }
  const from = process.env.EMAIL_FROM || "RedCode官方購物網站 <noreply@ows.redcode.red>";
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: opts.to, subject: opts.subject, html: opts.html }),
    });
    if (!res.ok) {
      console.error(`[email] 寄信失敗（${res.status}）：「${opts.subject}」→ ${opts.to}`, await res.text());
      return false;
    }
    console.log(`[email] 已寄出：「${opts.subject}」→ ${opts.to}`);
    return true;
  } catch (e) {
    console.error(`[email] 寄信錯誤：「${opts.subject}」→ ${opts.to}`, e);
    return false;
  }
}

/**
 * 品牌模板（每封 email 共用）：
 * 白底圓角卡片＋頂部 RedCode logo＋粉紅主色，尾部署名＋免責聲明。
 * Email client 兼容做法：table 排版＋全部 inline CSS。
 * 免責聲明（老闆要求）：每封都有「如非本人操作，則不用理會本電郵。」
 */
function brandedEmail(preheader: string, title: string, contentHtml: string): string {
  const site = siteUrl();
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f2f8;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f2f8;">
<tr><td align="center" style="padding:36px 16px 28px;">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;">
    <tr>
      <td align="center" style="padding:0 0 22px;">
        <img src="${site}/logo.png" alt="RedCode Fashion Design" width="210"
          style="display:block;width:210px;max-width:65%;height:auto;border-radius:14px;" />
      </td>
    </tr>
    <tr>
      <td style="background:#ffffff;border:1px solid #f0e4f4;border-radius:18px;padding:34px 30px 30px;">
        <h1 style="margin:0 0 18px;font-family:${FONT_STACK};font-size:22px;line-height:1.4;color:${INK};font-weight:700;">${escapeHtml(title)}</h1>
        <div style="font-family:${FONT_STACK};font-size:15px;line-height:1.85;color:${INK};">
          ${contentHtml}
        </div>
      </td>
    </tr>
    <tr>
      <td align="center" style="padding:22px 12px 0;">
        <p style="margin:0 0 8px;font-family:${FONT_STACK};font-size:12.5px;line-height:1.8;color:${MUTED};">如非本人操作，則不用理會本電郵。</p>
        <p style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.8;color:${FAINT};">
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

/** 內容小組件：資料盒（訂單編號／金額嗰類） */
function infoBox(rows: [string, string][]): string {
  const trs = rows
    .map(
      ([k, v]) => `<tr>
        <td style="padding:7px 0;font-size:14px;color:${MUTED};vertical-align:top;width:96px;">${k}</td>
        <td style="padding:7px 0;font-size:14.5px;color:${INK};font-weight:600;">${v}</td>
      </tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
    style="margin:18px 0;background:#fdf4fa;border:1px solid #f6dff0;border-radius:14px;padding:8px 18px;">${trs}</table>`;
}

/** 內容小組件：粉紅大掣 */
function ctaButton(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto 6px;">
    <tr><td align="center" style="background:${BRAND_PINK};border-radius:999px;">
      <a href="${href}" style="display:inline-block;padding:13px 34px;font-family:${FONT_STACK};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}

/** 內容小組件：溫馨提示（細字、灰紫） */
function note(text: string): string {
  return `<p style="margin:16px 0 0;font-size:13px;line-height:1.8;color:${MUTED};">${text}</p>`;
}

/* ───────────────────────── 三封 transactional email ───────────────────────── */

/** ① 忘記密碼：6 位驗證碼（10 分鐘有效） */
export async function sendPasswordResetEmail(
  to: string,
  code: string,
  name?: string | null,
): Promise<boolean> {
  const greeting = name ? `你好，${escapeHtml(name)}：` : "你好：";
  const content = `
    <p style="margin:0 0 14px;">${greeting}</p>
    <p style="margin:0 0 6px;">我哋收到你重設密碼嘅要求，你嘅驗證碼係：</p>
    <div style="margin:20px 0;padding:20px 0;background:#fdf4fa;border:1px solid #f6dff0;border-radius:14px;text-align:center;">
      <span style="font-size:34px;font-weight:800;letter-spacing:10px;color:${BRAND_PINK};">${escapeHtml(code)}</span>
    </div>
    <p style="margin:0;">驗證碼 <b>10 分鐘</b>內有效，請返到登入頁輸入驗證碼同設定新密碼；過咗時效就要重新寄出。</p>
    ${note("溫馨提示：驗證碼唔好話俾任何人知，RedCode 職員絕對唔會向你索取驗證碼。")}
  `;
  return sendEmail({
    to,
    subject: "【RedCode】重設密碼驗證碼",
    html: brandedEmail("你嘅 RedCode 重設密碼驗證碼", "重設密碼驗證碼", content),
  });
}

/** ② 落單後：待付款通知（48 小時內付款＋上傳截圖指引） */
export async function sendOrderPendingEmail(args: {
  to: string;
  name: string;
  orderNo: string;
  total: number;
}): Promise<boolean> {
  const orderNo = escapeHtml(args.orderNo);
  const content = `
    <p style="margin:0 0 14px;">你好，${escapeHtml(args.name)}：</p>
    <p style="margin:0;">多謝你喺 RedCode 落單！你嘅訂單已經建立，而家等緊你付款：</p>
    ${infoBox([
      ["訂單編號", orderNo],
      ["應付金額", `HK$${args.total}`],
      ["付款期限", `<span style="color:${BRAND_PINK};">48 小時內</span>`],
    ])}
    <p style="margin:0 0 8px;font-weight:700;">付款之後，記得做埋呢步先算完成：</p>
    <ol style="margin:0;padding-left:22px;">
      <li style="margin:0 0 6px;">登入 redcode.red，入去「<b>我的訂單</b>」揾返呢張單</li>
      <li style="margin:0 0 6px;">上傳<b>付款截圖或單據</b></li>
      <li style="margin:0;">上傳後工作人員會盡快審批，批咗你會再收到確認電郵</li>
    </ol>
    ${ctaButton("前往「我的訂單」", `${siteUrl()}/#/orders`)}
    ${note(`溫馨提示：落單後 <b>2 天（48 小時）</b>仍未付款上傳截圖，訂單會自動取消，貨品會放返出嚟賣。`)}
  `;
  return sendEmail({
    to: args.to,
    subject: `【RedCode】訂單 ${args.orderNo} 待付款 — 請於 48 小時內付款`,
    html: brandedEmail(`訂單 ${orderNo} 待付款，請於 48 小時內付款`, "訂單待付款", content),
  });
}

/** ③ 審批通過後：訂單已確認（7-10 個工作天寄出） */
export async function sendOrderApprovedEmail(args: {
  to: string;
  name: string;
  orderNo: string;
}): Promise<boolean> {
  const orderNo = escapeHtml(args.orderNo);
  const content = `
    <p style="margin:0 0 14px;">你好，${escapeHtml(args.name)}：</p>
    <p style="margin:0;">好消息！你嘅訂單付款已經確認，多謝你支持 RedCode：</p>
    ${infoBox([
      ["訂單編號", orderNo],
      ["訂單狀態", `<span style="color:${BRAND_PINK};">已確認 ✓</span>`],
    ])}
    <p style="margin:0;">同事將安排出貨，一般情況下會喺 <b>7-10 個工作天</b>內寄出，請留意收件。</p>
    ${ctaButton("查看我嘅訂單", `${siteUrl()}/#/orders`)}
  `;
  return sendEmail({
    to: args.to,
    subject: `【RedCode】訂單 ${args.orderNo} 已確認 ✓`,
    html: brandedEmail(`訂單 ${orderNo} 已確認`, "訂單已確認", content),
  });
}
