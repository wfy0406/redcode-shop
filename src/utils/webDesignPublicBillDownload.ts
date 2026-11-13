// ===== v2026.11.13.2 redcode.red 公開單據下載（圖片 PNG / PDF）— 黑金留底文件 renderer =====
// PNG/PDF 係專用中性留底文件，唔係網頁截圖：
//   - 完全唔出收付狀態字句、收付或退款相關日期、收付方式或實收退款細節、
//     付款 CTA、附加費或付款操作提示、測試模式 badge／狀態 chip／互動 UI；網上頁付款唔落文件。
//   - 只保留：原裝 logo、公司名、bill kind 標題、billNo、固定開單日期（createdAt 優先，
//     orderDate fallback，唔理單據狀態都係開單日）、客戶／帳期／專案／
//     公開安全備註、服務明細、折扣、總額、notes snapshot（text + updatedAt）、
//     canonical onlineUrl＋QR。VOID 只出一句「此單據已作廢，只供紀錄留底」（文件有效性，唔係收付狀態）。
//   - 黑金華麗漸變文件感：near-black 全版底、香檳金箔邊框／total panel、serif 大標題、
//     中文可讀 sans body、單欄留白＋金 hairline；QR 白底深 modules 保證可掃。
// 用 <canvas> 手畫成張單（唔用 html2canvas — 新 CSS 色函數佢 parse 唔到會爆）。
// SPEC §9：QR payload 固定係後端回傳嘅 onlineUrl（https://redcode.red/web-design-bill/<token>），
//   網上頁顯示嘅 URL＋QR 同下載 PNG/PDF 完全一致；QR 用 website 現有 `qrcode` 包 dynamic import
//   （同 PaymentHeroCard 做法，唔加新 dependency）；QR 生成失敗要 loud throw，唔准出無 QR 假完成單。
// PDF：jsPDF 用 website 現有 npm 依賴 `jspdf` dynamic import（同 PaymentHeroCard 做法，唔塞首屏 bundle；
//   唔再用 cdnjs 遠端 script——production CSP script-src 冇 cdnjs 會擋死），
//   A4 全版出血多頁：pxPerMm=canvas.width/210、sliceHPx=floor(297*pxPerMm)、
//   每頁 part canvas 固定完整 A4 像素、先填文件背景再畫 source slice、addImage(0,0,210,297)。

import {
  billTitles,
  fmtDateTime,
  fmtHKD,
  foldLabel,
  lineDisc,
  metaRows,
  qrPayloadForBill,
  totalsPlan,
  type WebDesignPublicBillView,
} from '@/pages/webDesignPublicBill';

// ---------- 黑金文件主題 ----------
export const BILL_THEME = {
  bg: '#0a0805', // near-black 全版底
  bgDeep: '#050403',
  panel: '#14110a',
  panelSoft: '#1a160c',
  gold: '#d4af37', // 香檳金主色
  goldBright: '#f0dc9a',
  goldDeep: '#8a6d1f',
  goldLine: 'rgba(212,175,55,0.5)', // 金箔邊／強 hairline
  hairline: 'rgba(212,175,55,0.22)', // 細 hairline
  text: '#f3ecd8', // 象牙白正文
  soft: '#cbbfa0',
  faint: '#8d8167',
  ink: '#241b05', // 金箔 panel 上嘅深色字
  white: '#ffffff',
} as const;

const MONO = `'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace`;
const CJK = `'PingFang HK','PingFang TC','PingFang SC','Microsoft JhengHei','Microsoft YaHei','Noto Sans CJK TC',sans-serif`;
const SERIF = `'Noto Serif TC','Noto Serif SC','Songti TC','PMingLiU','SimSun',Georgia,serif`;

const COMPANY_FALLBACK = 'RedCode HK直播台';
// 網頁設計業務專用：同 WMS 網頁設計介面同一個原裝透明 PNG；商城 FASHION DESIGN logo 唔用喺呢類文件。
export const WD_PUBLIC_BILL_LOGO_SRC = '/redcode-web-design-logo.png';

// VOID 單據唯一一句有效性聲明（唔係付未付狀態）；其他 status 文件完全唔顯示
export const VOID_ARCHIVE_NOTE = '此單據已作廢，只供紀錄留底';

// 留底文件固定開單日期：createdAt 優先，orderDate fallback；
// 唔理單據狀態都係開單日，絕唔用收付導向嘅日期行 helper。
export function webDesignPublicBillIssueDateLine(
  b: Pick<WebDesignPublicBillView, 'createdAt' | 'orderDate'>,
): string {
  if (b.createdAt) return `開單日期　${fmtDateTime(b.createdAt)}`;
  if (b.orderDate) return `開單日期　${b.orderDate}`;
  return '';
}

// ---------- 換行（CJK 逐字斷；measure 注入 → node 環境可測）----------
export function wrapBillText(text: string, maxW: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const ch of [...para]) {
      if (line && measure(line + ch) > maxW) {
        out.push(line);
        line = ch.trimStart();
      } else {
        line += ch;
      }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

// ---------- 逐字畫「字距」文字（canvas 原生 letterSpacing 兼容性參差，自己砌最穩）----------
function fillSpaced(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  ls: number,
  align: 'center' | 'left' | 'right' = 'center',
): void {
  const chars = [...text];
  if (chars.length === 0) return;
  if (ls === 0) {
    ctx.textAlign = align;
    ctx.fillText(text, cx, y);
    ctx.textAlign = 'left';
    return;
  }
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + ls * (chars.length - 1);
  let x = align === 'center' ? cx - total / 2 : align === 'right' ? cx - total : cx;
  const prev = ctx.textAlign;
  ctx.textAlign = 'left';
  chars.forEach((ch, i) => {
    ctx.fillText(ch, x, y);
    x += widths[i] + ls;
  });
  ctx.textAlign = prev;
}

// 圖按 src 快取 Promise（logo／QR 都經呢度，批量出圖唔使逐次 decode）
const imageCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadImage(src: string): Promise<HTMLImageElement | null> {
  let p = imageCache.get(src);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
    imageCache.set(src, p);
  }
  return p;
}

// ---------- QR（SPEC §9：payload＝onlineUrl；失敗 loud throw，唔准出無 QR 假完成單）----------
// website 已有 `qrcode` 依賴（同 PaymentHeroCard 同一做法 dynamic import，唔塞首屏 bundle）。
let qrDataUrlPromise: Promise<string> | null = null;
let qrDataUrlPayload: string | null = null;
async function qrDataUrl(payload: string): Promise<string> {
  if (qrDataUrlPromise && qrDataUrlPayload === payload) return qrDataUrlPromise;
  qrDataUrlPayload = payload;
  qrDataUrlPromise = (async () => {
    const QRCode = (await import('qrcode')).default;
    return QRCode.toDataURL(payload, {
      margin: 1,
      width: 320,
      errorCorrectionLevel: 'M',
      // 深底上 QR 一定要深字白底先掃到：白盒＋深色 modules
      color: { dark: '#0c1220', light: '#ffffff' },
    });
  })();
  try {
    return await qrDataUrlPromise;
  } catch (e) {
    // 失敗唔好 cache 住個 rejected promise，下次重試
    qrDataUrlPromise = null;
    qrDataUrlPayload = null;
    throw e;
  }
}

/** 產生 QR <img>；payload 無效／生成失敗 → loud throw（下載流程會如實顯示錯誤） */
async function loadQrImage(payload: string | null): Promise<HTMLImageElement> {
  if (!payload) throw new Error('單據缺少網上連結，未能製作二維碼');
  const dataUrl = await qrDataUrl(payload);
  const img = await loadImage(dataUrl);
  if (!img) throw new Error('二維碼製作失敗，請重試');
  return img;
}

// 等文件用字體 ready（serif 標題＋mono 數字；頁面 CSS 未必有 inject，最多等 1.8s 免阻住）
let fontsPromise: Promise<void> | null = null;
function ensureFonts(): Promise<void> {
  if (fontsPromise) return fontsPromise;
  fontsPromise = (async () => {
    try {
      const wants = [
        '700 32px "Noto Serif TC"',
        '600 14px "Noto Serif TC"',
        '500 12px "JetBrains Mono"',
        '700 24px "JetBrains Mono"',
      ];
      await Promise.race([
        Promise.all(wants.map((f) => (document as any).fonts?.load?.(f).catch(() => undefined))),
        new Promise((r) => setTimeout(r, 1800)),
      ]);
      await Promise.race([(document as any).fonts?.ready ?? Promise.resolve(), new Promise((r) => setTimeout(r, 400))]);
    } catch {
      /* 字體慢都照畫（fallback serif／mono） */
    }
  })();
  return fontsPromise;
}

// ---------- 主繪製：回傳總高度＋唔准由中間切開嘅 section（logical px）；two-pass 用 ----------
export interface PublicBillKeepTogetherRange {
  start: number;
  end: number;
}

// sheetH：正式 pass 傳入 measure pass 量到嘅 usedH，等背景／金框可以畫到啱啱好嘅底邊；
// measure pass 唔傳就用 BIG（夠大），排版 y 推進完全唔受 sheetH 影響。
function drawSheet(
  ctx: CanvasRenderingContext2D,
  d: WebDesignPublicBillView,
  logo: HTMLImageElement | null,
  qr: HTMLImageElement,
  qrPayload: string,
  W: number,
  sheetH?: number,
): { usedH: number; keepTogether: PublicBillKeepTogetherRange[] } {
  const T = BILL_THEME;
  const BIG = 6000; // measure pass 用嘅「夠大」高度；real pass 會傳啱啱好嘅 sheetH
  const H = sheetH ?? BIG;
  const FRAME_OUT = 12; // 外金框
  const FRAME_IN = 19; // 內 hairline 框
  const contentX = 48;
  const contentW = W - contentX * 2;
  const contentR = contentX + contentW;
  const cx = W / 2;

  const company = d.companyName || COMPANY_FALLBACK;
  const titles = billTitles(d.kind);
  const isVoid = d.status === 'void';
  const issueDate = webDesignPublicBillIssueDateLine(d);
  const meta = metaRows(d);
  const totals = totalsPlan(d);

  // ===== 底：near-black 全版 + 黑金漸變（頂／底香檳金暈＋對角微光）=====
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, W, H);
  const glowTop = ctx.createRadialGradient(cx, -150, 40, cx, -150, W * 1.15);
  glowTop.addColorStop(0, 'rgba(216,184,92,0.20)');
  glowTop.addColorStop(1, 'rgba(216,184,92,0)');
  ctx.fillStyle = glowTop;
  ctx.fillRect(0, 0, W, W);
  const glowBottom = ctx.createRadialGradient(cx, H + 160, 40, cx, H + 160, W * 1.1);
  glowBottom.addColorStop(0, 'rgba(216,184,92,0.12)');
  glowBottom.addColorStop(1, 'rgba(216,184,92,0)');
  ctx.fillStyle = glowBottom;
  ctx.fillRect(0, H - W, W, W);
  const sheen = ctx.createLinearGradient(0, 0, W, H);
  sheen.addColorStop(0, 'rgba(212,175,55,0.05)');
  sheen.addColorStop(0.5, 'rgba(212,175,55,0)');
  sheen.addColorStop(1, 'rgba(212,175,55,0.06)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, W, H);

  // ===== 香檳金箔雙框（全版外框＋內 hairline）=====
  ctx.strokeStyle = T.goldLine;
  ctx.lineWidth = 1.6;
  ctx.strokeRect(FRAME_OUT, FRAME_OUT, W - FRAME_OUT * 2, H - FRAME_OUT * 2);
  ctx.strokeStyle = T.hairline;
  ctx.lineWidth = 1;
  ctx.strokeRect(FRAME_IN + 0.5, FRAME_IN + 0.5, W - FRAME_IN * 2 - 1, H - FRAME_IN * 2 - 1);

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const hline = (x1: number, x2: number, yy: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, yy + 0.5);
    ctx.lineTo(x2, yy + 0.5);
    ctx.stroke();
  };

  // 分隔裝飾：金 hairline — 菱形 — hairline
  const ornament = (yy: number) => {
    const w = contentW / 2 - 18;
    hline(contentX, contentX + w, yy, T.goldLine);
    hline(contentR - w, contentR, yy, T.goldLine);
    ctx.save();
    ctx.translate(cx, yy + 0.5);
    ctx.rotate(Math.PI / 4);
    ctx.strokeStyle = T.gold;
    ctx.lineWidth = 1;
    ctx.strokeRect(-3, -3, 6, 6);
    ctx.restore();
  };

  // 章節標題：serif 金中文（左）＋mono 英文（右）＋金 hairline；唔再用舊式章節編號
  const secLabel = (zh: string, en: string) => {
    y += 28;
    ctx.font = `600 14px ${SERIF}`;
    ctx.fillStyle = T.gold;
    fillSpaced(ctx, zh, contentX, y, 14 * 0.3, 'left');
    ctx.font = `500 9px ${MONO}`;
    ctx.fillStyle = T.faint;
    fillSpaced(ctx, en, contentR, y, 9 * 0.3, 'right');
    y += 12;
    hline(contentX, contentR, y, T.goldLine);
    y += 4;
  };

  // ===== 頁首：logo 置中 + 公司名 + serif 大標題（project 單用專案標題，SPEC §5）=====
  let y = 54;
  if (logo) {
    // v2026.11.13.4：WEBSITE BUILDING 原裝透明 logo 放大 52 → 82；只改顯示尺寸，唔重繪、唔加底。
    const lh = 82;
    const lw = (logo.naturalWidth / logo.naturalHeight) * lh;
    ctx.drawImage(logo, cx - lw / 2, y, lw, lh); // 透明 PNG 原裝直接落深色底，唔加白底
    y += lh + 20;
  } else {
    y += 10;
  }
  ctx.font = `500 12px ${MONO}`;
  ctx.fillStyle = T.soft;
  fillSpaced(ctx, company.toUpperCase(), cx, y, 12 * 0.3);
  y += 28;
  ornament(y);
  y += 36;
  ctx.font = `700 32px ${SERIF}`;
  ctx.fillStyle = T.gold;
  ctx.textAlign = 'center';
  ctx.fillText(titles.zh, cx, y);
  ctx.textAlign = 'left';
  y += 17;
  ctx.font = `500 10.5px ${MONO}`;
  ctx.fillStyle = T.faint;
  fillSpaced(ctx, titles.en, cx, y, 10.5 * 0.34);
  y += 26;
  ornament(y);
  y += 26;

  // ===== 單號＋固定開單日期 =====
  ctx.font = `500 10px ${MONO}`;
  ctx.fillStyle = T.faint;
  fillSpaced(ctx, '單據編號', contentX, y, 10 * 0.24, 'left');
  if (issueDate) fillSpaced(ctx, '開單日期', contentR, y, 10 * 0.24, 'right');
  y += 20;
  ctx.font = `600 16px ${MONO}`;
  ctx.fillStyle = T.text;
  ctx.fillText(d.billNo, contentX, y);
  if (issueDate) {
    ctx.font = `400 12.5px ${CJK}`;
    ctx.fillStyle = T.soft;
    ctx.textAlign = 'right';
    ctx.fillText(issueDate.replace(/^開單日期　/, ''), contentR, y);
    ctx.textAlign = 'left';
  }
  y += 20;
  hline(contentX, contentR, y, T.hairline);

  // ===== VOID：唯一一句文件有效性聲明（其他 status 完全唔出現）=====
  if (isVoid) {
    y += 20;
    ctx.font = `500 13px ${CJK}`;
    const tw = ctx.measureText(VOID_ARCHIVE_NOTE).width;
    const bw = tw + 48;
    const bh = 40;
    ctx.fillStyle = T.panelSoft;
    ctx.fillRect(cx - bw / 2, y, bw, bh);
    ctx.strokeStyle = T.goldLine;
    ctx.strokeRect(cx - bw / 2 + 0.5, y + 0.5, bw - 1, bh - 1);
    ctx.fillStyle = T.goldBright;
    ctx.textAlign = 'center';
    ctx.fillText(VOID_ARCHIVE_NOTE, cx, y + bh / 2 + 4.5);
    ctx.textAlign = 'left';
    y += bh + 8;
    hline(contentX, contentR, y, T.hairline);
  }

  // ===== 客戶資料：客戶 / 帳期 / 專案 / 備註 / 訂單日期 / 場次 =====
  secLabel('客戶資料', 'CLIENT');
  const labelW = 92;
  meta.forEach(([k, v], i) => {
    ctx.font = `500 10px ${MONO}`;
    ctx.fillStyle = T.faint;
    fillSpaced(ctx, k, contentX, y + 12, 10 * 0.18, 'left');
    ctx.font = `500 13.5px ${CJK}`;
    ctx.fillStyle = T.text;
    const lines = wrapBillText(v, contentW - labelW - 18, (s) => ctx.measureText(s).width);
    lines.forEach((ln, li) => {
      ctx.textAlign = 'right';
      ctx.fillText(ln, contentR, y + 13 + li * 19);
      ctx.textAlign = 'left';
    });
    y += Math.max(19, lines.length * 19) + 12;
    if (i < meta.length - 1) hline(contentX, contentR, y - 4, T.hairline);
  });

  // ===== 服務明細 =====
  secLabel('服務明細', 'ITEMS');
  const colAmountR = contentR - 6;
  const colUnitR = contentR - 150;
  const colQtyR = contentR - 236;
  const nameMaxW = colQtyR - 24 - (contentX + 6);
  ctx.font = `500 10px ${MONO}`;
  ctx.fillStyle = T.faint;
  fillSpaced(ctx, '項目', contentX + 6, y + 10, 10 * 0.18, 'left');
  ctx.textAlign = 'right';
  ctx.fillText('數量', colQtyR, y + 10);
  ctx.fillText('單價', colUnitR, y + 10);
  ctx.fillText('小計', colAmountR, y + 10);
  ctx.textAlign = 'left';
  y += 20;
  hline(contentX, contentR, y, T.goldLine);
  for (const it of d.items) {
    const ld = lineDisc(it);
    y += 12 + 13;
    ctx.font = `400 13px ${CJK}`;
    ctx.fillStyle = T.text;
    const lines = wrapBillText(it.name, nameMaxW, (s) => ctx.measureText(s).width);
    lines.forEach((ln, li) => ctx.fillText(ln, contentX + 6, y + li * 17));
    ctx.textAlign = 'right';
    ctx.font = `400 12.5px ${MONO}`;
    ctx.fillText(String(it.qty), colQtyR, y);
    if (ld.has) {
      // 單價兩行：原價（faint 刪除線）喺上，折實價喺下
      const origTxt = fmtHKD(ld.orig);
      ctx.font = `400 10.5px ${MONO}`;
      ctx.fillStyle = T.faint;
      ctx.fillText(origTxt, colUnitR, y - 1);
      const ow = ctx.measureText(origTxt).width;
      ctx.strokeStyle = T.faint;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(colUnitR - ow, y - 4.5);
      ctx.lineTo(colUnitR, y - 4.5);
      ctx.stroke();
      ctx.font = `400 12.5px ${MONO}`;
      ctx.fillStyle = T.text;
      ctx.fillText(fmtHKD(it.unitPriceCents), colUnitR, y + 15);
    } else {
      ctx.fillText(fmtHKD(it.unitPriceCents), colUnitR, y);
    }
    ctx.fillText(fmtHKD(it.amountCents), colAmountR, y);
    ctx.textAlign = 'left';
    y += (lines.length - 1) * 17 + 12;
    if (ld.has) {
      const fold = ld.has && !ld.isGift ? foldLabel(ld.orig, it.unitPriceCents) : '';
      const tag = ld.isGift ? `贈品・全額折扣 −${fmtHKD(ld.disc)}` : `折咗 ${fmtHKD(ld.disc)}${fold ? `・${fold}` : ''}`;
      ctx.font = `500 10px ${MONO}`;
      const tw = ctx.measureText(tag).width;
      const tx = contentX + 6;
      const ty = y + 2;
      ctx.strokeStyle = T.goldLine;
      ctx.strokeRect(tx + 0.5, ty + 0.5, tw + 13, 16);
      ctx.fillStyle = T.goldBright;
      ctx.fillText(tag, tx + 7, ty + 12);
      y += 22;
    }
    hline(contentX, contentR, y, T.hairline);
  }

  // ===== 合計（grand row 用香檳金箔 panel，深色字）=====
  secLabel('合計', 'TOTAL');
  for (const r of totals) {
    if (r.kind === 'grand') {
      y += 14;
      const ph = 62;
      const grad = ctx.createLinearGradient(contentX, y, contentX, y + ph);
      grad.addColorStop(0, '#f0dc9a');
      grad.addColorStop(0.55, '#d4af37');
      grad.addColorStop(1, '#a8842c');
      ctx.fillStyle = grad;
      ctx.fillRect(contentX, y, contentW, ph);
      ctx.strokeStyle = T.goldDeep;
      ctx.lineWidth = 1;
      ctx.strokeRect(contentX + 0.5, y + 0.5, contentW - 1, ph - 1);
      ctx.font = `700 14px ${SERIF}`;
      ctx.fillStyle = T.ink;
      fillSpaced(ctx, r.label, contentX + 20, y + ph / 2 + 5, 14 * 0.2, 'left');
      ctx.font = `700 25px ${MONO}`;
      ctx.fillStyle = T.ink;
      ctx.textAlign = 'right';
      ctx.fillText(r.value, contentR - 20, y + ph / 2 + 9);
      ctx.textAlign = 'left';
      y += ph + 8;
      continue;
    }
    if (r.kind === 'saved') {
      y += 10 + 11;
      ctx.font = `400 11px ${MONO}`;
      ctx.fillStyle = T.soft;
      ctx.textAlign = 'right';
      ctx.fillText(r.value, contentR, y);
      ctx.textAlign = 'left';
      continue;
    }
    if (r.kind === 'adjustReason') {
      y += 4 + 11.5;
      ctx.font = `400 11.5px ${CJK}`;
      ctx.fillStyle = T.faint;
      ctx.textAlign = 'right';
      ctx.fillText(r.value, contentR, y);
      ctx.textAlign = 'left';
      y += 6;
      continue;
    }
    y += 8 + 13;
    const faintRow = r.kind === 'orig';
    ctx.font = `400 12px ${CJK}`;
    ctx.fillStyle = faintRow ? T.faint : T.soft;
    fillSpaced(ctx, r.label, contentX, y, 12 * 0.14, 'left');
    ctx.font = `500 13px ${MONO}`;
    ctx.fillStyle = faintRow ? T.faint : T.text;
    ctx.textAlign = 'right';
    ctx.fillText(r.value, contentR, y);
    if (faintRow) {
      const ow = ctx.measureText(r.value).width;
      ctx.strokeStyle = T.faint;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(contentR - ow, y - 3.5);
      ctx.lineTo(contentR, y - 3.5);
      ctx.stroke();
    }
    ctx.textAlign = 'left';
    y += 6;
  }

  // ===== 備註 snapshot（SPEC §5：text + updatedAt，唔公開操作人；有先畫）=====
  // 標題唔准孤伶伶留喺上頁底、第一行備註被切走；整個 NOTES section 盡量同一頁。
  let notesKeep: PublicBillKeepTogetherRange | null = null;
  if (d.notes.length > 0) {
    const notesKeepStart = y;
    secLabel('備註', 'NOTES');
    d.notes.forEach((n, i) => {
      ctx.font = `400 12.5px ${CJK}`;
      ctx.fillStyle = T.text;
      const lines = wrapBillText(n.text, contentW - 6, (s) => ctx.measureText(s).width);
      lines.forEach((ln, li) => ctx.fillText(ln, contentX + 6, y + 13 + li * 18));
      y += lines.length * 18 + 2;
      if (n.updatedAt) {
        ctx.font = `400 10px ${MONO}`;
        ctx.fillStyle = T.faint;
        ctx.fillText(`更新於 ${fmtDateTime(n.updatedAt)}`, contentX + 6, y + 11);
        y += 18;
      }
      y += 8;
      if (i < d.notes.length - 1) hline(contentX, contentR, y - 4, T.hairline);
    });
    notesKeep = { start: notesKeepStart, end: y };
  }

  // ===== 網上單據（canonical onlineUrl + QR；payload 同畫面顯示一字不變，SPEC §9 驗收）=====
  // keep-together：成個 ONLINE section（標題 + 提示 + URL + 整個 QR）係一個單位，PDF 分頁唔准由中間切開
  const onlineKeepStart = y;
  secLabel('網上單據', 'ONLINE');
  const qrCard = 128; // 白底卡（深底上 QR 一定要白底深 modules 先掃到）
  const qrSize = 104;
  const qrY = y + 4;
  ctx.fillStyle = T.white;
  ctx.fillRect(contentX, qrY, qrCard, qrCard);
  ctx.drawImage(qr, contentX + (qrCard - qrSize) / 2, qrY + (qrCard - qrSize) / 2, qrSize, qrSize);
  ctx.strokeStyle = T.gold;
  ctx.lineWidth = 1;
  ctx.strokeRect(contentX + 0.5, qrY + 0.5, qrCard - 1, qrCard - 1);
  // 右側：提示 + URL（逐字換行；同頁面顯示完全一致）
  const txX = contentX + qrCard + 18;
  const txW = contentR - txX;
  ctx.font = `400 11px ${CJK}`;
  ctx.fillStyle = T.soft;
  ctx.fillText('掃描二維碼或開啟以下連結查看單據', txX, qrY + 16);
  ctx.font = `400 10.5px ${MONO}`;
  ctx.fillStyle = T.soft;
  const urlLines = wrapBillText(qrPayload, txW, (s) => ctx.measureText(s).width);
  urlLines.forEach((ln, li) => ctx.fillText(ln, txX, qrY + 36 + li * 15));
  y = qrY + qrCard + 4;
  const onlineKeepEnd = y;

  // ===== 頁尾 =====
  y += 32;
  ornament(y);
  y += 26;
  ctx.font = `400 12.5px ${CJK}`;
  ctx.fillStyle = T.soft;
  fillSpaced(ctx, '如有查詢，請聯絡 Red Code', cx, y, 12.5 * 0.12);
  y += 20;
  ctx.font = `400 10px ${MONO}`;
  ctx.fillStyle = T.faint;
  fillSpaced(ctx, d.kind === 'project' ? '此連結為專屬專案服務單據' : '此連結為專屬月費單據', cx, y, 10 * 0.18);
  y += 46; // 底部留白（金框之內）

  return {
    usedH: y,
    keepTogether: [
      ...(notesKeep ? [notesKeep] : []),
      { start: onlineKeepStart, end: onlineKeepEnd },
    ],
  };
}

// ---------- 對外：render → canvas ----------
const LOGICAL_W = 640;
const SCALE = 2.5; // 高清輸出（1600px 闊）
const keepTogetherMeta = new WeakMap<HTMLCanvasElement, PublicBillKeepTogetherRange[]>();

export async function renderWebDesignPublicBillCanvas(
  d: WebDesignPublicBillView,
  logoSrc = WD_PUBLIC_BILL_LOGO_SRC,
): Promise<HTMLCanvasElement> {
  const qrPayload = qrPayloadForBill(d);
  // QR 失敗要 loud：唔准出無 QR 假完成單（SPEC §9）
  const [logo, qr] = await Promise.all([ensureFonts().then(() => loadImage(logoSrc)), loadQrImage(qrPayload)]);
  // pass 1：度高度
  const probe = document.createElement('canvas');
  probe.width = Math.round(LOGICAL_W * SCALE);
  probe.height = 8;
  const pctx = probe.getContext('2d');
  if (!pctx) throw new Error('瀏覽器唔支援 canvas');
  pctx.scale(SCALE, SCALE);
  const measured = drawSheet(pctx, d, logo, qr, qrPayload as string, LOGICAL_W);
  const usedH = measured.usedH;
  // pass 2：正式畫（傳埋 usedH，背景／金框畫到啱啱好嘅底邊）
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(LOGICAL_W * SCALE);
  canvas.height = Math.ceil(usedH * SCALE);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('瀏覽器唔支援 canvas');
  ctx.scale(SCALE, SCALE);
  const drawn = drawSheet(ctx, d, logo, qr, qrPayload as string, LOGICAL_W, usedH);
  keepTogetherMeta.set(canvas, drawn.keepTogether.map((r) => ({
    start: Math.round(r.start * SCALE),
    end: Math.round(r.end * SCALE),
  })));
  return canvas;
}

// ---------- 對外：安全檔名（以 billNo 為主，唔准路徑穿越）----------
export function webDesignPublicBillFileName(billNo: string, ext: 'png' | 'pdf'): string {
  const base = String(billNo ?? '')
    .trim()
    .replace(/[\\/]+/g, '_') // 路徑分隔（unix + windows）
    .replace(/\.{2,}/g, '_') // 「..」路徑穿越
    .replace(/[\x00-\x1f\x7f<>:"|?*]+/g, '_') // 控制字元 + Windows 禁用符號
    .replace(/^\.+/, '') // 開頭點（隱藏檔／相對路徑）
    .replace(/[.\s]+$/, '') // 尾點／尾空白（Windows 唔准）
    .slice(0, 120);
  return `${base || 'bill'}.${ext}`;
}

// ---------- 對外：下載 PNG ----------
export async function downloadWebDesignPublicBillPng(d: WebDesignPublicBillView, filename?: string): Promise<void> {
  const canvas = await renderWebDesignPublicBillCanvas(d);
  const name = filename || webDesignPublicBillFileName(d.billNo, 'png');
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  const url = blob ? URL.createObjectURL(blob) : canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (blob) setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- 對外：下載 PDF（jsPDF 用現有 npm 依賴 dynamic import；A4 全版出血多頁；同 PaymentHeroCard 做法）----------
// 記住成功嘅 promise 慳重複載入；失敗唔好 cache 住 rejected promise，下次重試（同 qrDataUrl 口徑）。
let jsPdfPromise: Promise<any> | null = null;
async function loadJsPdf(): Promise<any> {
  if (jsPdfPromise) return jsPdfPromise;
  jsPdfPromise = (async () => {
    const { jsPDF } = await import('jspdf');
    return jsPDF;
  })();
  try {
    return await jsPdfPromise;
  } catch (e) {
    jsPdfPromise = null;
    throw e instanceof Error ? e : new Error('PDF 元件載入失敗，請稍後再試');
  }
}

// 多頁分頁計劃（純邏輯，node 可測）：break 撞入 NOTES／ONLINE 中間就提前到 section 開頭。
// range 啱啱由頁頂開始但長過一頁時仍向前切，保證 h≥1，唔會零高 slice／死循環。
export function planWebDesignPublicBillPdfSlices(
  canvasHeight: number,
  sliceHPx: number,
  keepTogether: readonly PublicBillKeepTogetherRange[] = [],
): Array<{ y: number; h: number }> {
  const ranges = keepTogether.filter((r) => r.end > r.start && r.start > 0 && r.start < canvasHeight);
  const slices: Array<{ y: number; h: number }> = [];
  let y = 0;
  while (y < canvasHeight) {
    let h = Math.min(sliceHPx, canvasHeight - y);
    const breakY = y + h;
    if (breakY < canvasHeight) {
      for (const r of ranges) {
        if (breakY > r.start && breakY < r.end && r.start > y) {
          h = r.start - y;
          break;
        }
      }
    }
    slices.push({ y, h });
    y += h;
  }
  return slices;
}

// A4 全版出血排版＋多頁切圖
// 210×297mm 無白邊：canvas 闊 = 210mm，每頁 part canvas 固定完整 A4 像素比例（297mm 高），
// 先填滿文件背景再畫 source slice（短單尾部照樣係文件底色，唔縮細置中），addImage 鋪滿 0,0,210,297。
function buildWebDesignPublicBillPdfDoc(JsPDF: any, canvas: HTMLCanvasElement): any {
  const pdf = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  const pxPerMm = canvas.width / 210;
  const sliceHPx = Math.floor(297 * pxPerMm);
  const slices = planWebDesignPublicBillPdfSlices(canvas.height, sliceHPx, keepTogetherMeta.get(canvas) ?? []);
  let page = 0;
  for (const { y, h } of slices) {
    const part = document.createElement('canvas');
    part.width = canvas.width;
    part.height = sliceHPx; // 每頁固定完整 A4 像素比例
    const pctx = part.getContext('2d');
    if (!pctx) throw new Error('瀏覽器唔支援 canvas');
    pctx.fillStyle = BILL_THEME.bg;
    pctx.fillRect(0, 0, part.width, part.height); // 先填滿文件背景（全版出血無白邊）
    pctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
    if (page > 0) pdf.addPage();
    pdf.addImage(part.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 210, 297);
    page += 1;
  }
  return pdf;
}

export async function downloadWebDesignPublicBillPdf(d: WebDesignPublicBillView, filename?: string): Promise<void> {
  const [JsPDF, canvas] = await Promise.all([loadJsPdf(), renderWebDesignPublicBillCanvas(d)]);
  buildWebDesignPublicBillPdfDoc(JsPDF, canvas).save(filename || webDesignPublicBillFileName(d.billNo, 'pdf'));
}
