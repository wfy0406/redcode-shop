/**
 * v2.5.8 公開中獎公告 PNG 生成（老闆指令：華麗動態引流配套——出街用高清圖）
 * --------------------------------
 * - 1080px 闊；最少 1350px 高，之後按真實中獎人數加長（30 位全部逐行展示）
 * - 內容全部來自真實抽獎結果（publicEventResults / adminEventWinners），唔會虛構
 * - 純排版核心（layoutAnnouncement）唔掂 canvas，注入 measure 函數 → 可單元測試
 *   （CJK 長名適配、動態高度、完整名單、空名單「即將公佈」）
 * - 渲染（renderAnnouncementPng）先用真 canvas 2d；字體用系統 CJK stack，
 *   瀏覽器自帶中文字形，唔使打包字體
 */

export const ANNOUNCEMENT_W = 1080;
/** 最短高度：少人時維持原本 4:5 構圖；名單長時由 layout.height 自動加長。 */
export const ANNOUNCEMENT_H = 1350;
/** 單張長圖安全上限：500 位約 22,730px，超過就明確報錯，唔會靜默截名單或整出壞圖。 */
export const ANNOUNCEMENT_MAX_WINNERS = 500;

export type AnnouncementWinner = { name: string; prizeName: string };

export type AnnouncementData = {
  eventName: string;
  /** 活動級預定抽獎日（已格式化，例如「2026-11-11」）；舊活動未定日期 → null（如實寫「抽獎日待公佈」，唔好用 createdAt 冒充） */
  scheduledDrawDateLabel: string | null;
  /** 顯示用實際抽獎日期時間（已格式化，例如「2026-11-11 21:30」）；冇中獎時可 null。
   *  嚟自真實 winner 紀錄，係「實際抽出」——同 scheduledDrawDateLabel（預定）分開標示，唔會混淆 */
  drawnAtLabel: string | null;
  winners: AnnouncementWinner[];
};

/**
 * v2026.10.26.2：公告日期行（純函數，可單元測試）。
 * - 有預定抽獎日 → 「預定抽獎日：…」（未開獎都照寫呢個 label）
 * - 有真實 winner 抽出時間 → 「抽獎時間：…」（實際抽出，同預定日分開）
 * - 兩樣都冇（舊活動 null＋未開獎）→ 「抽獎日待公佈」
 */
export function announcementDateLines(data: AnnouncementData): string[] {
  const lines: string[] = [];
  if (data.scheduledDrawDateLabel) lines.push(`預定抽獎日：${data.scheduledDrawDateLabel}`);
  if (data.drawnAtLabel) lines.push(`抽獎時間：${data.drawnAtLabel}`);
  if (lines.length === 0) lines.push("抽獎日待公佈");
  return lines;
}

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
  rowHeight: number;
  y: number;
};

export type AnnouncementLayout = {
  eventName: { text: string; fontSize: number };
  rows: WinnerRowPlan[];
  /** 舊版會截名單；而家所有企得硬中獎者都逐位列出，所以永遠係 0。 */
  hiddenCount: number;
  empty: boolean;
  rowFontSize: number;
  rowHeight: number;
  /** 實際 PNG 高度；footer、金框、星塵同背景全部用呢個值。 */
  height: number;
};

const ROWS_TOP = 560;
const FOOTER_RESERVE = 170;

/**
 * 名單排版：按人數揀行高，全部中獎者逐行展示；高度跟名單增加。
 * 少人維持 1350px；10 位約 1450px；30 位約 2050px；31 位起繼續加長。
 * 極端超過安全上限會明確 throw，caller 原句 toast，唔會再出「仲有 N 位」。
 */
export function layoutAnnouncement(data: AnnouncementData, measure: MeasureFn): AnnouncementLayout {
  if (data.winners.length > ANNOUNCEMENT_MAX_WINNERS) {
    throw new Error(
      `呢場有 ${data.winners.length} 位中獎者，超過單張長圖安全上限 ${ANNOUNCEMENT_MAX_WINNERS} 位；未產生圖片，名單冇被截斷。請聯絡技術支援分批匯出。`,
    );
  }
  const eventName = shrinkToFit(data.eventName, CONTENT_W, 72, 34, true, measure);

  if (data.winners.length === 0) {
    return { eventName, rows: [], hiddenCount: 0, empty: true, rowFontSize: 0, rowHeight: 0, height: ANNOUNCEMENT_H };
  }

  const n = data.winners.length;
  const rowHeight = n <= 6 ? 96 : n <= 10 ? 72 : n <= 16 ? 56 : 44;
  const fontSize = n <= 6 ? 40 : n <= 10 ? 34 : n <= 16 ? 28 : 24;
  const height = Math.max(ANNOUNCEMENT_H, ROWS_TOP + n * rowHeight + FOOTER_RESERVE);

  const nameMaxW = Math.floor(CONTENT_W * 0.52);
  const prizeMaxW = CONTENT_W - nameMaxW - 40;
  const rows: WinnerRowPlan[] = data.winners.map((w, i) => ({
    name: fitText(w.name, nameMaxW, fontSize, true, measure),
    prize: fitText(w.prizeName, prizeMaxW, fontSize - 4, false, measure),
    fontSize,
    rowHeight,
    y: ROWS_TOP + i * rowHeight,
  }));
  return { eventName, rows, hiddenCount: 0, empty: false, rowFontSize: fontSize, rowHeight, height };
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

/** 真渲染：1080px 闊、高度跟名單自動增加。瀏覽器專用（canvas 2d）；冇 canvas 回 null。 */
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
  const height = layout.height;
  // 改 canvas 高度會清空畫布；先完成量度，再統一由零開始畫最終長圖。
  canvas.height = height;

  // ── 深空底＋星塵＋頂部金色光暈 ──
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "#0B1026");
  bg.addColorStop(0.55, "#141A38");
  bg.addColorStop(1, "#1B2340");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, ANNOUNCEMENT_W, height);

  const headerGlow = ctx.createRadialGradient(ANNOUNCEMENT_W / 2, 250, 20, ANNOUNCEMENT_W / 2, 250, 560);
  headerGlow.addColorStop(0, "rgba(245,197,24,0.15)");
  headerGlow.addColorStop(0.48, "rgba(116,82,180,0.08)");
  headerGlow.addColorStop(1, "rgba(11,16,38,0)");
  ctx.fillStyle = headerGlow;
  ctx.fillRect(0, 0, ANNOUNCEMENT_W, 820);

  const rnd = seededRandom(20261111);
  const starCount = Math.ceil(140 * height / ANNOUNCEMENT_H);
  for (let i = 0; i < starCount; i++) {
    const x = rnd() * ANNOUNCEMENT_W;
    const y = rnd() * height;
    const r = rnd() * 2.2 + 0.4;
    const a = rnd() * 0.55 + 0.12;
    ctx.fillStyle = `rgba(232, 238, 252, ${a.toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // 金色大星芒（四角裝飾；底部跟實際長圖高度，唔會浮喺名單中間）
  for (const [sx, sy, sr] of [[120, 150, 3.2], [960, 120, 2.6], [940, height - 200, 3], [140, height - 170, 2.4]] as const) {
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
  ctx.strokeRect(36, 36, ANNOUNCEMENT_W - 72, height - 72);
  ctx.strokeStyle = "rgba(212,175,55,0.4)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(52, 52, ANNOUNCEMENT_W - 104, height - 104);

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

  // ── 抽獎日期行（預定抽獎日／實際抽獎時間分開標示；兩樣都冇 → 如實寫待公佈） ──
  const dateLines = announcementDateLines(data);
  ctx.fillStyle = "rgba(232,238,252,0.75)";
  ctx.font = `400 26px ${CJK_SANS}`;
  dateLines.forEach((line, i) => {
    ctx.fillText(line, centerX, 452 + i * 36);
  });

  // ── 名單區 ──
  if (layout.empty) {
    ctx.fillStyle = "#F2EFE6";
    ctx.font = `700 44px ${CJK_SERIF}`;
    ctx.fillText("中獎名單即將公佈", centerX, 780);
    ctx.fillStyle = "rgba(232,238,252,0.75)";
    ctx.font = `400 28px ${CJK_SANS}`;
    ctx.fillText("留意 Facebook 直播，幸運兒可能係你 ✦", centerX, 840);
  } else {
    ctx.fillStyle = "rgba(255,226,143,0.86)";
    ctx.font = `700 18px ${CJK_SANS}`;
    ctx.fillText(`幸運兒名單・共 ${data.winners.length} 位`, centerX, ROWS_TOP - 26);

    for (let i = 0; i < layout.rows.length; i++) {
      const row = layout.rows[i];
      const midY = row.y + row.fontSize;
      // 單雙行極淡底色：長名單都易跟行，唔會一大版字逼埋一齊。
      if (i % 2 === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.026)";
        ctx.fillRect(MARGIN_X + 38, row.y - 2, CONTENT_W - 38, row.rowHeight - 4);
      }
      // 序號金章
      ctx.fillStyle = i % 2 === 0 ? "rgba(245,197,24,0.22)" : "rgba(245,197,24,0.13)";
      ctx.beginPath();
      ctx.arc(MARGIN_X + 22, midY - row.fontSize * 0.32, 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(245,197,24,0.38)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#F5C518";
      ctx.font = `700 ${Math.max(16, row.fontSize - 8)}px ${CJK_SANS}`;
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
      ctx.moveTo(MARGIN_X + 40, row.y + row.rowHeight - 6);
      ctx.lineTo(ANNOUNCEMENT_W - MARGIN_X, row.y + row.rowHeight - 6);
      ctx.stroke();
    }
  }

  // ── footer：跟長圖底部，永遠唔會冚住第 9 位或以後嘅名單 ──
  ctx.strokeStyle = "rgba(212,175,55,0.42)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(centerX - 250, height - 160);
  ctx.lineTo(centerX + 250, height - 160);
  ctx.stroke();
  ctx.fillStyle = "#F5C518";
  ctx.font = `700 30px ${CJK_SANS}`;
  ctx.fillText("redcode.red ・ facebook.com/redcodexhk", centerX, height - 114);
  ctx.fillStyle = "rgba(232,238,252,0.7)";
  ctx.font = `400 24px ${CJK_SANS}`;
  ctx.fillText("撳實開播通知・下一個中獎嘅可能係你", centerX, height - 66);

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
