/**
 * VIP 會員證書「個人化圖片／PDF」生成器（v2.2.0，取代 vipLetter.ts 成為正式證書引擎）
 * ─────────────────────────────
 * 做法：以 public/email/vip-cert-{silver,gold}.jpg（1024×1536）證書底圖做底，
 * SVG 疊上個人化文字（客戶名／會員編號／電話／級別／消費成就／生效／到期／期限／禮遇）
 * ＋ 左下角驗證 QR（內容係帶 HMAC 簽名嘅 /#/vip-verify 連結）
 * ＋ 右下角 Gloria 手寫簽名（gloria-sign.png，透明底）＋落款，
 * 再用 sharp composite 輸出 JPG；PDF 就用 pdf-lib 將 JPG 嵌入 A4 直向一頁。
 *
 * 排版安全區（CONTRACTS-v2.2.0 §3，已用 PIL luminance 驗證底圖）：
 * ─ 主文字限 x232–792；頂部月桂環（金款環尾伸到 y400，已實測），文字由 y435 起
 * ─ 左下火漆印＋絲帶 x30–330／y1080–1500 → QR 擺 x180–330 區，墊象牙色底板（零圓角）保證可掃
 * ─ 右下花飾 x>850∧y>1350 要避 → 簽名圖 x624–840／y1216–1314，落款右緣唔超過 x845
 *
 * 依賴與部署（同 vipLetter 一致）：
 * - sharp／qrcode／pdf-lib 全部動態 import，裝唔到只係 console.warn 兼回 null，唔阻主流程。
 * - Docker 已裝 fonts-noto-cjk；SVG 字型栈 'Noto Serif CJK TC','Noto Sans CJK TC',serif；中文唔准 italic。
 * - 證書零圓角（老闆鐵律）。
 *
 * 全部 builder never-throw：任何一步失敗都回 null。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type VipCertArgs = {
  name: string; // 客戶名
  memberNo: string; // 會員編號（RC-000128 款）
  phone: string | null; // 客戶電話
  tier: "SILVER" | "GOLD";
  effectiveAt: Date;
  expiresAt: Date;
  thresholdCents: number; // 呢級嘅消費門檻（銀=rules.silverThresholdCents）
  durationMonths: number; // rules.durationMonths
  verifyUrl: string; // QR 內容
};

/** 同 email.ts／vipLetter.ts 嘅候選路徑邏輯：production 靜態喺 ./dist/public，dev 喺 ./public */
function findEmailAsset(filename: string): string | null {
  const candidates = [
    path.resolve(process.cwd(), "dist/public/email", filename),
    path.resolve(process.cwd(), "public/email", filename),
    path.resolve(import.meta.dirname, "../dist/public/email", filename),
    path.resolve(import.meta.dirname, "../../dist/public/email", filename),
    path.resolve(import.meta.dirname, "../public/email", filename),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function readDataUri(file: string, mime: string): string | null {
  try {
    return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
  } catch {
    return null;
  }
}

/** SVG 文字 escape（XML 規則） */
function xe(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 香港時間日期：2026年9月30日 */
function fmtDate(d: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("zh-HK", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(d);
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${g("year")}年${g("month")}月${g("day")}日`;
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** 香港時間年份（消費成就行用） */
function hktYear(d: Date): number {
  try {
    return Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Hong_Kong",
        year: "numeric",
      }).format(d),
    );
  } catch {
    return d.getUTCFullYear();
  }
}

/** 電話顯示：8 位數加空格（9123 4567），其他原样 */
function fmtPhone(p: string | null): string {
  if (!p) return "—";
  const digits = p.replace(/\D/g, "");
  if (digits.length === 8) return `${digits.slice(0, 4)} ${digits.slice(4)}`;
  return p;
}

/** 仙 → 「HK$3,000」款（顯示先除 100，千位 comma） */
function fmtHkd(cents: number): string {
  const dollars = Math.round(cents / 100);
  return `HK$${String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** 證書配色（同精裝紙單／恭賀信一致） */
const INK = "#2a160d";
const GOLD = "#8a6d1f";
const SOFT = "#6b5847";
const IVORY = "#f7efdd"; // QR 底板色（貼近底圖奶油紙色，零圓角）

/**
 * HMAC-SHA256("vip-cert:"+memberNo, JWT_SECRET) hex 簽名。
 * secret 缺失／任何錯都回空字串（verifyVipCert 會比對失敗回 ok:false，唔會洩漏）。
 */
export function signVipCertMemberNo(memberNo: string): string {
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) return "";
    return crypto.createHmac("sha256", secret).update(`vip-cert:${memberNo}`).digest("hex");
  } catch {
    return "";
  }
}

/**
 * 砌驗證連結（QR 內容）：siteUrl 去尾 slash → `${site}/#/vip-verify?c=...&s=...`。
 * 唔會 throw；冇 secret 時 s 係空串（驗證嗰邊會 ok:false，屬安全失敗）。
 */
export function buildVipVerifyUrl(siteUrl: string, memberNo: string): string {
  try {
    const site = (siteUrl || "").replace(/\/+$/, "");
    return `${site}/#/vip-verify?c=${encodeURIComponent(memberNo)}&s=${signVipCertMemberNo(memberNo)}`;
  } catch {
    return "";
  }
}

/** 驗證 QR（PNG data URI，320×320，EC level M，零 margin）；失敗回 null */
async function buildQrDataUri(verifyUrl: string): Promise<string | null> {
  try {
    const QRCode = (await import("qrcode")).default;
    return await QRCode.toDataURL(verifyUrl, {
      errorCorrectionLevel: "M",
      margin: 0,
      width: 320,
    });
  } catch (e) {
    console.warn("[vipCert] 生成驗證 QR 失敗:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * 砌證書 SVG overlay（1024×1536，透明底；底圖由 sharp composite 墊底）。
 * 版面：頂部月桂環下 y435 起 header → 級別 → 茲證明＋名 → 消費成就（金字）→
 * 六行資料（y902 起，行距 40）→ 左下 QR＋「掃描驗證會員狀態」→ 右下 Gloria 簽名＋落款。
 */
function buildCertSvg(
  args: VipCertArgs,
  qrDataUri: string | null,
  signDataUri: string | null,
): string {
  const isGold = args.tier === "GOLD";
  const tierLabel = isGold ? "VIP 金會員" : "VIP 銀會員";
  // 禮遇字串要短，長句會撞左邊 label（同 vipLetter 實測一致）
  const benefit = isGold ? "全年 9 折・全年免運（順豐站／自提點）" : "全年所有訂單 92 折";
  const F = "'Noto Serif CJK TC','Noto Sans CJK TC',serif";
  const name = xe(args.name);
  const achievement = `憑 ${hktYear(args.effectiveAt)} 年度消費滿 ${fmtHkd(args.thresholdCents)} 晉升`;
  // [label, value, value 字號]——專屬禮遇行字號收細，等長句都唔會撞 label
  const infoRows: [string, string, number][] = [
    ["會員編號", xe(args.memberNo), 23],
    ["客戶電話", xe(fmtPhone(args.phone)), 23],
    ["生效日期", fmtDate(args.effectiveAt), 23],
    ["有效期至", fmtDate(args.expiresAt), 23],
    ["會員期限", `由生效日起計 ${args.durationMonths} 個月`, 23],
    ["專屬禮遇", benefit, 19],
  ];
  const infoSvg = infoRows
    .map((row, i) => {
      const y = 902 + i * 40;
      return `
    <text x="232" y="${y}" font-family="${F}" font-size="21" fill="${SOFT}" letter-spacing="3">${row[0]}</text>
    <text x="792" y="${y}" text-anchor="end" font-family="${F}" font-size="${row[2]}" font-weight="600" fill="${INK}">${row[1]}</text>
    <line x1="232" y1="${y + 14}" x2="792" y2="${y + 14}" stroke="${GOLD}" stroke-opacity="0.28" stroke-width="1"/>`;
    })
    .join("");
  // QR：象牙色底板（零圓角）＋金線框＋QR＋說明字；擺左下 x180–330 區，墊底板隔開火漆印絲帶保證可掃
  const qrSvg = qrDataUri
    ? `
    <rect x="170" y="1256" width="176" height="188" fill="${IVORY}" fill-opacity="0.96" stroke="${GOLD}" stroke-opacity="0.55" stroke-width="1"/>
    <image href="${qrDataUri}" x="186" y="1268" width="144" height="144"/>
    <text x="258" y="1434" text-anchor="middle" font-family="${F}" font-size="14" fill="${SOFT}" letter-spacing="2">掃描驗證會員狀態</text>`
    : "";
  // Gloria 簽名＋落款：右下，避開 x>850∧y>1350 花飾；簽名線同落款右緣唔過 x845
  const signSvg = signDataUri
    ? `<image href="${signDataUri}" x="624" y="1216" width="216" height="98" preserveAspectRatio="xMidYMid meet"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1536" viewBox="0 0 1024 1536">
  <text x="512" y="435" text-anchor="middle" font-family="${F}" font-size="22" fill="${GOLD}" letter-spacing="10">CERTIFICATE OF MEMBERSHIP</text>
  <text x="512" y="499" text-anchor="middle" font-family="${F}" font-size="44" font-weight="700" fill="${INK}" letter-spacing="6">RedCode 會員證書</text>
  <line x1="342" y1="529" x2="682" y2="529" stroke="${GOLD}" stroke-width="1.6"/>
  <line x1="342" y1="535" x2="682" y2="535" stroke="${GOLD}" stroke-opacity="0.45" stroke-width="1"/>
  <text x="512" y="597" text-anchor="middle" font-family="${F}" font-size="16" fill="${SOFT}" letter-spacing="8">會員級別</text>
  <text x="512" y="657" text-anchor="middle" font-family="${F}" font-size="50" font-weight="700" fill="${GOLD}" letter-spacing="8">${tierLabel} ✦</text>
  <text x="512" y="727" text-anchor="middle" font-family="${F}" font-size="22" fill="${SOFT}" letter-spacing="6">茲證明</text>
  <text x="512" y="781" text-anchor="middle" font-family="${F}" font-size="38" font-weight="700" fill="${INK}" letter-spacing="4">${name} 寶寶</text>
  <text x="512" y="835" text-anchor="middle" font-family="${F}" font-size="24" font-weight="700" fill="${GOLD}" letter-spacing="2">${xe(achievement)}</text>
  ${infoSvg}
  ${qrSvg}
  ${signSvg}
  <line x1="632" y1="1336" x2="832" y2="1336" stroke="${SOFT}" stroke-opacity="0.6" stroke-width="1"/>
  <text x="732" y="1362" text-anchor="middle" font-family="${F}" font-size="16" fill="${INK}" letter-spacing="2">Gloria 上・RedCode 創辦人</text>
</svg>`;
}

/**
 * 生成個人化會員證書 JPG（回 Buffer；失敗回 null）。
 * sharp 用動態 import——未安裝（舊部署）唔會炸，caller 會回 ok:false。
 */
export async function buildVipCertJpeg(args: VipCertArgs): Promise<Buffer | null> {
  try {
    const bgFile = findEmailAsset(args.tier === "GOLD" ? "vip-cert-gold.jpg" : "vip-cert-silver.jpg");
    if (!bgFile) {
      console.warn("[vipCert] 搵唔到證書底圖，跳過證書生成");
      return null;
    }
    const signFile = findEmailAsset("gloria-sign.png");
    const sign = signFile ? readDataUri(signFile, "image/png") : null;
    if (!sign) console.warn("[vipCert] 搵唔到 gloria-sign.png，證書會冇簽名圖");
    const qr = args.verifyUrl ? await buildQrDataUri(args.verifyUrl) : null;
    if (!qr) console.warn("[vipCert] 驗證 QR 生成失敗，證書會冇 QR");
    const svg = Buffer.from(buildCertSvg(args, qr, sign), "utf8");
    const sharp = (await import("sharp")).default;
    // composite：底圖墊底，SVG overlay 疊上（零圓角，全幅輸出）
    return await sharp(bgFile)
      .composite([{ input: svg, top: 0, left: 0 }])
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
  } catch (e) {
    console.warn("[vipCert] 生成會員證書 JPG 失敗:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * 生成個人化會員證書 PDF（A4 直向一頁，pdf-lib embedJpg 包 JPG；失敗回 null）。
 * 證書係 2:3（1024×1536），A4 直向 595.28×841.89pt：按高度填滿、左右置中留窄白邊。
 */
export async function buildVipCertPdf(args: VipCertArgs): Promise<Buffer | null> {
  try {
    const jpg = await buildVipCertJpeg(args);
    if (!jpg) return null;
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]); // A4 直向
    const img = await doc.embedJpg(jpg);
    const h = 841.89;
    const w = (img.width / img.height) * h;
    page.drawImage(img, { x: (595.28 - w) / 2, y: 0, width: w, height: h });
    return Buffer.from(await doc.save());
  } catch (e) {
    console.warn("[vipCert] 生成會員證書 PDF 失敗:", e instanceof Error ? e.message : e);
    return null;
  }
}
