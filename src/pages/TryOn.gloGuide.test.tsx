// @vitest-environment happy-dom
/** Glo Glo 指南 × AI 試穿主線：深連結、登入回跳、刊期及全部商品共用 selections。 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TryOn from './TryOn';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  user: null as null | { id: number; name: string; role: string },
  bySlug: {
    data: undefined as unknown,
    isPending: false,
    isError: false,
    error: null as null | { data?: { code?: string } },
    refetch: vi.fn(),
  },
  catalog: {
    data: undefined as unknown,
    isPending: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  },
  products: {
    data: [] as unknown[],
    isLoading: false,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  },
  access: {
    data: {
      allowed: true,
      reason: null,
      remainingToday: 8,
      dailyLimit: 10,
      usedToday: 2,
      siteRemainingToday: 80,
      maxMixSteps: 3,
      memberEnabled: true,
      creditsPerGeneration: 3,
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  job: { data: undefined, isError: false, error: null, refetch: vi.fn() },
  create: { isPending: false, mutateAsync: vi.fn() },
  deleteMedia: { isPending: false, mutateAsync: vi.fn() },
  utils: {
    tryon: {
      getJob: { setData: vi.fn(), reset: vi.fn(), invalidate: vi.fn() },
      getMyAccess: { invalidate: vi.fn(async () => undefined) },
      listMyRecords: { invalidate: vi.fn(async () => undefined) },
      listProducts: { invalidate: vi.fn(async () => undefined) },
    },
  },
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: h.user, isLoading: false }) }));
vi.mock('@/components/AiTryOnTutorial', () => ({ default: () => null }));
vi.mock('./TryOnPurchase', () => ({ default: () => null }));
vi.mock('@/providers/trpc', () => ({
  trpc: {
    useUtils: () => h.utils,
    tryon: {
      getMyAccess: { useQuery: () => h.access },
      listProducts: { useQuery: () => h.products },
      getJob: { useQuery: () => h.job },
      getShareLink: { useQuery: () => ({ data: undefined }) },
      create: { useMutation: () => h.create },
      deleteMedia: { useMutation: () => h.deleteMedia },
    },
    gloGuide: {
      bySlug: { useQuery: () => h.bySlug },
      list: { useInfiniteQuery: () => h.catalog },
    },
  },
}));

const PUBLIC_PRODUCTS = [
  {
    id: 101,
    name: '駝色開胸針織褸',
    image: '/p101a.jpg',
    photos: ['/p101a.jpg', '/p101b.jpg'],
    price: 200,
    discountPrice: 150,
    category: 'top',
    stock: 5,
    sizeEnabled: true,
    sizes: ['S', 'M'],
    aiTags: [],
    isActive: true,
    liveDate: null,
    liveSession: null,
  },
  {
    id: 102,
    name: '直筒牛仔褲',
    image: '/p102.jpg',
    photos: ['/p102.jpg'],
    price: 168,
    discountPrice: null,
    category: 'pants',
    stock: 0,
    sizeEnabled: false,
    sizes: [],
    aiTags: [],
    isActive: true,
    liveDate: null,
    liveSession: null,
  },
  {
    id: 103,
    name: '黑色連身裙',
    image: '/p103.jpg',
    photos: ['/p103.jpg'],
    price: 288,
    discountPrice: null,
    category: 'dress',
    stock: 2,
    sizeEnabled: false,
    sizes: [],
    aiTags: [],
    isActive: true,
    liveDate: null,
    liveSession: null,
  },
];

const TRYON_PRODUCTS = [
  { ...PUBLIC_PRODUCTS[0], sku: 'TOP-101', tryOnKind: 'top' },
  { ...PUBLIC_PRODUCTS[1], sku: 'PANTS-102', tryOnKind: 'pants' },
  { ...PUBLIC_PRODUCTS[2], sku: 'DRESS-103', tryOnKind: 'dress' },
];

const SOURCE = {
  id: 1,
  slug: 'autumn-knit',
  title: '轉季針織咁襯',
  excerpt: '香港轉季三件頭配搭。',
  theme: '轉季 layering',
  publishedAt: '2026-11-14T16:30:00.000Z',
  updatedAt: '2026-11-15T02:00:00.000Z',
  coverImage: null,
  images: [],
  products: PUBLIC_PRODUCTS.slice(0, 2),
  body: '正文',
  modelImage: null,
};
const SECOND = {
  ...SOURCE,
  id: 2,
  slug: 'winter-dress',
  title: '冬日連身裙',
  products: PUBLIC_PRODUCTS.slice(2),
  body: undefined,
  modelImage: undefined,
};

const DEEP_LINK = '/try-on?productId=101&photoIndex=1&guide=autumn-knit';
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let seen: { pathname: string; search: string; state: unknown } | null = null;

function Probe() {
  const location = useLocation();
  seen = { pathname: location.pathname, search: location.search, state: location.state };
  return null;
}

function mountTryOn(entry = DEEP_LINK) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/try-on" element={<TryOn />} />
          <Route path="/login" element={<Probe />} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return container;
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
}

function modeButton(c: HTMLElement, label: string) {
  const button = Array.from(c.querySelectorAll<HTMLButtonElement>('.tryon-product-modes button'))
    .find((item) => item.textContent?.includes(label));
  if (!button) throw new Error(`搵唔到 ${label} mode`);
  return button;
}

beforeEach(() => {
  h.user = { id: 7, name: '測試會員', role: 'member' };
  h.products.data = TRYON_PRODUCTS;
  h.bySlug = {
    data: SOURCE,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
  h.catalog = {
    data: { pages: [{ items: [SECOND], nextCursor: null }] },
    isPending: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  };
  h.job.data = undefined;
  h.create.isPending = false;
  sessionStorage.clear();
  seen = null;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  sessionStorage.clear();
});

describe('TryOn × Glo Glo 深連結', () => {
  it('未登入都見到公開原篇；登入 Link 保留完整 product／photoIndex／guide return path', () => {
    h.user = null;
    const c = mountTryOn();
    expect(c.querySelector('.tryon-source-guide')?.textContent).toContain('轉季針織咁襯');
    expect(c.querySelector<HTMLAnchorElement>('.tryon-source-guide a')?.getAttribute('href'))
      .toBe('/glo-guide/autumn-knit');
    const login = c.querySelector<HTMLAnchorElement>('a[href="/login"]');
    expect(login?.textContent).toContain('繼續試呢件');
    click(login!);
    expect(seen).toMatchObject({ pathname: '/login' });
    expect((seen!.state as { from: string }).from).toBe(DEEP_LINK);
  });

  it('登入後由 URL 預選正確商品及第二張商品原圖，原篇與刊期商品合併唔重複', () => {
    const c = mountTryOn();
    const selected = c.querySelector<HTMLButtonElement>('.tryon-guide-product[data-selected="true"]');
    expect(selected?.textContent).toContain('駝色開胸針織褸');
    expect(selected?.textContent).toContain('第 1 次生成');
    expect(selected?.querySelector('img')?.getAttribute('src')).toBe('/p101b.jpg');
    expect(c.querySelectorAll('.tryon-guide-issues [role="tab"]')).toHaveLength(2);
    const photoButtons = c.querySelectorAll('.tryon-photo-picker button');
    expect(photoButtons).toHaveLength(2);
    expect(photoButtons[1].getAttribute('aria-pressed')).toBe('true');
    expect(c.querySelector('.tryon-selection-total')?.textContent).toContain('共 1 次生成');
  });

  it('指南同全部商品共用 selections：加褲、切 mode 移除，生成次序同 credits 即時同步', () => {
    const c = mountTryOn();
    const pants = Array.from(c.querySelectorAll<HTMLButtonElement>('.tryon-guide-product'))
      .find((item) => item.textContent?.includes('直筒牛仔褲'));
    expect(pants?.textContent).toContain('HK$168');
    click(pants!);
    expect(c.querySelectorAll('.tryon-selected-product')).toHaveLength(2);
    expect(c.querySelector('.tryon-selection-total')?.textContent).toContain('合共 6 credits');
    expect(pants?.getAttribute('aria-pressed')).toBe('true');

    click(modeButton(c, '全部商品'));
    expect(c.querySelectorAll('.tryon-selected-product')).toHaveLength(2);
    const allPants = Array.from(c.querySelectorAll<HTMLButtonElement>('.tryon-product-card'))
      .find((item) => item.textContent?.includes('直筒牛仔褲'));
    expect(allPants?.getAttribute('aria-pressed')).toBe('true');
    click(allPants!);
    expect(c.querySelectorAll('.tryon-selected-product')).toHaveLength(1);
    expect(c.querySelector('.tryon-selection-total')?.textContent).toContain('共 1 次生成');

    click(modeButton(c, 'Glo Glo 精選'));
    const top = c.querySelector('.tryon-guide-product[data-selected="true"]');
    expect(top?.textContent).toContain('駝色開胸針織褸');
    expect(c.querySelectorAll('.tryon-guide-product[data-selected="true"]')).toHaveLength(1);
  });

  it('切換其他刊再返原刊唔清選擇；原篇返回 link 保持正確', () => {
    const c = mountTryOn();
    const tabs = c.querySelectorAll<HTMLButtonElement>('.tryon-guide-issues [role="tab"]');
    click(tabs[1]);
    expect(c.querySelector('.tryon-guide-issue')?.textContent).toContain('冬日連身裙');
    expect(c.querySelector('.tryon-guide-product-rail')?.textContent).toContain('黑色連身裙');
    expect(c.querySelectorAll('.tryon-selected-product')).toHaveLength(1);
    expect(c.querySelector<HTMLAnchorElement>('.tryon-source-guide a')?.getAttribute('href'))
      .toBe('/glo-guide/autumn-knit');

    click(c.querySelectorAll<HTMLButtonElement>('.tryon-guide-issues [role="tab"]')[0]);
    expect(c.querySelector('.tryon-guide-product[data-selected="true"]')?.textContent)
      .toContain('駝色開胸針織褸');
    expect(c.querySelector<HTMLAnchorElement>('.tryon-guide-issue-head a')?.getAttribute('href'))
      .toBe('/glo-guide/autumn-knit');
  });
});
