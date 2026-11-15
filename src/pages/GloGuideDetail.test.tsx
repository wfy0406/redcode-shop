/**
 * GloGuideDetail 頁面 render 測試（renderToString，mock trpc/auth）：
 * - 文章／商品／圖片對應（caption「著緊：」連去正確商品頁）
 * - 加車尺寸邊界：多尺寸 → 「去商品頁揀尺寸」真連結；冇尺寸 → 加入購物車按鈕
 * - 香港發文時間 <time dateTime=ISO>、Gloria 簽名圖、價錢（折扣價＋原價刪線）
 * - NOT_FOUND / 一般錯誤 / 載入中三種狀態
 */

import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import GloGuideDetail from './GloGuideDetail';

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

describe('GloGuideDetail 文章／商品／圖片對應', () => {
  it('標題、兩段正文、主題、香港發文時間（dateTime 透傳 ISO）', () => {
    setQuery({ data: DETAIL });
    const html = renderDetail();
    expect(html).toContain('轉季針織咁襯');
    expect(html).toContain('轉季 layering');
    expect(html).toContain('第一段講 layering。');
    expect(html).toContain('第二段講場景。');
    expect(html).toContain('dateTime="2026-11-14T16:30:00.000Z"');
    expect(html).toContain('2026年11月15日 00:30');
  });

  it('相集 caption 對應返正確商品同真連結，並有配搭圖參考說明', () => {
    setQuery({ data: DETAIL });
    const html = renderDetail();
    expect(html).toContain('配搭單品：');
    expect(html).toContain('配搭圖只供配搭參考；商品外觀以商品頁原圖為準。');
    expect(html).toContain('href="/products/101"');
    expect(html).toContain('href="/products/102"');
    // 首張相 eager＋fetchPriority high（LCP），之後 lazy
    // （React 19 SSR 原樣輸出 fetchPriority="high"；HTML 屬性不分大小寫）
    expect(html).toContain('loading="eager"');
    expect(html).toMatch(/fetchpriority="high"/i);
    expect(html).toContain('loading="lazy"');
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

  it('載入中 → role=status', () => {
    setQuery({});
    const html = renderDetail();
    expect(html).toContain('role="status"');
    expect(html).toContain('載入緊');
  });
});
