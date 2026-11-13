import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import WebDesignPublicBillPage from './WebDesignPublicBillPage';

/**
 * v2026-11-13-2 公開單據頁（website）黑金文件感重做 focused tests：
 * - 分節標籤全部改中文人性標籤，冇 SEC/HUD 字句
 * - 付款 CTA 保留（issued 狀態出「確認付款」按鈕）
 * - 下載提示改中性留底文案，唔再話下載文件同互動頁一模一樣
 * - document.title 三態 useEffect（loading／有效 bill／失效）喺 early return 之前，依賴完整
 * - Airwallex init 新口徑：initialized?.payments ?? sdk?.payments ?? window._AirwallexSDKs?.payment
 * - CSS：無 JetBrains Mono import／cyan／magenta／grid 背景／假斜體；reduced-motion + focus-visible + ≥44px
 */

const mocks = vi.hoisted(() => ({
  query: {
    data: null as null | Record<string, unknown>,
    isLoading: false,
    isError: false,
  },
  payMutation: { isPending: false, mutate: vi.fn() },
}));

vi.mock('@/providers/trpc', () => ({
  trpc: {
    webDesignPublicBill: {
      getPublic: { useQuery: () => mocks.query },
      confirmAndPay: { useMutation: () => mocks.payMutation },
    },
  },
}));

vi.mock('@/utils/webDesignPublicBillDownload', () => ({
  downloadWebDesignPublicBillPng: vi.fn(),
  downloadWebDesignPublicBillPdf: vi.fn(),
}));

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function makeBill(overrides: Record<string, unknown> = {}) {
  return {
    billNo: 'WD-2026-1101',
    customerName: '陳小姐',
    items: [{ name: '網站月費（11月）', qty: 1, unitPriceCents: 38800, amountCents: 38800 }],
    subtotalCents: 38800,
    adjustCents: 0,
    adjustLog: [],
    finalCents: 38800,
    status: 'issued',
    mode: 'live',
    createdAt: '2026-11-01T03:00:00.000Z',
    companyName: 'RedCode HK直播台',
    remark: null,
    surchargeOn: null,
    period: '2026-11',
    projectTitle: null,
    kind: 'monthly',
    publicToken: TOKEN,
    onlineUrl: `https://redcode.red/web-design-bill/${TOKEN}`,
    notes: [{ id: 'n1', text: '首月送多一次微調。', updatedAt: '2026-11-10T10:00:00.000Z' }],
    ...overrides,
  };
}

function renderPage(data: Record<string, unknown> | null = makeBill()) {
  mocks.query.data = data;
  mocks.query.isLoading = false;
  mocks.query.isError = false;
  return renderToString(
    <MemoryRouter initialEntries={[`/web-design-bill/${TOKEN}`]}>
      <Routes>
        <Route path="/web-design-bill/:token" element={<WebDesignPublicBillPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('v2026-11-13-2 WebDesignPublicBillPage（website）分節標籤＋功能保留', () => {
  it('中文人性分節標籤齊全，冇 SEC/HUD 字句', () => {
    const html = renderPage();
    for (const tag of ['單據資料', '客戶資料', '服務明細', '費用總計', '付款資料', '備註紀錄', '網上單據']) {
      expect(html).toContain(tag);
    }
    expect(html).not.toMatch(/SEC\s*\d/);
    expect(html).not.toContain('— BILL');
    expect(html).not.toContain('— STATUS');
  });

  it('issued 狀態保留付款 CTA 同金額', () => {
    const html = renderPage();
    expect(html).toContain('wdb-pay-btn');
    expect(html).toContain('確認付款');
    expect(html).toContain('HK$388.00');
  });

  it('已付款狀態唔出付款 CTA，狀態資訊保留', () => {
    const html = renderPage(
      makeBill({ status: 'paid', paidAt: '2026-11-05T09:30:00.000Z', customerPaidCents: 38800, paymentMethod: 'card' }),
    );
    expect(html).not.toContain('wdb-pay-btn');
    expect(html).toContain('已付款');
  });

  it('下載提示係中性留底文案，唔會話同互動頁一模一樣', () => {
    const html = renderPage();
    expect(html).toContain('下載版係中性留底單據');
    expect(html).toContain('網上付款請用本頁付款掣');
    expect(html).not.toContain('成張單據完整落嚟');
  });

  it('單據不存在／token 唔啱 → 錯誤態', () => {
    const html = renderPage(null);
    expect(html).toContain('單據不存在或已失效');
    expect(html).not.toContain('wdb-pay-btn');
  });
});

describe('v2026-11-13-2 WebDesignPublicBillPage.tsx（source 層契約）', () => {
  const src = readFileSync(resolve(__dirname, 'WebDesignPublicBillPage.tsx'), 'utf8');

  it('document.title 三態：載入中／有效單據／失效', () => {
    expect(src).toContain("document.title = '單據載入中｜RedCode Fashion Design'");
    expect(src).toContain('`${bill.billNo}｜${billTitles(bill.kind).zh}｜RedCode Fashion Design`');
    expect(src).toContain("document.title = '單據不存在或已失效｜RedCode Fashion Design'");
    // useEffect 依賴完整
    expect(src).toContain('[tokenValid, query.isLoading, query.isError, bill]');
    // hook 一定要喺第一個 early return（載入中分支）之前
    const effectIdx = src.indexOf('useEffect(() => {\n    if (tokenValid && query.isLoading)');
    const earlyReturnIdx = src.indexOf('// ---------- 載入中 ----------');
    expect(effectIdx).toBeGreaterThan(-1);
    expect(earlyReturnIdx).toBeGreaterThan(effectIdx);
  });

  it('Airwallex init 新口徑，舊 loader 註釋移除', () => {
    expect(src).toContain("const initialized = await sdk.init({ env, enabledElements: ['payments'] });");
    expect(src).toContain(
      'const payments = initialized?.payments ?? sdk?.payments ?? (window as any)?._AirwallexSDKs?.payment;',
    );
    expect(src).not.toContain('永遠唔會挂');
    // redirectToCheckout 流程保留
    expect(src).toContain('payments.redirectToCheckout');
    // loader 失敗 cache reset 保留
    expect(src).toContain('awSdkPromise = null');
  });

  it('冇 SEC 標籤殘留喺 tsx', () => {
    expect(src).not.toMatch(/SEC\s*\d+\s*—/);
  });
});

describe('v2026-11-13-2 WebDesignPublicBillPage.css（黑金文件感）', () => {
  const css = readFileSync(resolve(__dirname, 'WebDesignPublicBillPage.css'), 'utf8');
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('移除 JetBrains Mono import / cyan / magenta / grid 背景', () => {
    expect(css).not.toContain('JetBrains Mono');
    expect(css).not.toContain('#3ee6ff');
    expect(css).not.toContain('#ff3d7f');
    expect(cssNoComments).not.toContain('repeating-linear-gradient');
  });

  it('serif 標題 token＋香檳金 palette＋箔金邊框', () => {
    expect(css).toContain('--wdb-serif');
    expect(css).toContain('--wdb-gold');
    expect(css).toContain('border-box'); // 漸變金屬邊框（border-image / background border-box）
    expect(css).toContain('background-clip: text');
  });

  it('中文唔用假斜體', () => {
    expect(cssNoComments).not.toMatch(/font-style\s*:\s*italic/);
  });

  it('付款 CTA 深色實心＋金邊、熱區 ≥44px', () => {
    const payBlock = css.slice(css.indexOf('.wdb-pay-btn {'), css.indexOf('.wdb-pay-btn:hover'));
    expect(payBlock).toContain('min-height: 52px');
    expect(payBlock).toContain('border: 1px solid var(--wdb-gold)');
  });

  it('reduced-motion + focus-visible 保留', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain(':focus-visible');
  });
});
