/**
 * 網站設計訂單圖生成器（v2026.11.09）：落單即產生正式 server-side PNG 訂單圖。
 * 做法同 api/vipCert.ts 一款：SVG 排版 → sharp 輸出 PNG；
 * Docker 已裝 fonts-noto-cjk（Noto Sans/Serif CJK TC），中文唔會豆腐格。
 *
 * 規格（交付凍結）：
 * - 1200 闊、一般 1600 高（內容多自動加高），白紙卡風格；中文字型可讀。
 * - 內容：方案、全部功能快照、要求、風格、一次性、首月／其後月費、總額、客名、電話、單號、日期。
 * - 檔名隨機不可猜（randomUUID），落 UPLOAD_DIR，經 /uploads/:file 公開可睇（WMS 要拉到）。
 * - 失敗要 loud：呢度 throw，caller（createOrder）會中止落單，唔准回成功＋null。
 */
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { planLabel, type WebDesignPlan } from "@contracts/webDesign";
import type { WebDesignPricedItem } from "./webDesignCore";

export const ORDER_IMAGE_WIDTH = 1200;
export const ORDER_IMAGE_HEIGHT = 1600;

const FONT = "'Noto Sans CJK TC','Noto Serif CJK TC',sans-serif";
const INK = "#2b2620";
const SOFT = "#8a8073";
const GOLD = "#b08d4f";
const LINE = "#d9cfbf";

/** SVG 文字 escape（XML 規則） */
function xe(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 估算字寬：CJK 全形＝fontSize；其餘約 0.56em（同 email.ts estTextWidth 口徑） */
function estWidth(s: string, fontSize: number): number {
  let w = 0;
  for (const ch of s) {
    w += ch.codePointAt(0)! > 0x2e7f ? fontSize : fontSize * 0.56;
  }
  return w;
}

/** 簡單按闊度折行（CJK 適用），最多 maxLines 行，超出尾行加 … */
function wrapText(s: string, fontSize: number, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const rawLine of s.split("\n")) {
    for (const ch of rawLine) {
      if (estWidth(cur + ch, fontSize) > maxWidth) {
        lines.push(cur);
        cur = ch;
        if (lines.length >= maxLines) break;
      } else {
        cur += ch;
      }
    }
    if (lines.length >= maxLines) break;
    if (cur) {
      lines.push(cur);
      cur = "";
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length > maxLines) lines.length = maxLines;
  // 判斷有冇截斷：拼返嚟同原文唔同就加省略
  if (lines.join("").length < s.replace(/\n/g, "").length && lines.length > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, -1)}…`;
  }
  return lines;
}

/** 香港時間日期時間：2026年11月9日 15:04 */
function fmtDateHK(d: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("zh-HK", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${g("year")}年${g("month")}月${g("day")}日 ${g("hour")}:${g("minute")}`;
  } catch {
    return d.toISOString();
  }
}

function money(n: number): string {
  return `HK$${n.toLocaleString("en-US")}`;
}

export interface OrderImageArgs {
  orderNo: string;
  plan: WebDesignPlan;
  name: string;
  phone: string;
  email?: string | null;
  requirements: string;
  styleNotes: string;
  items: WebDesignPricedItem[];
  oneOffTotal: number;
  monthlyTotal: number;
  total: number;
  createdAt: Date;
}

/** 組 SVG（純函數，測試可以直踩字句有冇齊） */
export function buildOrderImageSvg(args: OrderImageArgs): string {
  const W = ORDER_IMAGE_WIDTH;
  const M = 90; // 左右邊距
  const CW = W - M * 2; // 內容闊度
  // 一般訂單維持 1200×1600；功能／備註多就自動加高，唔准靜靜雞截走正式內容。
  let estimatedY = 322 + (4 + (args.email ? 1 : 0)) * 48 + 58 + 50;
  for (const it of args.items) estimatedY += 26 + (it.priceNote ? 30 : 12);
  estimatedY += 62 + 46 + (args.monthlyTotal > 0 ? 92 : 0) + 60 + 6;
  for (const body of [args.requirements, args.styleNotes]) {
    if (!body.trim()) continue;
    estimatedY += 42 + wrapText(body.trim(), 22, CW, Number.MAX_SAFE_INTEGER).length * 36 + 14;
  }
  const H = Math.max(ORDER_IMAGE_HEIGHT, Math.ceil(estimatedY + 170));
  const parts: string[] = [];
  const text = (
    x: number,
    y: number,
    s: string,
    opts: { size?: number; fill?: string; weight?: number; anchor?: string; spacing?: number } = {},
  ) => {
    parts.push(
      `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${opts.size ?? 26}" fill="${opts.fill ?? INK}"${
        opts.weight ? ` font-weight="${opts.weight}"` : ""
      }${opts.anchor ? ` text-anchor="${opts.anchor}"` : ""}${
        opts.spacing ? ` letter-spacing="${opts.spacing}"` : ""
      }>${xe(s)}</text>`,
    );
  };
  const hline = (y: number) => {
    parts.push(`<line x1="${M}" y1="${y}" x2="${W - M}" y2="${y}" stroke="${LINE}" stroke-width="1"/>`);
  };

  // 背景＋雙框（零圓角，同品牌紙單風格）
  parts.push(`<rect width="${W}" height="${H}" fill="#f7f3ec"/>`);
  parts.push(`<rect x="36" y="36" width="${W - 72}" height="${H - 72}" fill="#fffdf9" stroke="${LINE}" stroke-width="1"/>`);
  parts.push(`<rect x="48" y="48" width="${W - 96}" height="${H - 96}" fill="none" stroke="${GOLD}" stroke-width="1"/>`);

  // 標題
  text(W / 2, 130, "REDCODE 網站設計服務", { size: 30, fill: GOLD, anchor: "middle", spacing: 8, weight: 600 });
  text(W / 2, 188, "正式訂單確認", { size: 52, anchor: "middle", weight: 700, spacing: 6 });
  text(W / 2, 232, fmtDateHK(args.createdAt), { size: 22, fill: SOFT, anchor: "middle", spacing: 2 });
  hline(268);

  // 訂單資料
  let y = 322;
  const row = (label: string, value: string) => {
    text(M, y, label, { size: 24, fill: SOFT, spacing: 2 });
    text(M + 200, y, value, { size: 26, weight: 600 });
    y += 48;
  };
  row("訂單編號", args.orderNo);
  row("客戶姓名", args.name);
  row("聯絡電話", args.phone);
  if (args.email) row("電郵", args.email);
  row("服務方案", `網站設計（${planLabel(args.plan)}）`);
  hline(y + 6);
  y += 58;

  // 功能明細
  text(M, y, "服務內容及收費", { size: 28, weight: 700, spacing: 3 });
  y += 50;
  const billingLabel = (b: string) => (b === "monthly" ? "每月" : b === "at_cost" ? "實報實銷" : "一次性");
  for (const it of args.items) {
    text(M, y, `· ${it.name}`, { size: 24 });
    const priceText = it.billing === "at_cost" ? billingLabel(it.billing) : `${money(it.price)}（${billingLabel(it.billing)}）`;
    text(W - M, y, priceText, { size: 24, anchor: "end", fill: INK });
    y += 26;
    if (it.priceNote) {
      text(M + 26, y, it.priceNote, { size: 19, fill: SOFT });
      y += 30;
    } else {
      y += 12;
    }
  }
  hline(y + 10);
  y += 62;

  // 金額總結
  const totalRow = (label: string, value: string, big = false) => {
    text(M, y, label, { size: big ? 30 : 25, fill: big ? INK : SOFT, weight: big ? 700 : 400, spacing: 1 });
    text(W - M, y, value, { size: big ? 34 : 26, anchor: "end", weight: big ? 700 : 600, fill: big ? GOLD : INK });
    y += big ? 60 : 46;
  };
  totalRow("一次性費用", money(args.oneOffTotal));
  if (args.monthlyTotal > 0) {
    totalRow("首月月費", money(args.monthlyTotal));
    totalRow("其後月費", `${money(args.monthlyTotal)}／月`);
  }
  totalRow("今次應付總額", money(args.total), true);
  y += 6;

  // 要求／風格：全部折行寫齊；H 已按實際行數預留，唔准截斷。
  const notesBlock = (title: string, body: string) => {
    if (!body.trim()) return;
    text(M, y, title, { size: 25, weight: 700, spacing: 2 });
    y += 42;
    for (const line of wrapText(body.trim(), 22, CW, Number.MAX_SAFE_INTEGER)) {
      text(M, y, line, { size: 22, fill: "#4a443b" });
      y += 36;
    }
    y += 14;
  };
  notesBlock("網站要求", args.requirements);
  notesBlock("風格備註", args.styleNotes);

  // 頁尾
  text(W / 2, H - 92, "此訂單圖由系統自動生成，同我哋紀錄一致。", { size: 20, fill: SOFT, anchor: "middle" });
  text(W / 2, H - 62, "RedCode · ows.redcode.red", { size: 18, fill: SOFT, anchor: "middle", spacing: 2 });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

/**
 * 生成正式訂單圖 PNG，寫落 UPLOAD_DIR，回傳公開 path（/uploads/wd-<uuid>.png）。
 * 失敗會 throw（sharp 裝唔到／寫碟失敗）——caller 必須 loud 記錄兼唔准假裝圖已生成。
 */
export async function generateWebDesignOrderImage(args: OrderImageArgs): Promise<string> {
  const sharp = (await import("sharp")).default;
  const svg = buildOrderImageSvg(args);
  const png = await sharp(Buffer.from(svg, "utf8")).png({ compressionLevel: 9 }).toBuffer();
  const dir = process.env.UPLOADS_DIR || "uploads";
  await mkdir(dir, { recursive: true });
  const filename = `wd-${randomUUID()}.png`;
  await writeFile(path.join(dir, filename), png);
  return `/uploads/${filename}`;
}

/**
 * 落單 DB 寫入失敗時清返張已生成嘅訂單圖（best-effort，唔 throw）——
 * 避免「冇單嘅孤兒圖」留喺公開 /uploads。
 */
export async function deleteWebDesignOrderImage(imagePath: string): Promise<void> {
  try {
    const file = path.basename(imagePath); // 擋 path traversal
    if (!/^wd-[0-9a-f-]+\.png$/.test(file)) return;
    await unlink(path.join(process.env.UPLOADS_DIR || "uploads", file));
  } catch {
    // 清唔到都唔阻主流程（下次孤兒清理再執）
  }
}
