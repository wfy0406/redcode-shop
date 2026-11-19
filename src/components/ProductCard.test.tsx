// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProductCard from './ProductCard';
import { PRODUCT_RETURN_KEY, readProductReturn } from '@/lib/productReturn';
import type { Product } from '@/data/products';

/**
 * U04＋U01 商品卡測試（happy-dom 真 DOM）：
 * - 有真 liveDate/liveSession 先出場次 metadata row，係主 anchor 嘅 sibling（唔 nested <a>）
 * - 無場次唔出；壞資料唔出
 * - 普通左掣撳卡記低來源（URL／scrollY／productId）；ctrl+click 唔記
 * - R03：priority 卡 eager＋fetchpriority=high；預設 lazy
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/providers/trpc', () => ({
  trpc: {
    useUtils: () => ({ cart: { list: { invalidate: vi.fn() } } }),
    cart: { add: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) } },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: null }),
}));

const BASE_PRODUCT: Product = {
  id: '7',
  name: '星空絲絨吊帶裙',
  sku: 'RC-TEST-7',
  price: 328,
  category: 'dress',
  listedAt: '2026-11-10',
  image: '/product-1.jpg',
  soldOut: false,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderCard(product: Product, entry = '/products?liveDate=20261110') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[entry]}>
        <ProductCard product={product} />
      </MemoryRouter>,
    );
  });
  return container;
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe('U04 場次 metadata row', () => {
  it('有 liveDate＋liveSession：出 sibling 連結去該場，唔係 nested anchor', async () => {
    const el = await renderCard({ ...BASE_PRODUCT, liveDate: '20261110', liveSession: '2' });
    const live = el.querySelector<HTMLAnchorElement>('a.pc-live');
    expect(live).not.toBeNull();
    expect(live!.getAttribute('href')).toBe('/products?liveDate=20261110&liveSession=2');
    expect(live!.textContent).toContain('2026年11月10日');
    expect(live!.textContent).toContain('第 2 場');
    // 合法性：pc-live 絕對唔可以喺主商品 anchor 入面（nested <a> 係 invalid HTML）
    const mainLink = el.querySelector<HTMLAnchorElement>('a[data-product-card="7"]');
    expect(mainLink).not.toBeNull();
    expect(mainLink!.contains(live!)).toBe(false);
    // 同埋佢哋係同一 article 嘅姊妹
    expect(live!.closest('article')).toBe(mainLink!.closest('article'));
  });

  it('得 liveDate 無場次：連結只去該日', async () => {
    const el = await renderCard({ ...BASE_PRODUCT, liveDate: '20261110' });
    const live = el.querySelector<HTMLAnchorElement>('a.pc-live');
    expect(live).not.toBeNull();
    expect(live!.getAttribute('href')).toBe('/products?liveDate=20261110');
    expect(live!.textContent).not.toContain('第');
  });

  it('無場次／壞日期 → 唔出 row（唔出空徽章）', async () => {
    const el = await renderCard({ ...BASE_PRODUCT });
    expect(el.querySelector('a.pc-live')).toBeNull();
    const el2 = await renderCard({ ...BASE_PRODUCT, id: '8', liveDate: '20261301', liveSession: '1' });
    expect(el2.querySelector('a.pc-live')).toBeNull();
  });
});

describe('U01 撳卡記來源', () => {
  it('普通左掣撳主連結 → 記低 URL／scrollY／productId／時間', async () => {
    const el = await renderCard(BASE_PRODUCT, '/products?category=dress');
    const mainLink = el.querySelector<HTMLAnchorElement>('a[data-product-card="7"]')!;
    await act(async () => {
      mainLink.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, cancelable: true }));
    });
    const saved = readProductReturn();
    expect(saved).not.toBeNull();
    expect(saved!.url).toBe('/products?category=dress');
    expect(saved!.productId).toBe(7);
    expect(typeof saved!.scrollY).toBe('number');
    expect(typeof saved!.ts).toBe('number');
  });

  it('ctrl+click（開新分頁）唔記來源', async () => {
    const el = await renderCard(BASE_PRODUCT);
    const mainLink = el.querySelector<HTMLAnchorElement>('a[data-product-card="7"]')!;
    await act(async () => {
      mainLink.dispatchEvent(
        new MouseEvent('click', { bubbles: true, button: 0, cancelable: true, ctrlKey: true }),
      );
    });
    expect(sessionStorage.getItem(PRODUCT_RETURN_KEY)).toBeNull();
  });

  it('非數字示範卡 id 唔記來源', async () => {
    const el = await renderCard({ ...BASE_PRODUCT, id: 'rc-1001' }, '/');
    const mainLink = el.querySelector<HTMLAnchorElement>('a[data-product-card="rc-1001"]')!;
    await act(async () => {
      mainLink.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, cancelable: true }));
    });
    expect(sessionStorage.getItem(PRODUCT_RETURN_KEY)).toBeNull();
  });
});

describe('R03 圖片載入優先級', () => {
  it('priority 卡：eager＋fetchpriority=high；預設卡：lazy', async () => {
    const el = await renderCard(BASE_PRODUCT);
    const img = el.querySelector('img')!;
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('fetchpriority')).toBeNull();

    container?.remove();
    await act(async () => {
      root!.unmount();
    });
    root = null;

    const el2 = document.createElement('div');
    document.body.appendChild(el2);
    root = createRoot(el2);
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/products']}>
          <ProductCard product={BASE_PRODUCT} priority />
        </MemoryRouter>,
      );
    });
    const img2 = el2.querySelector('img')!;
    expect(img2.getAttribute('loading')).toBe('eager');
    expect(img2.getAttribute('fetchpriority')).toBe('high');
    el2.remove();
  });
});
