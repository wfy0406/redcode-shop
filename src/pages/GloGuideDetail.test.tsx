/**
 * GloGuideDetail 頁面測試（v3 潮牌雜誌版）：
 *
 * SSR（renderToString，mock trpc/auth）：
 * - 非對稱 editorial lead：主題、大標、期刊 metadata（香港發文時間
 *   <time dateTime=ISO>、Glo Glo 撰寫、單品數、重點標籤）
 * - 全寬主配搭圖舞台：首張 eager＋fetchPriority=high（LCP），thumbnails lazy；
 *   圖片 ↔ 商品對應（同步單品欄真名／真價／真連結 /products/:id）
 * - 加車尺寸邊界：多尺寸 → 「去商品頁揀尺寸」真連結；冇尺寸 → 加入購物車按鈕
 * - Gloria 簽名圖、價錢（折扣價＋原價刪線）
 * - NOT_FOUND / 一般錯誤 / 載入中三種狀態
 *
 * 互動（happy-dom＋createRoot）：
 * - click／ArrowRight 切換配搭圖 → 同步單品欄即時更新（aria-pressed 跟住走）
 */

// @vitest-environment happy-dom

import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GloGuideDetail from './GloGuideDetail';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  bySlugQuery: {
    data: undefined as unknown,
    error: null as null | { message: string; data?: { code?: string } },
    isError: false,
    refetch: vi.fn(),
  },
  addMutation: { isPending: false, mutate: vi.fn() },
  utils: { cart: { list: { invalidate: vi.fn() } } },
}));

vi.mock('@/providers/trpc', () => ({
  trpc: {
    useUtils: () => mocks.utils,
    gloGuide: {
      bySlug: { useQuery: () => mocks.bySlugQuery },
    },
    cart: { add: { useMutation: () => mocks.addMutation } },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: null }),
}));

const DETAIL = {
  id: 1,
  slug: 'autumn-knit',
  title: '轉季針織咁襯',
  excerpt: '香港轉季三件頭配搭。',
  theme: '轉季 layering',
  publishedAt: '2026-11-14T16:30:00.000Z',
  updatedAt: '2026-11-15T02:00:00.000Z',
  coverImage: null,
  body: '第一段講 layering。\n\n第二段講場景。',
  modelImage: null,
  images: [
    {
      id: 11,
      path: '/uploads/glo-guide/a.png',
      alt: '駝色開胸針織褸 配搭圖',
      width: 800,
      height: 1200,
      position: 0,
      productId: 101,
    },
    {
      id: 12,
      path: '/uploads/glo-guide/b.png',
      alt: '直筒牛仔褲 配搭圖',
      width: 800,
      height: 1200,
      position: 1,
      productId: 102,
    },
  ],
  products: [
    {
      id: 101,
      name: '駝色開胸針織褸',
      image: '/p101.jpg',
      photos: [],
      price: 200,
      discountPrice: 150,
      category: 'top',
      stock: 5,
      sizeEnabled: true,
      sizes: ['S', 'M', 'L'],
      aiTags: ['針織', '駝色'],
      isActive: true,
      liveDate: '20261110',
      liveSession: '2',
    },
    {
      id: 102,
      name: '直筒牛仔褲',
      image: '/p102.jpg',
      photos: [],
      price: 168,
      discountPrice: null,
      category: 'pants',
      stock: 3,
      sizeEnabled: false,
      sizes: [],
      aiTags: [],
      isActive: true,
      liveDate: null,
      liveSession: null,
    },
    {
      id: 103,
      name: '售罄頸巾',
      image: '/p103.jpg',
      photos: [],
      price: 88,
      discountPrice: null,
      category: 'accessory',
      stock: 0,
      sizeEnabled: false,
      sizes: [],
      aiTags: [],
      isActive: true,
      liveDate: null,
      liveSession: null,
    },
    {
      id: 104,
      name: '下架漁夫帽',
      image: '/p104.jpg',
      photos: [],
      price: 68,
      discountPrice: null,
      category: 'accessory',
      stock: 9,
      sizeEnabled: false,
      sizes: [],
      aiTags: [],
      isActive: false,
      liveDate: null,
      liveSession: null,
    },
  ],
};

function setQuery(partial: Partial<typeof mocks.bySlugQuery>) {
  mocks.bySlugQuery.data = undefined;
  mocks.bySlugQuery.error = null;
  mocks.bySlugQuery.isError = false;
  Object.assign(mocks.bySlugQuery, partial);
}

function renderDetail() {
  return renderToString(
    <MemoryRouter initialEntries={['/glo-guide/autumn-knit']}>
      <Routes>
        <Route path="/glo-guide/:slug" element={<GloGuideDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('GloGuideDetail 期刊 lead／正文', () => {
  it('標題、兩段正文、主題、香港發文時間（dateTime 透傳 ISO）、期刊 metadata', () => {
    setQuery({ data: DETAIL });
    const html = renderDetail();
    expect(html).toContain('轉季針織咁襯');
    expect(html).toContain('轉季 layering');
    expect(html).toContain('第一段講 layering。');
    expect(html).toContain('第二段講場景。');
    expect(html).toContain('dateTime="2026-11-14T16:30:00.000Z"');
    expect(html).toContain('2026年11月15日 00:30');
    expect(html).toContain('Glo Glo 精選指南');
    expect(html).toContain('Glo Glo 撰寫');
    expect(html).toContain('4 件文中單品');
    // 內容捷徑保留真錨點（小精靈導引 selector 都靠佢哋）；
    // id="guide-body" 由 GloGuideRichText 內部提供，呢度核實唔會 dead anchor
    expect(html).toContain('href="#guide-body"');
    expect(html).toContain('id="guide-body"');
    expect(html).toContain('href="#guide-gallery"');
    expect(html).toContain('id="guide-gallery"');
    expect(html).toContain('href="#guide-products"');
    expect(html).toContain('id="guide-products"');
  });

  it('Glo Glo 簽名重用 /email/gloria-sign.png', () => {
    setQuery({ data: DETAIL });
    const html = renderDetail();
    expect(html).toContain('/email/gloria-sign.png');
    expect(html).toContain('Glo Glo 簽名');
  });

  it('安全顯示粗體、顏色、重點標籤；唔會將標記當正文', () => {
    setQuery({
      data: {
        ...DETAIL,
        body: '第一段[b][gold]講 layering[/gold][/b]。\n\n第二段[tag]返工重點[/tag]。',
      },
    });
    const html = renderDetail();
    expect(html).toContain('<strong>');
    expect(html).toContain('gg-text-gold');
    expect(html).toContain('<mark class="gg-key-tag">返工重點</mark>');
    expect(html).toContain('本篇重點標籤');
    expect(html).not.toContain('[tag]');
  });
});

describe('GloGuideDetail 全寬主配搭圖舞台', () => {
  it('首張大圖 eager＋fetchPriority=high（LCP），thumbnails 全部 lazy', () => {
    setQuery({ data: DETAIL });
    const html = renderDetail();
    // React 19 SSR 原樣輸出 fetchPriority="high"；HTML 屬性不分大小寫
    expect(html.match(/loading="eager"/g)).toHaveLength(1);
    expect(html).toMatch(/fetchpriority="high"/i);
    // 2 張 thumbnails lazy；商品卡圖都 lazy
    expect(html.match(/loading="lazy"/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('同步單品欄對應首張圖嘅商品：真名／真價／真連結，caption 標注配搭單品', () => {
    setQuery({ data: DETAIL });
    const html = renderDetail();
    expect(html).toContain('配搭圖只供配搭參考；商品外觀以商品頁原圖為準。');
    expect(html).toContain('呢張配搭圖嘅單品');
    expect(html).toContain('href="/products/101"');
    expect(html).toContain('配搭單品：駝色開胸針織褸');
    expect(html).toContain('HK$150');
    expect(html).toContain('HK$200');
    // selector：兩張 thumbnail 都係真按鈕＋aria-pressed
    expect(html.match(/gg-stage-thumb/g)!.length).toBeGreaterThanOrEqual(2);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain('顯示第 2 張配搭圖：直筒牛仔褲');
  });

  it('冇配搭圖：唔出空舞台，正文同單品仍然完整', () => {
    setQuery({ data: { ...DETAIL, images: [] } });
    const html = renderDetail();
    expect(html).not.toContain('gg-stage-figure');
    expect(html).toContain('第一段講 layering。');
    expect(html).toContain('文中單品');
  });
});

describe('GloGuideDetail 加車尺寸邊界', () => {
  it('sizeEnabled＋多尺寸 → 「去商品頁揀尺寸」連結，唔係加車按鈕', () => {
    setQuery({ data: DETAIL });
    const html = renderDetail();
    expect(html).toContain('去商品頁揀尺寸');
  });

  it('冇尺寸商品 → 加入購物車真按鈕', () => {
    setQuery({ data: DETAIL });
    const html = renderDetail();
    expect(html).toContain('加入購物車');
    expect(html).toContain('商品詳情');
  });

  it('售罄商品 → 「暫時缺貨」status，唔會出死按鈕', () => {
    setQuery({ data: DETAIL });
    const html = renderDetail();
    expect(html).toContain('暫時缺貨');
  });

  it('下架商品（isActive=false）→ 「已下架」status，冇加車入口，但保留商品詳情連結', () => {
    setQuery({ data: DETAIL });
    const html = renderDetail();
    expect(html).toContain('已下架');
    // 得一件商品（直筒牛仔褲）可以直接加車
    expect(html.match(/加入購物車/g)).toHaveLength(1);
    expect(html).toContain('href="/products/104"');
  });

  it('折扣商品：現價＋原價刪線同時出現', () => {
    setQuery({ data: DETAIL });
    const html = renderDetail();
    expect(html).toContain('HK$150');
    expect(html).toContain('HK$200');
  });
});

describe('GloGuideDetail 狀態', () => {
  it('NOT_FOUND → 搵唔到呢篇指南', () => {
    setQuery({ isError: true, error: { message: 'not found', data: { code: 'NOT_FOUND' } } });
    const html = renderDetail();
    expect(html).toContain('搵唔到呢篇指南');
    expect(html).toContain('返回指南總覽');
  });

  it('一般錯誤 → 錯誤文案＋重新載入按鈕，而且唔會誤落永遠載入中', () => {
    setQuery({ isError: true, error: { message: 'network', data: { code: 'INTERNAL_SERVER_ERROR' } } });
    const html = renderDetail();
    expect(html).toContain('文章暫時載入唔到');
    expect(html).toContain('重新載入');
    expect(html).not.toContain('載入緊');
  });

  it('載入中 → role=status＋一屏高狀態頁，避免 Footer CLS', () => {
    setQuery({});
    const html = renderDetail();
    expect(html).toContain('role="status"');
    expect(html).toContain('載入緊');
    expect(html).toContain('class="gg-page gg-page--status"');
  });
});

/* ---------- 互動（happy-dom）：配搭圖 selector 同步單品資訊 ---------- */

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mountDetail() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={['/glo-guide/autumn-knit']}>
        <Routes>
          <Route path="/glo-guide/:slug" element={<GloGuideDetail />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

function thumbButtons(c: HTMLElement) {
  return Array.from(c.querySelectorAll<HTMLButtonElement>('.gg-stage-thumb'));
}

describe('GloGuideDetail 互動：切換配搭圖同步單品', () => {
  it('click 第二張 thumbnail → 大圖、caption、單品欄同步去直筒牛仔褲', () => {
    setQuery({ data: DETAIL });
    const c = mountDetail();
    const panel = () => c.querySelector('.gg-stage-panel')?.textContent ?? '';
    expect(panel()).toContain('駝色開胸針織褸');
    const buttons = thumbButtons(c);
    expect(buttons).toHaveLength(2);
    act(() => {
      buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(panel()).toContain('直筒牛仔褲');
    expect(panel()).not.toContain('駝色開胸針織褸');
    expect(
      c.querySelector<HTMLAnchorElement>('.gg-stage-product-name a')?.getAttribute('href'),
    ).toBe('/products/102');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
    // 大圖 alt 同步
    expect(c.querySelector('.gg-stage-img')?.getAttribute('alt')).toBe('直筒牛仔褲 配搭圖');
    expect(c.querySelector('.gg-figure-cap')?.textContent).toContain('第 2 張，共 2 張');
  });

  it('ArrowRight 喺 selector 移動；focus 都會同步（鍵盤 Tab 到即用）', () => {
    setQuery({ data: DETAIL });
    const c = mountDetail();
    const buttons = thumbButtons(c);
    act(() => {
      buttons[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(c.querySelector('.gg-stage-panel')?.textContent).toContain('直筒牛仔褲');
    act(() => {
      buttons[0].dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(c.querySelector('.gg-stage-panel')?.textContent).toContain('駝色開胸針織褸');
  });
});
