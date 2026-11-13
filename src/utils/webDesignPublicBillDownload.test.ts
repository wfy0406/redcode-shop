// ===== v2026.11.13.2 公開單據下載 — 純 helpers 測試（vitest node 環境）=====
// canvas / DOM 部分（renderWebDesignPublicBillCanvas、download*）唔喺 node 測；
// 呢度測：PDF 分頁 keep-together 純邏輯、固定開單日期 helper，
// 同 source-level 守衛（無付款／狀態渲染、黑金主題、full-bleed A4 參數、唔經 cdnjs）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { WebDesignPublicBillView } from '@/pages/webDesignPublicBill';
import { fmtDateTime } from '@/pages/webDesignPublicBill';
import {
  BILL_THEME,
  VOID_ARCHIVE_NOTE,
  WD_PUBLIC_BILL_LOGO_SRC,
  downloadWebDesignPublicBillPdf,
  downloadWebDesignPublicBillPng,
  planWebDesignPublicBillPdfSlices,
  renderWebDesignPublicBillCanvas,
  webDesignPublicBillFileName,
  webDesignPublicBillIssueDateLine,
  wrapBillText,
} from './webDesignPublicBillDownload';

const SOURCE = readFileSync(new URL('./webDesignPublicBillDownload.ts', import.meta.url), 'utf8');

describe('公開單據 PDF 分頁', () => {
  it('NOTES 標題唔會孤立喺上頁底；備註同 ONLINE 可以完整落入下一頁', () => {
    expect(planWebDesignPublicBillPdfSlices(3000, 1800, [
      { start: 1500, end: 2300 },
      { start: 2300, end: 2700 },
    ])).toEqual([
      { y: 0, h: 1500 },
      { y: 1500, h: 1500 },
    ]);
  });

  it('ONLINE QR／網址被擬議 break 切中時，提前去 ONLINE 開頭', () => {
    expect(planWebDesignPublicBillPdfSlices(3200, 1800, [{ start: 1700, end: 2500 }])).toEqual([
      { y: 0, h: 1700 },
      { y: 1700, h: 1500 },
    ]);
  });

  it('超長 section 由頁頂開始都保證向前，唔會零高 slice／死循環', () => {
    const slices = planWebDesignPublicBillPdfSlices(4000, 1000, [{ start: 1000, end: 3500 }]);
    expect(slices.every((s) => s.h > 0)).toBe(true);
    expect(slices.at(-1)).toEqual({ y: 3000, h: 1000 });
    expect(slices.reduce((n, s) => n + s.h, 0)).toBe(4000);
  });

  it('冇 keep-together metadata 時維持原本平均分頁', () => {
    expect(planWebDesignPublicBillPdfSlices(2500, 1000)).toEqual([
      { y: 0, h: 1000 }, { y: 1000, h: 1000 }, { y: 2000, h: 500 },
    ]);
  });

  it('PDF 元件只用現有 npm 同源 chunk，唔准返去 cdnjs 遠端 script', () => {
    expect(SOURCE).toContain("import('jspdf')");
    expect(SOURCE).not.toContain('cdnjs.cloudflare.com');
  });
});

// ===== v2026.11.13.2：PNG/PDF 係中性留底文件，source 唔准有付款／狀態渲染 =====
describe('留底文件守衛（source-level）', () => {
  it('唔出付款 CTA／手續費提示／付款狀態字句', () => {
    for (const banned of [
      '確認付款',
      '已付款',
      '待付款',
      'AWAITING',
      'PAID',
      '付款日期',
      '付款時間',
      '付款方式',
      '退款日期',
      '已退款',
      '實付金額',
      '手續費',
      'TEST MODE',
      '唔會真實扣款',
    ]) {
      expect(SOURCE).not.toContain(banned);
    }
  });

  it('唔再 import／使用付款狀態 helpers', () => {
    for (const banned of [
      'statusInfo',
      'primaryDateLine',
      'paidDetailLines',
      'surchargeNote',
      'canPay',
      'fmtMethod',
      'REFUNDED_NOTE',
      'paymentMethod',
      'customerPaidCents',
      'refundedAt',
      'refundedCents',
    ]) {
      expect(SOURCE).not.toContain(banned);
    }
  });

  it('唔再有 SEC 01/02 章節編號／遊戲 HUD node', () => {
    expect(SOURCE).not.toContain('SEC 0');
    expect(SOURCE).not.toContain('drawNode');
  });

  it('VOID 只保留一句文件有效性聲明', () => {
    expect(VOID_ARCHIVE_NOTE).toBe('此單據已作廢，只供紀錄留底');
    expect(SOURCE).toContain('此單據已作廢，只供紀錄留底');
  });

  it('QR 保留 canonical onlineUrl 口徑（qrPayloadForBill，loud fail）', () => {
    expect(SOURCE).toContain('qrPayloadForBill(d)');
    expect(SOURCE).toContain("import('qrcode')");
  });
});

describe('BILL_THEME（黑金文件主題）', () => {
  it('near-black 底＋香檳金主色', () => {
    expect(BILL_THEME.bg).toBe('#0a0805');
    expect(BILL_THEME.gold).toBe('#d4af37');
    expect(BILL_THEME.goldBright).toBe('#f0dc9a');
    expect(BILL_THEME.text).toBe('#f3ecd8');
  });

  it('唔再有 mission-control cyan／magenta／grid 主色', () => {
    expect(BILL_THEME).not.toHaveProperty('cyan');
    expect(BILL_THEME).not.toHaveProperty('magenta');
    expect(BILL_THEME).not.toHaveProperty('grid');
    expect(SOURCE).not.toContain('#3ee6ff');
    expect(SOURCE).not.toContain('#ff3d7f');
  });

  it('logo 用官網原裝透明 PNG 路徑（唔加白底）', () => {
    expect(WD_PUBLIC_BILL_LOGO_SRC).toBe('/logo.png');
  });
});

// ===== 固定開單日期：createdAt 優先，orderDate fallback，絕唔跟 status 轉付款／退款日期 =====
describe('webDesignPublicBillIssueDateLine（固定開單日期）', () => {
  it('createdAt 優先（經 fmtDateTime 本地時間格式化）', () => {
    const createdAt = '2026-11-13T03:04:00.000Z';
    const line = webDesignPublicBillIssueDateLine({ createdAt, orderDate: '2026-11-01' });
    expect(line).toBe(`開單日期　${fmtDateTime(createdAt)}`);
    expect(line).not.toContain('2026-11-01'); // 有 createdAt 就唔用 orderDate
  });

  it('冇 createdAt → orderDate fallback', () => {
    expect(webDesignPublicBillIssueDateLine({ createdAt: null, orderDate: '2026-11-01' })).toBe('開單日期　2026-11-01');
  });

  it('refunded 單都照用開單日期（唔係退款日期）', () => {
    const d = {
      status: 'refunded',
      refundedAt: '2026-11-15T10:00:00.000Z',
      createdAt: '2026-11-13T03:04:00.000Z',
      orderDate: null,
    } as WebDesignPublicBillView;
    // helper 只吃 createdAt/orderDate；連 status/refundedAt 都唔喺參數型別入面
    expect(webDesignPublicBillIssueDateLine(d)).toBe(`開單日期　${fmtDateTime('2026-11-13T03:04:00.000Z')}`);
  });

  it('兩樣都冇 → 空字串（唔出日期行）', () => {
    expect(webDesignPublicBillIssueDateLine({ createdAt: null, orderDate: null })).toBe('');
  });
});

// ===== v2026.11.13.2：PDF A4 全版出血（210×297mm 無白邊）=====
describe('PDF 全版出血排版（source-level）', () => {
  it('pxPerMm＝canvas.width/210、sliceHPx＝floor(297×pxPerMm)', () => {
    expect(SOURCE).toContain('canvas.width / 210');
    expect(SOURCE).toContain('Math.floor(297 * pxPerMm)');
  });

  it('每頁 part canvas 固定完整 A4 像素、先填文件背景再畫 slice、addImage 鋪滿 0,0,210,297', () => {
    expect(SOURCE).toContain('part.height = sliceHPx');
    expect(SOURCE).toContain('pctx.fillRect(0, 0, part.width, part.height)');
    expect(SOURCE).toContain('pctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h)');
    expect(SOURCE).toContain("'JPEG', 0, 0, 210, 297");
  });

  it('唔再有 10mm margin／短單縮細置中', () => {
    expect(SOURCE).not.toContain('MARGIN');
    expect(SOURCE).not.toContain('sliceHPx * 1.3');
    expect(SOURCE).not.toContain('contentWmm');
  });
});

describe('API surface regression', () => {
  it('download／renderer／helper 全部照舊 export', () => {
    expect(typeof downloadWebDesignPublicBillPng).toBe('function');
    expect(typeof downloadWebDesignPublicBillPdf).toBe('function');
    expect(typeof renderWebDesignPublicBillCanvas).toBe('function');
    expect(typeof webDesignPublicBillFileName).toBe('function');
    expect(typeof wrapBillText).toBe('function');
  });
});

describe('QR loud-fail gate（SPEC §9）', () => {
  it('缺 onlineUrl 時 renderer 直接 reject，唔出無 QR 假單', async () => {
    const bill = { billNo: 'WD-TEST-0001', onlineUrl: null } as WebDesignPublicBillView;
    await expect(renderWebDesignPublicBillCanvas(bill)).rejects.toThrow('網上連結');
  });
});
