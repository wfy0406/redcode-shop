/**
 * v2.5.8 公開中獎公告 PNG 生成（老闆指令：華麗動態引流配套——出街用高清圖）
 * --------------------------------
 * - 1080×1350（4:5 直度，Facebook 貼文友好；>= 規格下限）
 * - 內容全部來自真實抽獎結果（publicEventResults / adminEventWinners），唔會虛構
 * - 純排版核心（layoutAnnouncement）唔掂 canvas，注入 measure 函數 → 可單元測試
 *   （CJK／長名截斷、多人縮字＋「仲有 N 位」、空名單「即將公佈」）
 * - 渲染（renderAnnouncementPng）先用真 canvas 2d；字體用系統 CJK stack，
 *   瀏覽器自帶中文字形，唔使打包字體
 */

export const ANNOUNCEMENT_W = 1080;
export const ANNOUNCEMENT_H = 1350;

export type AnnouncementWinner = { name: string; prizeName: string };

export type AnnouncementData = {
  eventName: string;
  /** 顯示用抽獎日期時間（已格式化，例如「2026-11-11 21:30」）；冇中獎時可 null */
  drawnAtLabel: string | null;
  winners: AnnouncementWinner[];
};

/** 注入嘅量度器：俾文字＋字號＋粗幼，回像素寬（真渲染用 ctx.measureText；測試用 stub） */
export type MeasureFn = (text: string, fontSizePx: number, bold: boolean) => number;

const MARGIN_X = 84;
const CONTENT_W = ANNOUNCEMENT_W - MARGIN_X * 2;

/** CJK 友善截斷：太長就逐個字元截到放得下再加「…」（唔好斷半個字） */
export function fitText(
  text: string,
  maxWidth: number,
  fontSize: number,
  bold: boolean,
  measure: MeasureFn,
): string {
  if (measure(text, fontSize, bold) <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 0) {
    chars.pop();
    const candidate = chars.join("") + "…";
    if (measure(candidate, fontSize, bold) <= maxWidth) return candidate;
  }
  return "…";
}

/** 自動縮字：由 startPx 逐級縮到 minPx，放得落就停 */
export function shrinkToFit(
  text: string,
  maxWidth: number,
  startPx: number,
  minPx: number,
  bold: boolean,
  measure: MeasureFn,
): { text: string; fontSize: number } {
  for (let size = startPx; size >= minPx; size -= 2) {
    if (measure(text, size, bold) <= maxWidth) return { text, fontSize: size };
  }
  return { text: fitText(text, maxWidth, minPx, bold, measure), fontSize: minPx };
}

export type WinnerRowPlan = {
  name: string;
  prize: string;
  fontSize: number;
  y: number;
};

export type AnnouncementLayout = {
  eventName: { text: string; fontSize: number };
  rows: WinnerRowPlan[];
  /** 放唔晒嘅中獎人數（>0 時最底出「仲有 N 位幸運兒」） */
  hiddenCount: number;
  empty: boolean;
  rowFontSize: number;
};

const ROWS_TOP = 560;
const ROWS_BOTTOM = 1180; // 之上係名單區；之下留位畫 footer

/**
 * 名單排版：按人數揀行高（少人＝大行距靚啲；多人＝壓縮），
 * 放唔晒就截斷＋hiddenCount。空名單 empty=true（畫「即將公佈」）。
 */
export function layoutAnnouncement(data: AnnouncementData, measure: MeasureFn): AnnouncementLayout {
  const eventName = shrinkToFit(data.eventName, CONTENT_W, 72, 34, true, measure);

  if (data.winners.length === 0) {
    return { eventName, rows: [], hiddenCount: 0, empty: true, rowFontSize: 0 };
  }

  // 行高按人數遞減：≤6 → 96px；≤10 → 72px；≤16 → 56px；再多 → 44px
  const n = data.winners.length;
  const rowH = n <= 6 ? 96 : n <= 10 ? 72 : n <= 16 ? 56 : 44;
  const fontSize = n <= 6 ? 40 : n <= 10 ? 34 : n <= 16 ? 28 : 24;
  const capacity = Math.floor((ROWS_BOTTOM - ROWS_TOP) / rowH);
  const visible = data.winners.slice(0, capacity);
  const hiddenCount = data.winners.length - visible.length;

  const nameMaxW = Math.floor(CONTENT_W * 0.52);
  const prizeMaxW = CONTENT_W - nameMaxW - 40;
  const rows: WinnerRowPlan[] = visible.map((w, i) => ({
    name: fitText(w.name, nameMaxW, fontSize, true, measure),
    prize: fitText(w.prizeName, prizeMaxW, fontSize - 4, false, measure),
    fontSize,
    y: ROWS_TOP + i * rowH,
  }));
  return { eventName, rows, hiddenCount, empty: false, rowFontSize: fontSize };
}

/** 確定性伪隨機（公告圖星星位置要可重現，唔好每次唔同） */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const CJK_SERIF = '"Noto Serif TC", "Noto Serif HK", "PingFang HK", "Microsoft JhengHei", "PMingLiU", serif';
const CJK_SANS = '"Noto Sans TC", "Noto Sans HK", "PingFang HK", "Microsoft JhengHei", sans-serif';

/** 真渲染：1080×1350 PNG blob。瀏覽器專用（canvas 2d）；失敗（例如冇 canvas）回 null */
export async function renderAnnouncementPng(data: AnnouncementData): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = ANNOUNCEMENT_W;
  canvas.height = ANNOUNCEMENT_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const measure: MeasureFn = (text, size, bold) => {
    ctx.font = `${bold ? "700" : "400"} ${size}px ${CJK_SERIF}`;
    return ctx.measureText(text).width;
  };
  const layout = layoutAnnouncement(data, measure);

  // ── 深空底＋星塵 ──
  const bg = ctx.createLinearGradient(0, 0, 0, ANNOUNCEMENT_H);
  bg.addColorStop(0, "#0B1026");
  bg.addColorStop(0.55, "#141A38");
  bg.addColorStop(1, "#1B2340");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, ANNOUNCEMENT_W, ANNOUNCEMENT_H);

  const rnd = seededRandom(20261111);
  for (let i = 0; i < 140; i++) {
    const x = rnd() * ANNOUNCEMENT_W;
    const y = rnd() * ANNOUNCEMENT_H;
    const r = rnd() * 2.2 + 0.4;
    const a = rnd() * 0.55 + 0.12;
    ctx.fillStyle = `rgba(232, 238, 252, ${a.toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // 金色大星芒（四角裝飾）
  for (const [sx, sy, sr] of [[120, 150, 3.2], [960, 120, 2.6], [940, 1150, 3], [140, 1180, 2.4]] as const) {
    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = "rgba(245,197,24,0.85)";
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const ang = (Math.PI / 4) * i;
      const len = i % 2 === 0 ? sr * 5 : sr * 1.6;
      ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ── 雙金框 ──
  ctx.strokeStyle = "#D4AF37";
  ctx.lineWidth = 4;
  ctx.strokeRect(36, 36, ANNOUNCEMENT_W - 72, ANNOUNCEMENT_H - 72);
  ctx.strokeStyle = "rgba(212,175,55,0.4)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(52, 52, ANNOUNCEMENT_W - 104, ANNOUNCEMENT_H - 104);

  const centerX = ANNOUNCEMENT_W / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // ── 品牌行 ──
  ctx.fillStyle = "#F5C518";
  ctx.font = `700 30px ${CJK_SANS}`;
  ctx.fillText("REDCODE ✦ 直播抽獎・中獎公告", centerX, 150);

  // ── 大標題 ──
  ctx.fillStyle = "#F2EFE6";
  ctx.font = `700 96px ${CJK_SERIF}`;
  ctx.fillText("中獎名單", centerX, 270);

  // 標題下金線
  ctx.strokeStyle = "rgba(212,175,55,0.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(centerX - 150, 305);
  ctx.lineTo(centerX + 150, 305);
  ctx.stroke();

  // ── 活動名（自動縮字／截斷） ──
  ctx.fillStyle = "#FFE28F";
  ctx.font = `700 ${layout.eventName.fontSize}px ${CJK_SERIF}`;
  ctx.fillText(layout.eventName.text, centerX, 400);

  // ── 抽獎日期時間 ──
  if (data.drawnAtLabel) {
    ctx.fillStyle = "rgba(232,238,252,0.75)";
    ctx.font = `400 26px ${CJK_SANS}`;
    ctx.fillText(`抽獎時間：${data.drawnAtLabel}`, centerX, 452);
  }

  // ── 名單區 ──
  if (layout.empty) {
    ctx.fillStyle = "#F2EFE6";
    ctx.font = `700 44px ${CJK_SERIF}`;
    ctx.fillText("中獎名單即將公佈", centerX, 780);
    ctx.fillStyle = "rgba(232,238,252,0.75)";
    ctx.font = `400 28px ${CJK_SANS}`;
    ctx.fillText("留意 Facebook 直播，幸運兒可能係你 ✦", centerX, 840);
  } else {
    for (let i = 0; i < layout.rows.length; i++) {
      const row = layout.rows[i];
      const midY = row.y + row.fontSize;
      // 序號金章
      ctx.fillStyle = "rgba(245,197,24,0.14)";
      ctx.beginPath();
      ctx.arc(MARGIN_X + 22, midY - row.fontSize * 0.32, 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#F5C518";
      ctx.font = `700 ${Math.max(18, row.fontSize - 8)}px ${CJK_SANS}`;
      ctx.fillText(String(i + 1), MARGIN_X + 22, midY - row.fontSize * 0.32 + 8);
      // 中獎人名（左）＋獎品（右）
      ctx.textAlign = "left";
      ctx.fillStyle = "#F2EFE6";
      ctx.font = `700 ${row.fontSize}px ${CJK_SERIF}`;
      ctx.fillText(row.name, MARGIN_X + 64, midY);
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255,226,143,0.9)";
      ctx.font = `400 ${row.fontSize - 4}px ${CJK_SANS}`;
      ctx.fillText(row.prize, ANNOUNCEMENT_W - MARGIN_X, midY);
      ctx.textAlign = "center";
      // 行底細金線
      ctx.strokeStyle = "rgba(212,175,55,0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(MARGIN_X + 40, row.y + row.fontSize + 16);
      ctx.lineTo(ANNOUNCEMENT_W - MARGIN_X - 0, row.y + row.fontSize + 16);
      ctx.stroke();
    }
    if (layout.hiddenCount > 0) {
      ctx.fillStyle = "rgba(232,238,252,0.8)";
      ctx.font = `400 26px ${CJK_SANS}`;
      const lastRow = layout.rows[layout.rows.length - 1];
      ctx.fillText(`……仲有 ${layout.hiddenCount} 位幸運兒，完整名單見 redcode.red`, centerX, lastRow.y + lastRow.fontSize + 62);
    }
  }

  // ── footer：引流 CTA（對照創意規矩：官網＋FB 專頁） ──
  ctx.fillStyle = "#F5C518";
  ctx.font = `700 30px ${CJK_SANS}`;
  ctx.fillText("redcode.red ・ facebook.com/redcodexhk", centerX, 1236);
  ctx.fillStyle = "rgba(232,238,252,0.7)";
  ctx.font = `400 24px ${CJK_SANS}`;
  ctx.fillText("撳實開播通知・下一個中獎嘅可能係你", centerX, 1284);

  return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
}

/** 觸發瀏覽器下載（失敗回 false，caller 出錯誤 toast） */
export async function downloadAnnouncementPng(data: AnnouncementData, filename: string): Promise<boolean> {
  const blob = await renderAnnouncementPng(data);
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}
