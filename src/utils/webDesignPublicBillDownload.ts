// ===== v2026.11.13.1 redcode.red 公開單據下載（圖片 PNG / PDF）=====
// 用 <canvas> 手畫成張單（唔用 html2canvas — 新 CSS 色函數佢 parse 唔到會爆）；
// 排版同 WebDesignPublicBillPage DOM 一致：dark mission-control — #050810 / panel #0c1220 /
// hairline #1a2540 / cyan 只做 active-live + 付款 CTA / magenta 只做 billNo node。
// 排版／顏色／字句全部經 webDesignPublicBill.ts helpers 產生，同 DOM 預覽一口徑。
// SPEC §9：QR payload 固定係後端回傳嘅 onlineUrl（https://redcode.red/web-design-bill/<token>），
//   網上頁顯示嘅 URL＋QR 同下載 PNG/PDF 完全一致；QR 用 website 現有 `qrcode` 包 dynamic import
//   （同 PaymentHeroCard 做法，唔加新 dependency）；QR 生成失敗要 loud throw，唔准出無 QR 假完成單。
// PDF：jsPDF 用 website 現有 npm 依賴 `jspdf` dynamic import（同 PaymentHeroCard 做法，唔塞首屏 bundle；
// 唔再用 cdnjs 遠端 script——production CSP script-src 冇 cdnjs 會擋死），A4 多頁切圖。

import {
  REFUNDED_NOTE,
  billTitles,
  canPay,
  discountTotals,
  foldLabel,
  fmtHKD,
  fmtDateTime,
  fmtMethod,
  lineDisc,
  metaRows,
  paidDetailLines,
  primaryDateLine,
  qrPayloadForBill,
  statusInfo,
  surchargeNote,
  totalsPlan,
  type WebDesignPublicBillView,
} from '@/pages/webDesignPublicBill';

// ---------- 主題（同 WebDesignPublicBillPage.css 一對一）----------
export const BILL_THEME = {
  bg: '#050810',
  panel: '#0c1220',
  line: '#1a2540',
  lineStrong: '#26324e',
  text: '#dbe4f2',
  soft: '#93a1b8',
  faint: '#5f6b80',
  cyan: '#3ee6ff',
  cyanDim: 'rgba(62,230,255,0.14)',
  magenta: '#ff3d7f',
  amber: '#ffc24b',
  amberDim: 'rgba(255,194,75,0.08)',
  white: '#ffffff',
  grid: 'rgba(26,37,64,0.3)',
} as const;

const MONO = `'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace`;
const CJK = `'PingFang HK','PingFang TC','PingFang SC','Microsoft JhengHei','Microsoft YaHei','Noto Sans CJK TC',sans-serif`;

const COMPANY_FALLBACK = 'RedCode HK直播台';
// 官網現有原裝 logo（public/logo.png）；WMS 嗰隻 redcode-web-design-logo.png 官網冇，唔好抄過嚟
export const WD_PUBLIC_BILL_LOGO_SRC = '/logo.png';

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

// ---------- 狀態 node（8px 圓點；live/done 實心 cyan，其餘空心）----------
function drawNode(ctx: CanvasRenderingContext2D, x: number, cy: number, tone: 'live' | 'done' | 'muted' | 'dead'): void {
  ctx.beginPath();
  ctx.arc(x, cy, 4, 0, Math.PI * 2);
  if (tone === 'live' || tone === 'done') {
    ctx.fillStyle = BILL_THEME.cyan;
    ctx.fill();
  } else {
    ctx.strokeStyle = tone === 'muted' ? BILL_THEME.soft : BILL_THEME.faint;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
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

// 等 JetBrains Mono ready（頁面 CSS 已 inject Google Fonts；最多等 1.8s 免阻住）
let fontsPromise: Promise<void> | null = null;
function ensureFonts(): Promise<void> {
  if (fontsPromise) return fontsPromise;
  fontsPromise = (async () => {
    try {
      const wants = ['400 12px "JetBrains Mono"', '500 13px "JetBrains Mono"', '700 24px "JetBrains Mono"'];
      await Promise.race([
        Promise.all(wants.map((f) => (document as any).fonts?.load?.(f).catch(() => undefined))),
        new Promise((r) => setTimeout(r, 1800)),
      ]);
      await Promise.race([(document as any).fonts?.ready ?? Promise.resolve(), new Promise((r) => setTimeout(r, 400))]);
    } catch {
      /* 字體慢都照畫（fallback mono） */
    }
  })();
  return fontsPromise;
}

// ---------- 主繪製：回傳總高度＋唔准由中間切開嘅 section（logical px）；two-pass 用 ----------
export interface PublicBillKeepTogetherRange {
  start: number;
  end: number;
}

function drawSheet(
  ctx: CanvasRenderingContext2D,
  d: WebDesignPublicBillView,
  logo: HTMLImageElement | null,
  qr: HTMLImageElement,
  qrPayload: string,
  W: number,
): { usedH: number; keepTogether: PublicBillKeepTogetherRange[] } {
  const T = BILL_THEME;
  const PAD = 16;
  const SHEET_PAD_X = 24;
  const sheetX = PAD;
  const sheetW = W - PAD * 2;
  const contentX = sheetX + SHEET_PAD_X;
  const contentW = sheetW - SHEET_PAD_X * 2;
  const contentR = contentX + contentW;
  const cx = W / 2;
  const BIG = 6000; // measure pass 用嘅「夠大」高度；real pass 會啱啱好

  const company = d.companyName || COMPANY_FALLBACK;
  const st = statusInfo(d.status);
  const isTest = d.mode === 'test';
  const isPaid = st.key === 'paid';
  const isRefunded = st.key === 'refunded';
  const isIssued = st.key === 'issued';
  const payable = canPay(d);
  const dateLine = primaryDateLine(d);
  const meta = metaRows(d);
  const totals = totalsPlan(d);
  const paidLines = paidDetailLines(d);
  const disc = discountTotals(d.items);
  const titles = billTitles(d.kind);

  // 底：near-black + 細 grid（同色 hard-stop 線）
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, W, BIG);
  ctx.strokeStyle = T.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = 56; gx < W; gx += 56) {
    ctx.moveTo(gx + 0.5, 0);
    ctx.lineTo(gx + 0.5, BIG);
  }
  for (let gy = 56; gy < BIG; gy += 56) {
    ctx.moveTo(0, gy + 0.5);
    ctx.lineTo(W, gy + 0.5);
  }
  ctx.stroke();

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

  // ===== 頂欄 band：logo + 公司名 +（右）test badge + 狀態 node =====
  let y = 0;
  const bandH = 76;
  let bx = PAD;
  if (logo) {
    const lh = 48;
    const lw = (logo.naturalWidth / logo.naturalHeight) * lh;
    ctx.drawImage(logo, bx, (bandH - lh) / 2, lw, lh); // 透明 PNG 直接落深色底，唔加白底
    bx += lw + 14;
  }
  ctx.font = `500 11px ${MONO}`;
  ctx.fillStyle = T.soft;
  fillSpaced(ctx, company.toUpperCase(), bx, bandH / 2 + 4, 11 * 0.18, 'left');
  // 右側：狀態 chip（+ test badge）
  const chipText = `${st.zh} · ${st.en}`;
  ctx.font = `500 11px ${MONO}`;
  const chipW = ctx.measureText(chipText).width + 11 * 0.14 * ([...chipText].length - 1);
  let rx = W - PAD;
  const chipColor = st.tone === 'live' || st.tone === 'done' ? T.cyan : T.soft;
  ctx.fillStyle = chipColor;
  fillSpaced(ctx, chipText, rx, bandH / 2 + 4, 11 * 0.14, 'right');
  rx -= chipW + 10;
  drawNode(ctx, rx - 4, bandH / 2, st.tone);
  rx -= 8 + 14;
  if (isTest) {
    const t = 'TEST MODE — 唔會真實扣款';
    ctx.font = `500 10px ${MONO}`;
    const tw = ctx.measureText(t).width;
    const bw = tw + 20;
    const bh = 26;
    ctx.fillStyle = T.amberDim;
    ctx.fillRect(rx - bw, (bandH - bh) / 2, bw, bh);
    ctx.strokeStyle = T.amber;
    ctx.strokeRect(rx - bw + 0.5, (bandH - bh) / 2 + 0.5, bw - 1, bh - 1);
    ctx.fillStyle = T.amber;
    fillSpaced(ctx, t, rx - bw / 2, bandH / 2 + 3.5, 10 * 0.1);
  }
  hline(0, W, bandH, T.line);
  y = bandH;

  // ===== sheet 面板 =====
  const sheetTop = y + 32;
  ctx.fillStyle = T.panel;
  ctx.fillRect(sheetX, sheetTop, sheetW, BIG - sheetTop);
  ctx.strokeStyle = T.line;
  ctx.strokeRect(sheetX + 0.5, sheetTop + 0.5, sheetW - 1, BIG - sheetTop - 1);
  y = sheetTop;

  const secTag = (label: string) => {
    y += 22;
    ctx.fillStyle = T.lineStrong;
    ctx.fillRect(contentX, y + 2, 5, 5);
    ctx.font = `500 10px ${MONO}`;
    ctx.fillStyle = T.faint;
    fillSpaced(ctx, label, contentX + 13, y + 8, 10 * 0.22, 'left');
    y += 18;
  };
  const secEnd = () => {
    y += 22;
    hline(sheetX, sheetX + sheetW, y, T.line);
  };

  // ===== SEC 01：標題 + 單號 + 日期（project 單用專案標題，SPEC §5）=====
  secTag('SEC 01 — BILL');
  ctx.font = `700 18px ${CJK}`;
  ctx.fillStyle = T.text;
  y += 18;
  ctx.fillText(titles.zh, contentX, y);
  // 右側狀態（node + zh）
  ctx.font = `500 12px ${MONO}`;
  const stW = ctx.measureText(st.zh).width + 12 * 0.16 * ([...st.zh].length - 1);
  ctx.fillStyle = chipColor;
  fillSpaced(ctx, st.zh, contentR, y, 12 * 0.16, 'right');
  drawNode(ctx, contentR - stW - 10 - 4, y - 4.5, st.tone);
  y += 10;
  ctx.font = `500 10px ${MONO}`;
  ctx.fillStyle = T.faint;
  fillSpaced(ctx, titles.en, contentX, y, 10 * 0.26, 'left');
  y += 24;
  // 單號：magenta node + mono
  ctx.fillStyle = T.magenta;
  ctx.fillRect(contentX, y - 10, 7, 7);
  ctx.font = `500 15px ${MONO}`;
  ctx.fillStyle = T.text;
  fillSpaced(ctx, d.billNo, contentX + 17, y, 15 * 0.06, 'left');
  if (dateLine) {
    y += 22;
    ctx.font = `400 11px ${MONO}`;
    ctx.fillStyle = T.soft;
    fillSpaced(ctx, dateLine, contentX + 17, y, 11 * 0.08, 'left');
  }
  secEnd();

  // ===== SEC 02：客戶 / 帳期 / 專案 / 備註 =====
  secTag('SEC 02 — CLIENT');
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
    if (i < meta.length - 1) hline(contentX, contentR, y - 4, T.line);
  });
  secEnd();

  // ===== SEC 03：明細 =====
  secTag('SEC 03 — ITEMS');
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
  hline(contentX, contentR, y, T.lineStrong);
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
      ctx.strokeStyle = T.lineStrong;
      ctx.strokeRect(tx + 0.5, ty + 0.5, tw + 13, 16);
      ctx.fillStyle = T.soft;
      ctx.fillText(tag, tx + 7, ty + 12);
      y += 22;
    }
    hline(contentX, contentR, y, T.line);
  }
  secEnd();

  // ===== SEC 04：合計 =====
  secTag('SEC 04 — TOTAL');
  for (const r of totals) {
    if (r.kind === 'grand') {
      y += 10;
      hline(contentX, contentR, y, T.lineStrong);
      y += 18 + 24;
      ctx.font = `700 13px ${CJK}`;
      ctx.fillStyle = T.text;
      fillSpaced(ctx, r.label, contentX, y - 7, 13 * 0.2, 'left');
      ctx.font = `700 24px ${MONO}`;
      ctx.fillStyle = T.white;
      ctx.textAlign = 'right';
      ctx.fillText(r.value, contentR, y);
      ctx.textAlign = 'left';
      y += 16;
      hline(contentX, contentR, y, T.lineStrong);
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
  void disc; // 折扣行已由 totalsPlan 產生，呢度唔再分支
  secEnd();

  // ===== SEC 05：狀態 + 付款 =====
  secTag('SEC 05 — STATUS');
  // 狀態 box
  const boxTop = y;
  let by = boxTop + 16;
  ctx.font = `500 12px ${MONO}`;
  ctx.fillStyle = chipColor;
  drawNode(ctx, contentX + 16 + 4, by - 4, st.tone);
  fillSpaced(ctx, st.zh, contentX + 16 + 16, by, 12 * 0.16, 'left');
  const zhW = ctx.measureText(st.zh).width + 12 * 0.16 * ([...st.zh].length - 1);
  ctx.font = `500 10px ${MONO}`;
  ctx.fillStyle = T.faint;
  fillSpaced(ctx, st.en, contentX + 16 + 16 + zhW + 12, by, 10 * 0.22, 'left');
  by += 8;

  if (isPaid && paidLines.length > 0) {
    by += 8;
    for (const ln of paidLines) {
      by += 13 * 1.4;
      ctx.font = `${ln.strong ? '700' : '400'} 13px ${ln.strong ? MONO : CJK}`;
      ctx.fillStyle = ln.warn ? T.amber : T.text;
      ctx.fillText(ln.text, contentX + 16, by);
      by += 13 * 0.6;
    }
  }
  if (isRefunded) {
    const rLines: string[] = [];
    if (d.refundedAt) rLines.push(`退款時間　${fmtDateTime(d.refundedAt)}`);
    if (typeof d.refundedCents === 'number' && d.refundedCents > 0) rLines.push(`已退款　${fmtHKD(d.refundedCents)}`);
    if (d.paymentMethod) rLines.push(`付款方式　${fmtMethod(d.paymentMethod)}`);
    by += 8;
    for (const ln of rLines) {
      by += 13 * 1.4;
      ctx.font = `400 13px ${CJK}`;
      ctx.fillStyle = T.text;
      ctx.fillText(ln, contentX + 16, by);
      by += 13 * 0.6;
    }
    by += 6 + 12;
    ctx.font = `400 12px ${CJK}`;
    ctx.fillStyle = T.soft;
    ctx.fillText(REFUNDED_NOTE, contentX + 16, by);
    by += 8;
  }
  if (st.key === 'void') {
    by += 8 + 12;
    ctx.font = `400 12px ${CJK}`;
    ctx.fillStyle = T.soft;
    ctx.fillText('此單據已作廢，唔使付款。如有疑問請聯絡 Red Code。', contentX + 16, by);
    by += 8;
  }
  by += 16;
  ctx.strokeStyle = T.line;
  ctx.strokeRect(contentX + 0.5, boxTop + 0.5, contentW - 1, by - boxTop - 1);
  y = by;

  // 付款 CTA（issued 且金額有效先有；畫布如實重現預覽嘅實心 cyan 掣 + 手續費提示）
  if (isIssued && payable) {
    y += 16;
    const ctaH = 48;
    ctx.fillStyle = T.cyan;
    ctx.fillRect(contentX, y, contentW, ctaH);
    ctx.font = `700 14px ${CJK}`;
    ctx.fillStyle = T.bg;
    fillSpaced(ctx, `確認付款　${fmtHKD(d.finalCents)}`, cx, y + ctaH / 2 + 5, 14 * 0.2);
    y += ctaH;
    y += 14 + 11;
    ctx.font = `400 11px ${CJK}`;
    ctx.fillStyle = T.faint;
    const note = surchargeNote(d);
    const noteLines = wrapBillText(note, contentW, (s) => ctx.measureText(s).width);
    noteLines.forEach((ln, li) => {
      ctx.textAlign = 'center';
      ctx.fillText(ln, cx, y + li * 18);
      ctx.textAlign = 'left';
    });
    y += (noteLines.length - 1) * 18;
  } else if (isIssued) {
    y += 14 + 11;
    ctx.font = `400 11px ${CJK}`;
    ctx.fillStyle = T.faint;
    ctx.textAlign = 'center';
    ctx.fillText('此單據無需付款。', cx, y);
    ctx.textAlign = 'left';
  }
  secEnd();

  // ===== SEC 06：備註紀錄（SPEC §5：text + updatedAt，唔公開操作人；有先畫）=====
  // 標題唔准孤伶伶留喺上頁底、第一行備註被切走；整個 NOTES section 盡量同一頁。
  let notesKeep: PublicBillKeepTogetherRange | null = null;
  if (d.notes.length > 0) {
    const notesKeepStart = y;
    secTag('SEC 06 — NOTES');
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
      if (i < d.notes.length - 1) hline(contentX, contentR, y - 4, T.line);
    });
    secEnd();
    notesKeep = { start: notesKeepStart, end: y };
  }

  // ===== SEC：網上單據（QR + onlineUrl；payload 同畫面顯示一字不變，SPEC §9 驗收）=====
  const onlineKeepStart = y;
  secTag('ONLINE — 網上單據');
  const qrSize = 96;
  const qrBoxTop = y + 4;
  // 白底盒（深底上 QR 一定要白底深字先掃到）
  ctx.fillStyle = T.white;
  ctx.fillRect(contentX, qrBoxTop, qrSize, qrSize);
  ctx.drawImage(qr, contentX + 6, qrBoxTop + 6, qrSize - 12, qrSize - 12);
  // 右側：提示 + URL（逐字換行；同頁面顯示完全一致）
  const txX = contentX + qrSize + 18;
  const txW = contentR - txX;
  ctx.font = `400 11px ${CJK}`;
  ctx.fillStyle = T.soft;
  ctx.fillText('掃描二維碼或開啟以下連結查看單據', txX, qrBoxTop + 14);
  ctx.font = `400 10.5px ${MONO}`;
  ctx.fillStyle = T.faint;
  const urlLines = wrapBillText(qrPayload, txW, (s) => ctx.measureText(s).width);
  urlLines.forEach((ln, li) => ctx.fillText(ln, txX, qrBoxTop + 34 + li * 15));
  y = qrBoxTop + qrSize + 4;
  // footer 區（最後一個 sec 無底線）
  y += 24;
  ctx.font = `400 12.5px ${CJK}`;
  ctx.fillStyle = T.text;
  fillSpaced(ctx, '如有查詢，請聯絡 Red Code', cx, y, 12.5 * 0.12);
  y += 10 + 10;
  ctx.font = `400 10px ${MONO}`;
  ctx.fillStyle = T.faint;
  fillSpaced(ctx, d.kind === 'project' ? '此連結為專屬專案服務單據' : '此連結為專屬月費單據', cx, y, 10 * 0.18);
  y += 26; // sheet padding-bottom

  return {
    usedH: y,
    keepTogether: [
      ...(notesKeep ? [notesKeep] : []),
      { start: onlineKeepStart, end: y },
    ],
  };
}

// 已作廢：全單灰階 + 調暗（跟 CSS filter: grayscale(1); opacity:.72）
function applyVoidGrayscale(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  try {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = img.data;
    for (let i = 0; i < px.length; i += 4) {
      const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      px[i] = px[i + 1] = px[i + 2] = g;
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = 'rgba(5,8,16,0.28)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } catch {
    /* 灰階失敗都唔阻下載 */
  }
}

// ---------- 對外：render → canvas ----------
const LOGICAL_W = 640; // 跟 WebDesignPublicBillPage sheet max-width（680 連邊距嘅內容闊）
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
  // pass 2：正式畫
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(LOGICAL_W * SCALE);
  canvas.height = Math.ceil(usedH * SCALE);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('瀏覽器唔支援 canvas');
  ctx.scale(SCALE, SCALE);
  const drawn = drawSheet(ctx, d, logo, qr, qrPayload as string, LOGICAL_W);
  keepTogetherMeta.set(canvas, drawn.keepTogether.map((r) => ({
    start: Math.round(r.start * SCALE),
    end: Math.round(r.end * SCALE),
  })));
  // sheet 底邊（drawSheet 嘅邊框畫咗落 6000，呢度補正確位置嘅底邊線）
  ctx.strokeStyle = BILL_THEME.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(16, usedH - 0.5);
  ctx.lineTo(LOGICAL_W - 16, usedH - 0.5);
  ctx.stroke();
  if (d.status === 'void') applyVoidGrayscale(canvas);
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

// ---------- 對外：下載 PDF（jsPDF 用現有 npm 依賴 dynamic import；A4 多頁；同 PaymentHeroCard 做法）----------
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

// 多頁分頁計劃：break 撞入 NOTES／ONLINE 中間就提前到 section 開頭。
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

// A4 排版＋多頁切圖
function buildWebDesignPublicBillPdfDoc(JsPDF: any, canvas: HTMLCanvasElement): any {
  const pdf = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  const PAGE_W = 210;
  const PAGE_H = 297;
  const MARGIN = 10;
  const contentWmm = PAGE_W - MARGIN * 2;
  const pxPerMm = canvas.width / contentWmm;
  const sliceHPx = Math.floor((PAGE_H - MARGIN * 2) * pxPerMm);
  // 一頁放得晒（或超少少 ≤30%，縮到 ≥77% 仲好清晰）：等比縮細置中放一頁，唔好硬切（短單常見）
  if (canvas.height <= sliceHPx * 1.3) {
    const fit = Math.min(1, sliceHPx / canvas.height);
    const wmm = contentWmm * fit;
    pdf.addImage(
      canvas.toDataURL('image/jpeg', 0.95),
      'JPEG',
      MARGIN + (contentWmm - wmm) / 2,
      MARGIN,
      wmm,
      (canvas.height / pxPerMm) * fit,
    );
    return pdf;
  }
  const slices = planWebDesignPublicBillPdfSlices(canvas.height, sliceHPx, keepTogetherMeta.get(canvas) ?? []);
  let page = 0;
  for (const { y, h } of slices) {
    const part = document.createElement('canvas');
    part.width = canvas.width;
    part.height = h;
    const pctx = part.getContext('2d');
    if (!pctx) throw new Error('瀏覽器唔支援 canvas');
    pctx.fillStyle = BILL_THEME.bg;
    pctx.fillRect(0, 0, part.width, h);
    pctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
    if (page > 0) pdf.addPage();
    pdf.addImage(part.toDataURL('image/jpeg', 0.95), 'JPEG', MARGIN, MARGIN, contentWmm, h / pxPerMm);
    page += 1;
  }
  return pdf;
}

export async function downloadWebDesignPublicBillPdf(d: WebDesignPublicBillView, filename?: string): Promise<void> {
  const [JsPDF, canvas] = await Promise.all([loadJsPdf(), renderWebDesignPublicBillCanvas(d)]);
  buildWebDesignPublicBillPdfDoc(JsPDF, canvas).save(filename || webDesignPublicBillFileName(d.billNo, 'pdf'));
}
