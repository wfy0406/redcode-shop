import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import ProductDetail from './ProductDetail';

/**
 * 商品詳情頁改版測試（2026-11-12）：
 * - 「商品小筆記」DOM 順序喺售價帶上面（手機單欄視覺順序 = DOM 順序）
 * - 商品描述／重點標籤真資料原樣保留，唔改字
 * - 售價帶用新 pd-price class（同小筆記同一視覺語言）
 * - product-story.css 唔再係奶油紙卡，並有 reduced-motion guard
 */

const mocks = vi.hoisted(() => ({
  byIdQuery: {
    data: null as null | Record<string, unknown>,
    error: null as null | { message: string },
    isError: false,
    refetch: vi.fn(),
  },
  listQuery: { data: [] as unknown[], refetch: vi.fn() },
  addMutation: { isPending: false, mutate: vi.fn() },
  utils: { cart: { list: { invalidate: vi.fn() } } },
}));

vi.mock('@/providers/trpc', () => ({
  trpc: {
    useUtils: () => mocks.utils,
    products: {
      byId: { useQuery: () => mocks.byIdQuery },
      list: { useQuery: () => mocks.listQuery },
    },
    cart: { add: { useMutation: () => mocks.addMutation } },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: null }),
}));

const DESCRIPTION = '黑色背心身配啡色翻領，領位同左胸口袋都係啡色。\n\n襯長袖底衫或高領打底都好有層次感。';

function renderDetail(overrides: Record<string, unknown> = {}) {
  mocks.byIdQuery.data = {
    id: 1,
    sku: 'B249',
    name: '黑拼啡領拉鏈背心外套',
    description: DESCRIPTION,
    image: '/product-1.jpg',
    price: 168,
    discountPrice: null,
    sizes: null,
    sizeEnabled: false,
    category: 'top',
    listedDate: new Date('2026-11-12T00:00:00Z'),
    stock: 20,
    isActive: true,
    aiTags: ['黑色', '背心', '拼色翻領'],
    liveDate: null,
    liveSession: null,
    ...overrides,
  };
  return renderToString(
    <MemoryRouter initialEntries={['/products/1']}>
      <Routes>
        <Route path="/products/:id" element={<ProductDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProductDetail 商品小筆記＋售價帶（DOM 順序＋內容保留）', () => {
  it('小筆記（ps-story）喺售價帶（pd-price）上面', () => {
    const html = renderDetail();
    const storyIdx = html.indexOf('ps-story');
    const priceIdx = html.indexOf('pd-price');
    expect(storyIdx).toBeGreaterThan(-1);
    expect(priceIdx).toBeGreaterThan(-1);
    expect(storyIdx).toBeLessThan(priceIdx);
  });

  it('商品描述原樣保留（兩段都出，字唔改）', () => {
    const html = renderDetail();
    expect(html).toContain('黑色背心身配啡色翻領，領位同左胸口袋都係啡色。');
    expect(html).toContain('襯長袖底衫或高領打底都好有層次感。');
    expect(html).toContain('商品小筆記');
    expect(html).toContain('重點標籤');
  });

  it('重點標籤原樣保留、順序一致', () => {
    const html = renderDetail();
    // 鎖定標籤區（tag 字會撞商品名／描述）
    const start = html.indexOf('ps-tags');
    const end = html.indexOf('</ul>', start);
    expect(start).toBeGreaterThan(-1);
    const block = html.slice(start, end);
    const i0 = block.indexOf('黑色');
    const i1 = block.indexOf('背心');
    const i2 = block.indexOf('拼色翻領');
    expect(i0).toBeGreaterThan(-1);
    expect(i0).toBeLessThan(i1);
    expect(i1).toBeLessThan(i2);
  });

  it('售價帶顯示真價錢（pd-price-amount）', () => {
    const html = renderDetail();
    expect(html).toContain('pd-price-amount');
    expect(html).toContain('HK$168');
  });

  it('冇描述冇標籤 → 小筆記唔出，售價帶照舊', () => {
    const html = renderDetail();
    mocks.byIdQuery.data = {
      ...(mocks.byIdQuery.data as Record<string, unknown>),
      description: null,
      aiTags: [],
    };
    const html2 = renderToString(
      <MemoryRouter initialEntries={['/products/1']}>
        <Routes>
          <Route path="/products/:id" element={<ProductDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(html2).not.toContain('ps-story');
    expect(html2).toContain('pd-price-amount');
    expect(html).toContain('ps-story');
  });
});

describe('U03 分類係真連結', () => {
  it('分類 pill 係 <a> 去 /products?category=top（唔再係純文字）', () => {
    const html = renderDetail();
    // pd-cat link：href 正確、文字係類別 label、唔係 <span>
    const start = html.indexOf('pd-cat');
    expect(start).toBeGreaterThan(-1);
    const block = html.slice(Math.max(0, start - 200), start + 300);
    expect(block).toContain('href="/products?category=top"');
    expect(block).toContain('上衣');
    expect(block).not.toContain('<span class="pd-cat"');
  });
});

describe('U02 小筆記直播場次 row（真 liveDate 先出）', () => {
  it('有 liveDate＋liveSession：顯示日期＋第N場，連結去該場次；原 note 保留', () => {
    const html = renderDetail({ liveDate: '20261112', liveSession: '2' });
    expect(html).toContain('ps-live-link');
    expect(html).toContain('2026年11月12日');
    expect(html).toContain('第 2 場');
    expect(html).toContain('liveDate=20261112');
    expect(html).toContain('liveSession=2');
    // 原 note 文案一字唔郁
    expect(html).toContain('黑色背心身配啡色翻領，領位同左胸口袋都係啡色。');
  });

  it('得 liveDate 無場次：連結只去該日，唔出「第N場」', () => {
    const html = renderDetail({ liveDate: '20261112' });
    expect(html).toContain('ps-live-link');
    expect(html).toContain('liveDate=20261112');
    expect(html).not.toContain('liveSession=');
    const start = html.indexOf('ps-live-link');
    const end = html.indexOf('</a>', start);
    expect(html.slice(start, end)).not.toContain('第');
  });

  it('無 liveDate → 唔出場次 row（唔虛構、唔出空徽章），note 照舊', () => {
    const html = renderDetail({ liveDate: null, liveSession: null });
    expect(html).not.toContain('ps-live');
    expect(html).toContain('商品小筆記');
  });

  it('壞 liveDate（20261301）→ 唔出場次 row', () => {
    const html = renderDetail({ liveDate: '20261301', liveSession: '1' });
    expect(html).not.toContain('ps-live');
  });
});

describe('U01 返回掣', () => {
  it('SSR／無來源記錄（直接開）→ fallback 係去 /products 嘅真連結', () => {
    const html = renderDetail();
    const start = html.indexOf('pd-back');
    expect(start).toBeGreaterThan(-1);
    const block = html.slice(Math.max(0, start - 300), start + 1200);
    expect(block).toContain('href="/products"');
    expect(block).toContain('返回');
  });
});

describe('product-story.css（深色改版＋motion guard）', () => {
  const css = readFileSync(
    resolve(__dirname, '../components/shop/product-story.css'),
    'utf8',
  );

  it('唔再用奶油紙色板（舊紙卡顏色移除）', () => {
    expect(css).not.toContain('#f7efdf');
    expect(css).not.toContain('#c1502e');
    expect(css).toContain('var(--space-2)');
    expect(css).toContain('var(--pink');
  });

  it('售價帶同小筆記共用 token（pink / mono / hairline）', () => {
    expect(css).toContain('.pd-price-amount');
    expect(css).toContain('var(--font-mono)');
    expect(css).toContain('var(--space-line)');
  });

  it('中文字唔用 pseudo-italic', () => {
    // 剝走 CSS 註解先斷言（註解入面有說明文字提到呢個詞）
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/font-style\s*:\s*italic/);
  });

  it('prefers-reduced-motion 停用動效', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
