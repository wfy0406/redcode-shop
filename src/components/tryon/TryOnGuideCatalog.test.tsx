/**
 * TryOnGuideCatalog 測試（happy-dom＋createRoot 真互動）：
 *
 * - joinGuideTryOnProducts 純邏輯：跟指南次序、用最新 TryOn 商品資料、
 *   過濾唔喺試穿清單（下架／唔支援部位／缺資料）嘅指南商品
 * - 掛載渲染：當期刊期商品 rail（data-fairy-target="product"）、真指南
 *   連結 /glo-guide/:slug、已揀 badge（第 N 次生成）、photoIndex 揀相
 * - Harness（真 useState）：點擊加入／再點移除選取；切刊期再返嚟選取保留
 * - 刊期 tabs：click＋ArrowRight（wrap）＋Home／End 鍵盤切換 aria-selected
 * - 狀態：載入中／初次錯誤＋重試／未有已發布指南／刊期冇合資格商品／
 *   載入較早刊期（loading／error＋重試）
 * - 停用：blockReason／selectionLocked／hasLaterLineage 全部唔准點
 */

// @vitest-environment happy-dom

import { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuideListItem, GuideProduct } from '@contracts/gloGuide';
import type { TryOnProductSelection } from '@/pages/tryonSelection';
import TryOnGuideCatalog, {
  joinGuideTryOnProducts,
  type TryOnGuideProduct,
} from './TryOnGuideCatalog';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/* ---------- fixtures ---------- */

const GUIDE_PRODUCT = (id: number, name: string): GuideProduct => ({
  id,
  name,
  image: `/guide-legacy-${id}.jpg`,
  photos: [`/guide-legacy-${id}-a.jpg`],
  price: 9999, // 指南快照舊價：顯示一律以 TryOn 清單最新價為準
  discountPrice: null,
  category: 'top',
  stock: 1,
  sizeEnabled: false,
  sizes: [],
  aiTags: [],
  isActive: true,
  liveDate: null,
  liveSession: null,
});

const TRYON_PRODUCT = (
  id: number,
  sku: string,
  name: string,
  overrides: Partial<TryOnGuideProduct> = {},
): TryOnGuideProduct => ({
  id,
  sku,
  name,
  image: `/tryon-${id}-cover.jpg`,
  photos: [`/tryon-${id}-look1.jpg`, `/tryon-${id}-look2.jpg`, `/tryon-${id}-look3.jpg`],
  price: 388,
  discountPrice: null,
  stock: 5,
  tryOnKind: 'top',
  ...overrides,
});

const GUIDE = (
  id: number,
  slug: string,
  title: string,
  products: GuideProduct[],
  publishedAt = '2026-11-14T16:30:00.000Z',
): GuideListItem => ({
  id,
  slug,
  title,
  excerpt: `${title}節錄。`,
  theme: `主題${id}`,
  publishedAt,
  updatedAt: publishedAt,
  coverImage: null,
  images: [],
  products,
});

// 當期（guides[0]）：三個指南商品，其中 999 唔喺試穿清單（已下架／唔支援部位）
const GUIDE_CURRENT = GUIDE(1, 'winter-edit', '冬日 layering 攻略', [
  GUIDE_PRODUCT(201, '牛角扣羊毛褸'),
  GUIDE_PRODUCT(202, '高腰闊腳牛仔褲'),
  GUIDE_PRODUCT(999, '已下架頸鏈'),
]);
const GUIDE_PREVIOUS = GUIDE(2, 'autumn-edit', '初秋返工 capsule', [
  GUIDE_PRODUCT(501, '條紋針織上衣'),
], '2026-09-02T09:00:00.000Z');
const GUIDES = [GUIDE_CURRENT, GUIDE_PREVIOUS];

// 試穿清單次序同指南唔同（500 唔屬呢兩刊）：join 一定要跟指南次序
const PRODUCT_201 = TRYON_PRODUCT(201, 'SKU-201', '牛角扣羊毛褸', {
  price: 1288,
  discountPrice: 988,
});
const PRODUCT_202 = TRYON_PRODUCT(202, 'SKU-202', '高腰闊腳牛仔褲', {
  price: 688,
  tryOnKind: 'pants',
});
const PRODUCT_501 = TRYON_PRODUCT(501, 'SKU-501', '條紋針織上衣', { price: 328 });
const PRODUCT_500 = TRYON_PRODUCT(500, 'SKU-500', '清單限定連身裙', { tryOnKind: 'dress' });
const PRODUCTS = [PRODUCT_501, PRODUCT_202, PRODUCT_201, PRODUCT_500];

/* ---------- mount helpers ---------- */

let root: Root | null = null;
let container: HTMLDivElement | null = null;

type CatalogProps = Parameters<typeof TryOnGuideCatalog>[0];

function baseProps(overrides: Partial<CatalogProps> = {}): CatalogProps {
  return {
    guides: GUIDES,
    products: PRODUCTS,
    activeGuideSlug: null,
    onGuideChange: () => {},
    selections: [],
    selectionLocked: false,
    hasLaterLineage: false,
    getBlockReason: () => null,
    onSelectProduct: () => {},
    isLoading: false,
    error: null,
    onRetry: () => {},
    hasNextPage: false,
    isFetchingNextPage: false,
    onLoadMore: () => {},
    ...overrides,
  };
}

async function mountCatalog(overrides: Partial<CatalogProps> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const props = baseProps(overrides);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <TryOnGuideCatalog {...props} />
      </MemoryRouter>,
    );
  });
  return container;
}

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

const tabsOf = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
const productButtonsOf = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>('.tryon-guide-product'));
const click = (el: HTMLElement) => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const keydown = (el: HTMLElement, key: string) => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
};

/* ---------- 純邏輯 ---------- */

describe('joinGuideTryOnProducts 合併邏輯', () => {
  it('跟指南商品次序輸出，唔跟試穿清單次序', () => {
    const joined = joinGuideTryOnProducts(
      { products: [GUIDE_PRODUCT(201, '甲'), GUIDE_PRODUCT(202, '乙')] },
      [PRODUCT_202, PRODUCT_201, PRODUCT_500],
    );
    expect(joined.map((p) => p.id)).toEqual([201, 202]);
  });

  it('輸出用試穿清單最新資料（名／價錢／原圖／貨號／部位），唔用指南快照', () => {
    const joined = joinGuideTryOnProducts(GUIDE_CURRENT, PRODUCTS);
    const coat = joined.find((p) => p.id === 201)!;
    expect(coat.sku).toBe('SKU-201');
    expect(coat.price).toBe(1288);
    expect(coat.discountPrice).toBe(988);
    expect(coat.image).toBe('/tryon-201-cover.jpg');
    expect(coat.tryOnKind).toBe('top');
    // 指南快照舊圖唔准出現
    expect(JSON.stringify(joined)).not.toContain('guide-legacy');
  });

  it('過濾唔喺試穿清單嘅指南商品（下架／唔支援部位／缺資料）', () => {
    const joined = joinGuideTryOnProducts(GUIDE_CURRENT, PRODUCTS);
    expect(joined.map((p) => p.id)).toEqual([201, 202]);
    expect(joined.some((p) => p.id === 999)).toBe(false);
  });

  it('指南冇商品／清單係空 → 空陣列', () => {
    expect(joinGuideTryOnProducts(GUIDE(9, 'empty', '空刊', []), PRODUCTS)).toEqual([]);
    expect(joinGuideTryOnProducts(GUIDE_CURRENT, [])).toEqual([]);
  });
});

/* ---------- 渲染 ---------- */

describe('目錄渲染', () => {
  it('顯示當期刊期商品 rail：data-fairy-target="product"、名稱、貨號、最新折後價', async () => {
    const c = await mountCatalog();
    const rail = c!.querySelector<HTMLElement>('[data-fairy-target="product"]');
    expect(rail).not.toBeNull();
    expect(rail!.getAttribute('aria-label')).toBe('冬日 layering 攻略可試穿單品');
    const buttons = productButtonsOf(c!);
    // 指南次序 201 → 202；999 被過濾
    expect(buttons.map((b) => b.querySelector('strong')!.textContent)).toEqual([
      '牛角扣羊毛褸',
      '高腰闊腳牛仔褲',
    ]);
    expect(buttons[0].textContent).toContain('SKU-201');
    expect(buttons[0].textContent).toContain('HK$988'); // 折後價優先
    expect(buttons[1].textContent).toContain('HK$688');
    expect(buttons[1].textContent).toContain('褲'); // tryOnKind label
    expect(c!.textContent).not.toContain('已下架頸鏈');
    // 冇 selection 時唔會出 badge
    expect(c!.querySelector('.tryon-guide-product-selected')).toBeNull();
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('期刊頭出真指南連結 /glo-guide/:slug 同刊期主題', async () => {
    const c = await mountCatalog();
    const link = c!.querySelector<HTMLAnchorElement>('.tryon-guide-article-link');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/glo-guide/winter-edit');
    expect(c!.textContent).toContain('主題1');
    expect(c!.textContent).toContain('冬日 layering 攻略');
    // tab 件數提示已過濾唔合資格商品
    const tabs = tabsOf(c!);
    expect(tabs[0].textContent).toContain('2 件可試');
    expect(tabs[1].textContent).toContain('1 件可試');
  });

  it('已揀商品出「第 N 次生成」badge，並用 selection photoIndex 對應嘅商品相', async () => {
    const c = await mountCatalog({
      selections: [{ productId: 201, photoIndex: 2 }],
    });
    const buttons = productButtonsOf(c!);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[0].getAttribute('data-selected')).toBe('true');
    expect(buttons[0].querySelector('.tryon-guide-product-selected')!.textContent).toContain(
      '第 1 次生成',
    );
    expect(buttons[0].querySelector('em')!.textContent).toBe('再撳移除呢件');
    const img = buttons[0].querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/tryon-201-look3.jpg');
    expect(img.getAttribute('alt')).toBe('牛角扣羊毛褸');
    // 未揀嘅商品用 gallery 第一張
    expect(buttons[1].querySelector('img')!.getAttribute('src')).toBe('/tryon-202-look1.jpg');
    expect(buttons[1].querySelector('em')!.textContent).toBe('揀呢件試穿');
  });

  it('photos 為空陣列時 fallback 用 product.image', async () => {
    const noPhotos = TRYON_PRODUCT(201, 'SKU-201', '牛角扣羊毛褸', { photos: [] });
    const c = await mountCatalog({ products: [noPhotos] });
    expect(productButtonsOf(c!)[0].querySelector('img')!.getAttribute('src')).toBe(
      '/tryon-201-cover.jpg',
    );
  });
});

/* ---------- Harness 互動（真 useState） ---------- */

function Harness({ initialGuides = GUIDES }: { initialGuides?: GuideListItem[] }) {
  const [slug, setSlug] = useState<string | null>(null);
  const [selections, setSelections] = useState<TryOnProductSelection[]>([]);
  return (
    <MemoryRouter>
      <TryOnGuideCatalog
        {...baseProps({
          guides: initialGuides,
          activeGuideSlug: slug,
          onGuideChange: setSlug,
          selections,
          onSelectProduct: (product) => {
            setSelections((current) => {
              const existing = current.findIndex((item) => item.productId === product.id);
              if (existing >= 0) return current.filter((_, index) => index !== existing);
              return [...current, { productId: product.id, photoIndex: 0 }];
            });
          },
        })}
      />
    </MemoryRouter>
  );
}

async function mountHarness() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness />);
  });
  return container;
}

describe('Harness 互動：選取狀態', () => {
  it('點擊商品加入選取出 badge；再點移除 badge', async () => {
    const c = await mountHarness();
    const first = productButtonsOf(c!)[0];
    click(first);
    let buttons = productButtonsOf(c!);
    expect(buttons[0].getAttribute('data-selected')).toBe('true');
    expect(buttons[0].querySelector('.tryon-guide-product-selected')!.textContent).toContain(
      '第 1 次生成',
    );
    click(buttons[1]);
    buttons = productButtonsOf(c!);
    expect(buttons[1].querySelector('.tryon-guide-product-selected')!.textContent).toContain(
      '第 2 次生成',
    );
    // 再點第一件移除：第二件升返做第 1 次生成
    click(buttons[0]);
    buttons = productButtonsOf(c!);
    expect(buttons[0].getAttribute('data-selected')).toBe('false');
    expect(buttons[0].querySelector('.tryon-guide-product-selected')).toBeNull();
    expect(buttons[1].querySelector('.tryon-guide-product-selected')!.textContent).toContain(
      '第 1 次生成',
    );
  });

  it('切刊期唔會清選取：返回原刊時 badge 仲喺度', async () => {
    const c = await mountHarness();
    click(productButtonsOf(c!)[0]); // 揀 201
    click(tabsOf(c!)[1]); // 去初秋刊
    expect(productButtonsOf(c!).map((b) => b.querySelector('strong')!.textContent)).toEqual([
      '條紋針織上衣',
    ]);
    click(tabsOf(c!)[0]); // 返冬日刊
    const buttons = productButtonsOf(c!);
    expect(buttons[0].getAttribute('data-selected')).toBe('true');
    expect(buttons[0].querySelector('.tryon-guide-product-selected')!.textContent).toContain(
      '第 1 次生成',
    );
  });
});

/* ---------- 刊期 tabs＋鍵盤 ---------- */

describe('刊期 tabs 切換', () => {
  it('點擊第二刊 tab：aria-selected 跟住走，商品 rail 換刊', async () => {
    const c = await mountHarness();
    let tabs = tabsOf(c!);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
    click(tabs[1]);
    tabs = tabsOf(c!);
    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].tabIndex).toBe(-1);
    expect(tabs[1].tabIndex).toBe(0);
    const panel = c!.querySelector<HTMLElement>('[role="tabpanel"]')!;
    expect(panel.getAttribute('aria-labelledby')).toBe(`tryon-guide-tab-${GUIDE_PREVIOUS.id}`);
    expect(productButtonsOf(c!).map((b) => b.querySelector('strong')!.textContent)).toEqual([
      '條紋針織上衣',
    ]);
    expect(c!.querySelector<HTMLAnchorElement>('.tryon-guide-article-link')!.getAttribute('href'))
      .toBe('/glo-guide/autumn-edit');
  });

  it('ArrowRight 喺 tab 上切下一刊，到尾 wrap 返頭', async () => {
    const c = await mountHarness();
    keydown(tabsOf(c!)[0], 'ArrowRight');
    expect(tabsOf(c!)[1].getAttribute('aria-selected')).toBe('true');
    expect(productButtonsOf(c!)[0].querySelector('strong')!.textContent).toBe('條紋針織上衣');
    keydown(tabsOf(c!)[1], 'ArrowRight');
    expect(tabsOf(c!)[0].getAttribute('aria-selected')).toBe('true');
    expect(productButtonsOf(c!)[0].querySelector('strong')!.textContent).toBe('牛角扣羊毛褸');
  });

  it('ArrowLeft 喺頭刊 wrap 去尾刊', async () => {
    const c = await mountHarness();
    keydown(tabsOf(c!)[0], 'ArrowLeft');
    expect(tabsOf(c!)[1].getAttribute('aria-selected')).toBe('true');
    expect(productButtonsOf(c!)[0].querySelector('strong')!.textContent).toBe('條紋針織上衣');
  });

  it('Home／End 直達首／尾刊', async () => {
    const c = await mountHarness();
    keydown(tabsOf(c!)[0], 'End');
    expect(tabsOf(c!)[1].getAttribute('aria-selected')).toBe('true');
    keydown(tabsOf(c!)[1], 'Home');
    expect(tabsOf(c!)[0].getAttribute('aria-selected')).toBe('true');
    expect(productButtonsOf(c!).map((b) => b.querySelector('strong')!.textContent)).toEqual([
      '牛角扣羊毛褸',
      '高腰闊腳牛仔褲',
    ]);
  });
});

/* ---------- 載入／錯誤／空態／分頁 ---------- */

describe('載入、錯誤同空態', () => {
  it('isLoading：role=status 載入中，唔出商品', async () => {
    const c = await mountCatalog({ isLoading: true });
    expect(c!.querySelector('[role="status"]')).not.toBeNull();
    expect(c!.textContent).toContain('正在整理已發布刊期');
    expect(c!.querySelector('[data-fairy-target="product"]')).toBeNull();
  });

  it('初次錯誤（冇刊期）：role=alert＋錯誤訊息，撳重試觸發 onRetry', async () => {
    const onRetry = vi.fn();
    const c = await mountCatalog({ error: '請檢查網絡連線', guides: [], onRetry });
    expect(c!.querySelector('[role="alert"]')).not.toBeNull();
    expect(c!.textContent).toContain('指南刊期暫時載入唔到');
    expect(c!.textContent).toContain('請檢查網絡連線');
    const retry = Array.from(c!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('重新載入指南'),
    )!;
    click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('有刊期兼有 error：唔出初次錯誤頁，商品照舊可睇', async () => {
    const c = await mountCatalog({ error: '分頁失敗' });
    expect(c!.querySelector('.tryon-guide-state[role="alert"]')).toBeNull();
    expect(productButtonsOf(c!)).toHaveLength(2);
  });

  it('未有已發布指南：空態 role=status，無 tablist', async () => {
    const c = await mountCatalog({ guides: [] });
    expect(c!.textContent).toContain('暫時未有已發布指南');
    expect(c!.querySelector('[role="status"]')).not.toBeNull();
    expect(c!.querySelector('[role="tablist"]')).toBeNull();
  });

  it('當期刊冇合資格商品：空刊提示，唔出 rail', async () => {
    const c = await mountCatalog({ products: [PRODUCT_500] });
    expect(c!.querySelector('[data-fairy-target="product"]')).toBeNull();
    expect(c!.textContent).toContain('呢刊暫時冇可試穿單品');
    // tab 件數顯示 0 件可試
    expect(tabsOf(c!)[0].textContent).toContain('0 件可試');
  });

  it('activeGuideSlug 指定刊期：直接渲染嗰刊商品', async () => {
    const c = await mountCatalog({ activeGuideSlug: 'autumn-edit' });
    expect(productButtonsOf(c!).map((b) => b.querySelector('strong')!.textContent)).toEqual([
      '條紋針織上衣',
    ]);
    expect(tabsOf(c!)[1].getAttribute('aria-selected')).toBe('true');
  });
});

describe('載入較早刊期（分頁）', () => {
  it('hasNextPage：撳「載入較早刊期」觸發 onLoadMore', async () => {
    const onLoadMore = vi.fn();
    const c = await mountCatalog({ hasNextPage: true, onLoadMore });
    const more = Array.from(c!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('載入較早刊期'),
    )!;
    expect(more.disabled).toBe(false);
    click(more);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('isFetchingNextPage：按鈕停用兼顯示載入中字樣', async () => {
    const c = await mountCatalog({ hasNextPage: true, isFetchingNextPage: true });
    const more = Array.from(c!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('載入較早刊期中'),
    )!;
    expect(more.disabled).toBe(true);
  });

  it('分頁錯誤：role=alert 提示＋「重試載入較早刊期」再觸發 onLoadMore', async () => {
    const onLoadMore = vi.fn();
    const c = await mountCatalog({
      hasNextPage: true,
      error: '分頁失敗',
      onLoadMore,
    });
    const alert = Array.from(c!.querySelectorAll('[role="alert"]')).find((el) =>
      el.textContent?.includes('較早刊期暫時載入唔到'),
    );
    expect(alert).toBeDefined();
    const retry = Array.from(c!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('重試載入較早刊期'),
    )!;
    click(retry);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});

/* ---------- 停用狀態 ---------- */

describe('停用：blockReason／selectionLocked／hasLaterLineage', () => {
  it('getBlockReason 有原因：嗰件商品停用兼顯示原因，其他商品正常', async () => {
    const onSelectProduct = vi.fn();
    const c = await mountCatalog({
      getBlockReason: (product) => (product.id === 201 ? '呢件已喺現時生成入面' : null),
      onSelectProduct,
    });
    const buttons = productButtonsOf(c!);
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[0].querySelector('em')!.textContent).toBe('呢件已喺現時生成入面');
    expect(buttons[1].disabled).toBe(false);
    expect(buttons[1].querySelector('em')!.textContent).toBe('揀呢件試穿');
  });

  it('selectionLocked：全部商品停用', async () => {
    const c = await mountCatalog({ selectionLocked: true });
    const buttons = productButtonsOf(c!);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });

  it('hasLaterLineage：全部商品停用', async () => {
    const c = await mountCatalog({ hasLaterLineage: true });
    const buttons = productButtonsOf(c!);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });
});
