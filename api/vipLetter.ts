/**
 * VIP 晉升恭賀信「個人化圖片」生成器（v2.2.0，2026-09-30 老闆要求）
 * ─────────────────────────────
 * 老闆原話：「晉升email張相唔係一封晉升恭賀信？無會員編號，無客戶電話，
 * 我都話要好靚既恭賀信，跟住要有gloria簽名（你整個潦草簽名），要有埋會員期限，客戶名等等」
 *
 * 做法：以 public/email/vip-upgrade-{silver,gold}.jpg 花咭做底，SVG 疊上
 * 個人化文字（客戶名／會員編號／電話／級別／生效／到期／期限／禮遇）＋
 * Gloria 手寫潦草簽名（gloria-sign.png，透明底），再用 sharp 將 SVG 輸出做 JPG 附件。
 *
 * 依賴與部署：
 * - 需要 package.json 嘅 sharp（SVG→JPG 輸出）；sharp 用動態 import，裝唔到／輸出失敗
 *   只係 console.warn 兼回 null（email.ts 會跌落静态花咭附件，信照寄）。
 * - Docker 要裝中文字型先畫到字：Dockerfile 已加 fonts-noto-cjk（否則中文會變豆腐格）。
 * - 字型栈用 'Noto Serif CJK TC'（容器嘅 fonts-noto-cjk 有齊）。
 *
 * 全部 never-throw：任何一步失敗都回 null，絕對唔阻升級主流程。
 */

import fs from "node:fs";
import path from "node:path";

export type VipLetterArgs = {
  name: string; // 客戶名
  memberNo: string; // 會員編號（RC-000128 款）
  phone: string | null; // 客戶電話
  tier: "SILVER" | "GOLD";
  effectiveAt: Date;
  expiresAt: Date;
};

/** 同 email.ts 嘅候選路徑邏輯：production 靜態喺 ./dist/public，dev 喺 ./public */
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

/** 電話顯示：8 位數加空格（9123 4567），其他原样 */
function fmtPhone(p: string | null): string {
  if (!p) return "—";
  const digits = p.replace(/\D/g, "");
  if (digits.length === 8) return `${digits.slice(0, 4)} ${digits.slice(4)}`;
  return p;
}

/** 恭賀信配色（同精裝紙單一致） */
const INK = "#2a160d";
const GOLD = "#8a6d1f";
const SOFT = "#6b5847";

/**
 * 砌恭賀信 SVG（1024×1536，同底圖一致）。
 * 版面對應花咭空位：花環結下方約 y700 起；資料行 y1022 起步（行距 38，六行到 y1212）；
 * 簽名擺右下角（x648–928，y1246–1373），落款 x742 置中（避開金咭右下角花飾 x850+）。
 */
function buildLetterSvg(args: VipLetterArgs, bgDataUri: string, signDataUri: string | null): string {
  const isGold = args.tier === "GOLD";
  const tierLabel = isGold ? "VIP 金會員" : "VIP 銀會員";
  // 禮遇字串要短——金會員嗰句太長會撞左邊 label（實測 23px 會由 x792 伸返去 x330）
  const benefit = isGold ? "全年 9 折・全年免運（順豐站／自提點）" : "全年所有訂單 92 折";
  const F = "'Noto Serif CJK TC','Noto Sans CJK TC',serif";
  const name = xe(args.name);
  // [label, value, value 字號]——專屬禮遇行字號收細，等長句都唔會撞 label
  const infoRows: [string, string, number][] = [
    ["會員編號", xe(args.memberNo), 23],
    ["客戶電話", xe(fmtPhone(args.phone)), 23],
    ["生效日期", fmtDate(args.effectiveAt), 23],
    ["有效期至", fmtDate(args.expiresAt), 23],
    ["會員期限", "由生效日起計一年", 23],
    ["專屬禮遇", benefit, 19],
  ];
  const infoSvg = infoRows
    .map((row, i) => {
      const y = 1022 + i * 38;
      return `
    <text x="232" y="${y}" font-family="${F}" font-size="21" fill="${SOFT}" letter-spacing="3">${row[0]}</text>
    <text x="792" y="${y}" text-anchor="end" font-family="${F}" font-size="${row[2]}" font-weight="600" fill="${INK}">${row[1]}</text>
    <line x1="232" y1="${y + 13}" x2="792" y2="${y + 13}" stroke="${GOLD}" stroke-opacity="0.28" stroke-width="1"/>`;
    })
    .join("");
  const signSvg = signDataUri
    ? `<image href="${signDataUri}" x="648" y="1246" width="280" height="127" preserveAspectRatio="xMidYMid meet"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1536" viewBox="0 0 1024 1536">
  <image href="${bgDataUri}" x="0" y="0" width="1024" height="1536" preserveAspectRatio="xMidYMid slice"/>
  <text x="512" y="720" text-anchor="middle" font-family="${F}" font-size="25" fill="${GOLD}" letter-spacing="12">會員晉升恭賀信</text>
  <text x="512" y="788" text-anchor="middle" font-family="${F}" font-size="58" font-weight="700" fill="${INK}" letter-spacing="12">恭賀晉升</text>
  <text x="512" y="848" text-anchor="middle" font-family="${F}" font-size="40" font-weight="700" fill="${GOLD}" letter-spacing="6">${tierLabel} ✦</text>
  <line x1="342" y1="874" x2="682" y2="874" stroke="${GOLD}" stroke-width="1.6"/>
  <line x1="342" y1="880" x2="682" y2="880" stroke="${GOLD}" stroke-opacity="0.45" stroke-width="1"/>
  <text x="512" y="938" text-anchor="middle" font-family="${F}" font-size="30" font-weight="600" fill="${INK}">${name} 寶寶：</text>
  <text x="512" y="980" text-anchor="middle" font-family="${F}" font-size="22.5" fill="${SOFT}">多謝你一路支持——你嘅支持成就咗 RedCode ♥</text>
  ${infoSvg}
  ${signSvg}
  <text x="660" y="1410" text-anchor="middle" font-family="${F}" font-size="20" fill="${INK}" letter-spacing="4">Gloria 上</text>
  <text x="660" y="1436" text-anchor="middle" font-family="${F}" font-size="15" fill="${SOFT}" letter-spacing="3">RedCode 創辦人</text>
</svg>`;
}

/**
 * 生成個人化恭賀信 JPG（回 Buffer；失敗回 null）。
 * sharp 用動態 import——未安裝（舊部署）唔會炸，只係冇個人化信（email.ts 跌落静态花咭附件）。
 */
export async function buildVipLetterJpeg(args: VipLetterArgs): Promise<Buffer | null> {
  try {
    const bgFile = findEmailAsset(args.tier === "GOLD" ? "vip-upgrade-gold.jpg" : "vip-upgrade-silver.jpg");
    if (!bgFile) {
      console.warn("[vipLetter] 搵唔到恭賀信底圖，跳過個人化信生成");
      return null;
    }
    const bg = readDataUri(bgFile, "image/jpeg");
    if (!bg) return null;
    const signFile = findEmailAsset("gloria-sign.png");
    const sign = signFile ? readDataUri(signFile, "image/png") : null;
    if (!sign) console.warn("[vipLetter] 搵唔到 gloria-sign.png，恭賀信會冇簽名圖");
    const svg = Buffer.from(buildLetterSvg(args, bg, sign), "utf8");
    const sharp = (await import("sharp")).default;
    return await sharp(svg, { density: 96 }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  } catch (e) {
    console.warn("[vipLetter] 生成個人化恭賀信失敗（唔阻寄信）:", e instanceof Error ? e.message : e);
    return null;
  }
}
