import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const productsSource = readFileSync(new URL('./Products.tsx', import.meta.url), 'utf8');
const historySource = readFileSync(
  new URL('../components/push/LiveHistorySection.tsx', import.meta.url),
  'utf8',
);

describe('R10 直播頁原碼回歸', () => {
  it('有效場次 H1 用已驗證 shareTarget，唔再只用通用 introTitle', () => {
    expect(productsSource).toContain(
      'const pageHeading = shareTarget ? liveProductHeading(shareTarget) : introTitle;',
    );
    expect(productsSource).toMatch(/<h1[^>]*>\s*\{pageHeading\}\s*<\/h1>/);
  });

  it('只裁 pointer-events-none 光錐 wrapper，唔再 overflow-visible', () => {
    expect(historySource).toContain(
      'className="pointer-events-none absolute inset-x-0 -top-10 h-[420px] overflow-hidden"',
    );
    expect(historySource).not.toContain(
      'className="pointer-events-none absolute inset-x-0 -top-10 h-[420px] overflow-visible"',
    );
  });

  it('回顧卡保留橫向滑動，冇用 body 全局隱藏溢出', () => {
    expect(historySource).toMatch(/className="replay-shelf[^"]*overflow-x-auto[^"]*"/);
    expect(historySource).not.toMatch(/body\s*\{[^}]*overflow-x\s*:\s*hidden/s);
    expect(historySource).not.toContain('document.body.style.overflowX');
  });
});
