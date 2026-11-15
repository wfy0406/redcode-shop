// @vitest-environment happy-dom
/**
 * GloGuidePanel 選貨區真互動測試（iteration-3 SPEC；happy-dom＋真 React render；trpc 全 mock）：
 * ─ 四種選貨 tab（自動／指定星期／指定場次／指定商品）齊，預設自動；
 * ─ productSources 真星期／日期場次選項；products query 按 mode 送啱 filter；
 * ─ 商品 usedBefore／ineligible 真 disabled＋原因；2–3 件選擇閘；
 * ─ generate 淨係送 {selection, themeHint}（SPEC：同時送 top-level productIds 會 400）；
 * ─ loading／empty／error＋重試；busy 防重複。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  const ok = async () => ({});
  const defaultItems = [
    {
      id: 11, name: '蕾絲花邊衫', image: '/a.jpg', price: 268, discountPrice: 239,
      aiTags: ['蕾絲', '法式'], liveDate: '20261108', liveSession: '2', category: 'top', stock: 5,
      usedBefore: false, eligible: true, ineligibleReason: null,
    },
    {
      id: 12, name: '牛仔褸', image: '/b.jpg', price: 399, discountPrice: null,
      aiTags: [], liveDate: '20261108', liveSession: '2', category: 'outer', stock: 3,
      usedBefore: false, eligible: true, ineligibleReason: null,
    },
    {
      id: 13, name: '舊裙', image: '/c.jpg', price: 199, discountPrice: null,
      aiTags: [], liveDate: '20261107', liveSession: '1', category: 'dress', stock: 2,
      usedBefore: true, eligible: false, ineligibleReason: 'used',
    },
    {
      id: 14, name: '缺貨長褲', image: '/d.jpg', price: 259, discountPrice: null,
      aiTags: [], liveDate: '20261108', liveSession: '2', category: 'bottom', stock: 0,
      usedBefore: false, eligible: false, ineligibleReason: 'out_of_stock',
    },
  ];
  const state = {
    defaultItems,
    sources: {
      weeks: [
        { weekStart: '2026-11-02', weekEnd: '2026-11-08', total: 4, eligible: 3 },
        { weekStart: '2026-10-26', weekEnd: '2026-11-01', total: 3, eligible: 0 },
      ],
      sessions: [
        { liveDate: '20261108', liveSession: '2', total: 3, eligible: 2 },
        { liveDate: '20261108', liveSession: '1', total: 2, eligible: 0 },
      ],
    },
    productItems: defaultItems,
    productsState: { loading: false, error: null as null | { message: string } },
    sourcesState: { loading: false, error: null as null | { message: string } },
    generatePending: false,
    // 型別同真 generate input 對齊（SPEC：selection 或舊 top-level productIds 二选一）——
    // 唔用 any，等 mock.calls 攞到真參數型別而唔係空 tuple。
    generateMutate: vi.fn(
      async (_input: { selection?: unknown; productIds?: number[]; themeHint?: string }) => ({ id: 99 }),
    ),
    productsUseQuery: vi.fn(),
    productsRefetch: vi.fn(ok),
    invalidateArticles: vi.fn(ok),
    invalidateProducts: vi.fn(ok),
    invalidateSources: vi.fn(ok),
  };
  return state;
});

vi.mock('@/providers/trpc', () => {
  const mut = () => ({ mutateAsync: vi.fn(async () => ({})), isPending: false });
  const query = (data: unknown) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });
  const article = {
    id: 42, title: '試題', theme: '主題 A', body: '第一段\n\n第二段', status: 'draft',
    generationStatus: 'idle', generationError: null, rejectionReason: null, source: 'admin',
    createdByName: '小明', updatedAt: '2026-11-02T00:00:00.000Z',
    summary: { imagesApproved: 0, images: 0, jobsFailed: 0, jobsActive: 0 },
    products: [], images: [],
  };
  return {
    trpc: {
      gloGuideAdmin: {
        articles: { useQuery: () => query({ items: [article] }) },
        generate: { useMutation: () => ({ mutateAsync: h.generateMutate, isPending: h.generatePending }) },
        update: { useMutation: mut },
        regenerate: { useMutation: mut },
        submit: { useMutation: mut },
        approve: { useMutation: mut },
        reject: { useMutation: mut },
        archive: { useMutation: mut },
        imageGenerate: { useMutation: mut },
        imageUpload: { useMutation: mut },
        imageDelete: { useMutation: mut },
        imageReview: { useMutation: mut },
        imageRead: { useQuery: () => query(null) },
        productSources: {
          useQuery: () =>
            h.sourcesState.error
              ? { data: undefined, isLoading: false, isError: true, error: h.sourcesState.error, refetch: vi.fn() }
              : h.sourcesState.loading
                ? { data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() }
                : query(h.sources),
        },
        products: {
          useQuery: (input: unknown) => {
            h.productsUseQuery(input);
            if (h.productsState.error) {
              return { data: undefined, isLoading: false, isError: true, error: h.productsState.error, refetch: h.productsRefetch };
            }
            if (h.productsState.loading) {
              return { data: undefined, isLoading: true, isError: false, error: null, refetch: h.productsRefetch };
            }
            return { data: { items: h.productItems }, isLoading: false, isError: false, error: null, refetch: h.productsRefetch };
          },
        },
        modelImages: { useQuery: () => query({ items: [], maxCount: 8, fallback: { ref: '/gloglo-3.jpg' }, effective: { ref: '/gloglo-3.jpg', source: 'env' } }) },
        modelImageUpload: { useMutation: mut },
        modelImageSetDefault: { useMutation: mut },
        modelImageDelete: { useMutation: mut },
        modelImageRead: { useQuery: () => query(null) },
      },
      useUtils: () => ({
        gloGuideAdmin: {
          articles: { invalidate: h.invalidateArticles },
          imageRead: { invalidate: vi.fn(async () => ({})) },
          modelImages: { invalidate: vi.fn(async () => ({})) },
          products: { invalidate: h.invalidateProducts },
          productSources: { invalidate: h.invalidateSources },
        },
      }),
    },
  };
});

import GloGuidePanel from './GloGuidePanel';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const toastMock = vi.fn();

async function renderPanel() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<GloGuidePanel toast={toastMock} canReview={true} />);
  });
  return container;
}

function btnWith(text: string, scope?: ParentNode): HTMLButtonElement {
  const found = [...(scope ?? container!).querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  expect(found, `搵唔到按鈕「${text}」`).toBeTruthy();
  return found as HTMLButtonElement;
}

async function click(text: string, scope?: ParentNode) {
  await act(async () => {
    btnWith(text, scope).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

async function openCreate() {
  await renderPanel();
  await click('新增文章');
}

function productBtn(name: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll<HTMLButtonElement>('.ggp-product')].find((b) =>
    b.textContent?.includes(name),
  );
  expect(found, `搵唔到商品卡「${name}」`).toBeTruthy();
  return found!;
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

beforeEach(() => {
  h.generateMutate.mockClear();
  h.productsUseQuery.mockClear();
  h.productsRefetch.mockClear();
  h.invalidateArticles.mockClear();
  h.invalidateProducts.mockClear();
  h.invalidateSources.mockClear();
  toastMock.mockClear();
  h.generatePending = false;
  h.productItems = h.defaultItems;
  h.productsState = { loading: false, error: null };
  h.sourcesState = { loading: false, error: null };
  vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = '';
});

describe('四種選貨方式', () => {
  it('四個 tab 齊＋預設自動揀貨；products query 收 {mode:"auto"}', async () => {
    await openCreate();
    for (const label of ['自動揀貨', '指定星期', '指定場次', '指定商品']) {
      expect(btnWith(label)).toBeTruthy();
    }
    const auto = btnWith('自動揀貨');
    expect(auto.getAttribute('aria-pressed')).toBe('true');
    expect(h.productsUseQuery).toHaveBeenCalledWith({ mode: 'auto' });
    expect(container!.textContent).toContain('曾經出現喺任何指南嘅商品會永久鎖定');
  });

  it('自動揀貨係只讀預覽：冇可撿商品掣，顯示合資格隨機池示例（唔係實際必中名單）', async () => {
    await openCreate();
    const grid = container!.querySelector('.ggp-product-grid');
    expect(grid).toBeTruthy();
    // 一件可撿商品掣都唔應該有
    expect(grid!.querySelectorAll('button')).toHaveLength(0);
    // 只顯示合資格未用嘅（11／12）；用過（13）同缺貨（14）唔會出現
    const statics = grid!.querySelectorAll('.ggp-product-static');
    expect(statics).toHaveLength(2);
    const text = grid!.textContent ?? '';
    expect(text).toContain('蕾絲花邊衫');
    expect(text).toContain('牛仔褸');
    expect(text).not.toContain('舊裙');
    expect(text).not.toContain('缺貨長褲');
    expect(container!.textContent).toContain('只讀，唔使揀');
    // 文案只可以話係「合資格隨機池示例」，唔准聲稱係 server 實際必中名單
    expect(container!.textContent).toContain('合資格隨機池示例');
    expect(container!.textContent).toContain('唔係實際必中名單');
    expect(container!.textContent).not.toContain('server 實際會揀');
    // 預覽唔入 tab order：冇 aria-pressed 元素
    expect(grid!.querySelectorAll('[aria-pressed]')).toHaveLength(0);
  });

  it('自動揀貨生成：淨送 {selection:{mode:"auto"}}，冇 top-level productIds', async () => {
    await openCreate();
    await click('產生文章＋相');
    expect(h.generateMutate).toHaveBeenCalledTimes(1);
    const arg = h.generateMutate.mock.calls[0]![0];
    expect(arg.selection).toEqual({ mode: 'auto' });
    expect('productIds' in arg).toBe(false);
    expect(h.invalidateArticles).toHaveBeenCalled();
    expect(h.invalidateProducts).toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('已開始生成'), 'success');
  });
});

describe('指定星期', () => {
  it('顯示 productSources 真星期選項；products query 收 {mode:"week", weekStart}', async () => {
    await openCreate();
    await click('指定星期');
    const sel = container!.querySelector<HTMLSelectElement>('#ggp-week');
    expect(sel).toBeTruthy();
    const labels = [...sel!.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels[0]).toContain('2026-11-02');
    expect(labels[0]).toContain('可揀 3/4 件');
    expect(labels[1]).toContain('2026-10-26');
    // 預設用第一週
    expect(h.productsUseQuery).toHaveBeenCalledWith({ mode: 'week', weekStart: '2026-11-02' });
  });

  it('used／缺貨商品真 disabled＋原因；揀 2 件合資格商品生成送 week selection', async () => {
    await openCreate();
    await click('指定星期');

    const used = productBtn('舊裙');
    expect(used.disabled).toBe(true);
    expect(used.textContent).toContain('已用過');
    const oos = productBtn('缺貨長褲');
    expect(oos.disabled).toBe(true);
    expect(oos.textContent).toContain('缺貨');

    await click('蕾絲花邊衫');
    await click('牛仔褸');
    expect(btnWith('產生文章＋相').textContent).toContain('已揀 2 件');

    await click('產生文章＋相');
    const arg = h.generateMutate.mock.calls[0]![0];
    expect(arg.selection).toEqual({ mode: 'week', weekStart: '2026-11-02', productIds: [11, 12] });
    expect('productIds' in arg).toBe(false);
  });

  it('唔揀商品 → 來源隨機抽：送 {mode:"week", weekStart} 冇 productIds', async () => {
    await openCreate();
    await click('指定星期');
    expect(container!.textContent).toContain('唔揀商品會由呢個來源嘅合資格池隨機抽 2–3 件');
    await click('產生文章＋相');
    const arg = h.generateMutate.mock.calls[0]![0];
    expect(arg.selection).toEqual({ mode: 'week', weekStart: '2026-11-02' });
  });

  it('換星期 → 已揀商品清空（productIds 一定要屬當前來源）', async () => {
    await openCreate();
    await click('指定星期');
    await click('蕾絲花邊衫');
    expect(btnWith('產生文章＋相').textContent).toContain('已揀 1 件');
    // 揀 1 件未夠 2 件 → 生成掣 disabled
    expect(btnWith('產生文章＋相').disabled).toBe(true);

    const sel = container!.querySelector<HTMLSelectElement>('#ggp-week')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(sel, '2026-10-26');
      sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect(h.productsUseQuery).toHaveBeenCalledWith({ mode: 'week', weekStart: '2026-10-26' });
    expect(btnWith('產生文章＋相').textContent).not.toContain('已揀');
  });
});

describe('指定場次', () => {
  it('顯示真日期＋場次選項；生成送 {mode:"session", liveDate, liveSession}', async () => {
    await openCreate();
    await click('指定場次');
    const sel = container!.querySelector<HTMLSelectElement>('#ggp-session');
    expect(sel).toBeTruthy();
    const labels = [...sel!.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels[0]).toContain('20261108');
    expect(labels[0]).toContain('第 2 場');
    expect(labels[0]).toContain('可揀 2/3 件');
    expect(h.productsUseQuery).toHaveBeenCalledWith({ mode: 'session', liveDate: '20261108', liveSession: '2' });

    await click('產生文章＋相');
    const arg = h.generateMutate.mock.calls[0]![0];
    expect(arg.selection).toEqual({ mode: 'session', liveDate: '20261108', liveSession: '2' });
    expect('productIds' in arg).toBe(false);
  });
});

describe('指定商品（真搜尋）', () => {
  it('未搜尋前有提示；搜尋後 products query 收 {mode:"search", query}；揀 2 件生成', async () => {
    await openCreate();
    await click('指定商品');
    expect(container!.textContent).toContain('輸入關鍵字撳「搜尋」');
    // 未搜尋 → 生成掣 disabled（products 必要 2–3 件）
    expect(btnWith('產生文章＋相').disabled).toBe(true);

    const input = container!.querySelector<HTMLInputElement>('#ggp-product-search')!;
    expect(input).toBeTruthy();
    await act(async () => {
      setInputValue(input, '蕾絲');
    });
    const form = container!.querySelector('form.ggp-search')!;
    await act(async () => {
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(h.productsUseQuery).toHaveBeenCalledWith({ mode: 'search', query: '蕾絲' });

    await click('蕾絲花邊衫');
    await click('牛仔褸');
    await click('產生文章＋相');
    const arg = h.generateMutate.mock.calls[0]![0];
    expect(arg.selection).toEqual({ mode: 'products', productIds: [11, 12] });
    expect('productIds' in arg).toBe(false);
  });

  it('搜尋字全空白 → 搜尋掣 disabled（SPEC：query 要 1–60 字）', async () => {
    await openCreate();
    await click('指定商品');
    const input = container!.querySelector<HTMLInputElement>('#ggp-product-search')!;
    await act(async () => {
      setInputValue(input, '   ');
    });
    expect(btnWith('搜尋').disabled).toBe(true);
  });
});

describe('狀態處理', () => {
  it('商品載入中 → 載入文案；error → 真錯誤＋重試掣真 refetch', async () => {
    h.productsState = { loading: true, error: null };
    await openCreate();
    expect(container!.textContent).toContain('載入商品中…');
  });

  it('error → 顯示錯誤同重試', async () => {
    h.productsState = { loading: false, error: { message: 'DB 連線失敗' } };
    await openCreate();
    expect(container!.textContent).toContain('載入商品失敗：DB 連線失敗');
    await click('重試');
    expect(h.productsRefetch).toHaveBeenCalledTimes(1);
  });

  it('empty → 對應來源嘅空態文案', async () => {
    h.productItems = [];
    await openCreate();
    expect(container!.textContent).toContain('而家冇任何星期有最少 2 件從未用過嘅合資格商品');
  });

  it('busy（生成中）→ 生成掣、tab、星期選擇同商品卡全部 disabled（防重複）', async () => {
    await openCreate();
    await click('指定星期');
    // mock 嘅 isPending 係 render 嗰刻讀 h.generatePending → 重 render 一次令 busy 生效
    h.generatePending = true;
    await act(async () => {
      root!.render(<GloGuidePanel toast={toastMock} canReview={true} />);
    });
    expect(btnWith('產生文章＋相').disabled).toBe(true);
    for (const t of ['自動揀貨', '指定星期', '指定場次', '指定商品']) {
      expect(btnWith(t).disabled).toBe(true);
    }
    expect(container!.querySelector<HTMLSelectElement>('#ggp-week')!.disabled).toBe(true);
    expect(productBtn('蕾絲花邊衫').disabled).toBe(true);
  });
});
