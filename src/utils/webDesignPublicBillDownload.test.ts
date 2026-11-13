import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planWebDesignPublicBillPdfSlices } from './webDesignPublicBillDownload';

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
    const source = readFileSync(new URL('./webDesignPublicBillDownload.ts', import.meta.url), 'utf8');
    expect(source).toContain("import('jspdf')");
    expect(source).not.toContain('cdnjs.cloudflare.com');
  });
});
