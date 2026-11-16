// @vitest-environment happy-dom
/**
 * ProductDetail SEO regression（v5 政策精準修改）：
 *
 * - 暫時網絡／5xx 故障（非 NOT_FOUND）：只改 title/description 提示重試，
 *   必須保留 server 首口／SeoManager 嘅 `index, follow` robots 同 self canonical——
 *   在架商品唔准因一時故障被搜尋引擎踢出索引（舊 bug：故障都 noindex＋移除 canonical）。
 * - 明確 NOT_FOUND（已刪／下架）：先至 noindex,nofollow＋移除 canonical。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProductDetail from './ProductDetail';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  byIdQuery: {
    data: undefined as unknown,
    error: null as null | { message: string; data?: { code?: string; httpStatus?: number } },
    isError: false,
    isFetching: false,
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

const SELF_CANONICAL = 'https://redcode.red/products/85';

let container: HTMLDivElement;
let root: Root;

/** 模擬 server 首口／SeoManager 預設：index,follow＋self canonical。 */
function seedHead() {
  document.head.innerHTML = [
    '<title>RedCode Fashion Design｜香港女裝直播網店</title>',
    '<meta name="robots" content="index, follow" />',
    '<meta name="description" content="server 首口預設描述" />',
    `<link rel="canonical" href="${SELF_CANONICAL}" />`,
  ].join('');
}

function renderProduct(id = '85') {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[`/products/${id}`]}>
        <Routes>
          <Route path="/products/:id" element={<ProductDetail />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

beforeEach(() => {
  mocks.byIdQuery.data = undefined;
  mocks.byIdQuery.error = null;
  mocks.byIdQuery.isError = false;
  mocks.byIdQuery.isFetching = false;
  seedHead();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ProductDetail SEO：錯誤狀態 robots／canonical 處理', () => {
  it('暫時 5xx 故障：只改 title/description，保留 index,follow 同 self canonical', () => {
    mocks.byIdQuery.isError = true;
    mocks.byIdQuery.error = {
      message: 'Internal Server Error',
      data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
    };
    renderProduct();

    // 重試 UI 如實顯示
    expect(container.textContent).toContain('商品資料暫時載入唔到');
    expect(container.textContent).toContain('重新載入');

    expect(document.title).toBe('商品資料暫時載入唔到｜RedCode Fashion Design');
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      '商品資料暫時載入唔到，請稍後重試或返回全部商品。',
    );
    // 核心 regression：robots 同 canonical 一個 bit 都唔准郁
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'index, follow',
    );
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    expect(canonical).not.toBeNull();
    expect(canonical?.getAttribute('href')).toBe(SELF_CANONICAL);
  });

  it('純網絡錯誤（冇 tRPC code）：同樣保留 index,follow 同 canonical', () => {
    mocks.byIdQuery.isError = true;
    mocks.byIdQuery.error = { message: 'Failed to fetch' };
    renderProduct();

    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'index, follow',
    );
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      SELF_CANONICAL,
    );
  });

  it('明確 NOT_FOUND：noindex,nofollow＋移除 canonical', () => {
    mocks.byIdQuery.isError = true;
    mocks.byIdQuery.error = {
      message: 'Product not found',
      data: { code: 'NOT_FOUND', httpStatus: 404 },
    };
    renderProduct();

    expect(container.textContent).toContain('搵唔到呢件商品');
    expect(document.title).toBe('搵唔到呢件商品｜RedCode Fashion Design');
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex, nofollow',
    );
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
  });
});
