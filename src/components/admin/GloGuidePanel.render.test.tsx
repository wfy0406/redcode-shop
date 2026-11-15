// @vitest-environment happy-dom
/**
 * GloGuidePanel 真互動測試（happy-dom＋真 React render；trpc 全 mock）：
 * ─ 已揀商品審批卡：現行原圖 img／商品名／類別／原價折扣價／庫存／直播場次／已批標籤／原圖已改提示；
 * ─ 模特兒原圖管理卡：授權提示長期顯示、預覽（JWT base64 data URI）、設預設／刪除真發 mutation、
 *   ENV fallback 清晰標示、滿 8 張上傳掣 disabled。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  const ok = async () => ({});
  const state = {
    models: {
      items: [
        {
          id: 1,
          publicId: 'pub-1',
          path: '/uploads/glo-guide-models/3f6b2a1c-9d4e-4f5a-8b6c-7d8e9f0a1b2c.jpg',
          originalFilename: 'model-a.jpg',
          width: 100,
          height: 200,
          isDefault: true,
          createdByName: '小明',
          createdAt: '2026-11-01T00:00:00.000Z',
        },
        {
          id: 2,
          publicId: 'pub-2',
          path: '/uploads/glo-guide-models/3f6b2a1c-9d4e-4f5a-8b6c-7d8e9f0a1b2d.jpg',
          originalFilename: 'model-b.jpg',
          width: 100,
          height: 200,
          isDefault: false,
          createdByName: '小明',
          createdAt: '2026-11-02T00:00:00.000Z',
        },
      ],
      maxCount: 8,
      fallback: { ref: '/gloglo-3.jpg' },
      effective: { ref: '/uploads/glo-guide-models/3f6b2a1c-9d4e-4f5a-8b6c-7d8e9f0a1b2c.jpg', source: 'db' },
    },
    article: {
      id: 42,
      title: '試題',
      theme: '主題 A',
      body: '第一段\n\n第二段',
      status: 'draft',
      generationStatus: 'idle',
      generationError: null,
      rejectionReason: null,
      source: 'admin',
      createdByName: '小明',
      updatedAt: '2026-11-02T00:00:00.000Z',
      summary: { imagesApproved: 0, images: 0, jobsFailed: 0, jobsActive: 0 },
      products: [
        {
          productId: 101,
          position: 0,
          productNameSnapshot: '舊名',
          sourceImageSnapshot: '/uploads/old.png',
          imageDrifted: true,
          current: {
            sku: 'B244',
            name: '蕾絲花邊衫',
            image: 'https://img.example.com/p1.jpg',
            photos: [],
            aiTags: ['蕾絲', '法式'],
            sizeEnabled: false,
            sizes: [],
            price: 268,
            discountPrice: 239,
            stock: 5,
            isActive: true,
            liveDate: '20261108',
            liveSession: 2,
            category: 'top',
          },
        },
        {
          productId: 102,
          position: 1,
          productNameSnapshot: '已刪裙',
          sourceImageSnapshot: '/uploads/gone.png',
          imageDrifted: false,
          current: null,
        },
      ],
      images: [],
    },
    setDefaultMut: { mutateAsync: vi.fn(ok), isPending: false },
    deleteMut: { mutateAsync: vi.fn(ok), isPending: false },
    uploadMut: { mutateAsync: vi.fn(ok), isPending: false },
    imgGenMut: { mutateAsync: vi.fn(ok), isPending: false },
    invalidateModels: vi.fn(ok),
  };
  return state;
});

vi.mock('@/providers/trpc', () => {
  const mut = () => ({ mutateAsync: vi.fn(async () => ({})), isPending: false });
  const query = (data: unknown) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });
  return {
    trpc: {
      gloGuideAdmin: {
        articles: { useQuery: () => query({ items: [h.article] }) },
        generate: { useMutation: mut },
        update: { useMutation: mut },
        regenerate: { useMutation: mut },
        submit: { useMutation: mut },
        approve: { useMutation: mut },
        reject: { useMutation: mut },
        archive: { useMutation: mut },
        imageGenerate: { useMutation: () => h.imgGenMut },
        imageUpload: { useMutation: mut },
        imageDelete: { useMutation: mut },
        imageReview: { useMutation: mut },
        imageRead: { useQuery: () => query(null) },
        // 選貨 contract（iteration-4）：CreateArticleCard 用呢三個；呢個測試唔開新增卡
        productSources: { useQuery: () => query({ weeks: [], dates: [], sessions: [] }) },
        products: { useQuery: () => query({ items: [] }) },
        modelImages: { useQuery: () => query(h.models) },
        modelImageUpload: { useMutation: () => h.uploadMut },
        modelImageSetDefault: { useMutation: () => h.setDefaultMut },
        modelImageDelete: { useMutation: () => h.deleteMut },
        modelImageRead: { useQuery: () => query({ filename: 'm.jpg', mime: 'image/jpeg', dataBase64: 'QUJD' }) },
      },
      useUtils: () => ({
        gloGuideAdmin: {
          articles: { invalidate: vi.fn(async () => ({})) },
          imageRead: { invalidate: vi.fn(async () => ({})) },
          modelImages: { invalidate: h.invalidateModels },
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

function btnWith(text: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  expect(found, `搵唔到按鈕「${text}」`).toBeTruthy();
  return found as HTMLButtonElement;
}

async function click(text: string) {
  await act(async () => {
    btnWith(text).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  h.setDefaultMut.mutateAsync.mockClear();
  h.deleteMut.mutateAsync.mockClear();
  h.uploadMut.mutateAsync.mockClear();
  h.imgGenMut.mutateAsync.mockClear();
  h.invalidateModels.mockClear();
  h.models.effective = {
    ref: '/uploads/glo-guide-models/3f6b2a1c-9d4e-4f5a-8b6c-7d8e9f0a1b2c.jpg',
    source: 'db',
  };
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

describe('已揀商品審批卡', () => {
  it('逐件顯示原圖 img／名／類別／原價折扣價／庫存／直播場次／已批標籤／原圖已改提示', async () => {
    await renderPanel();
    await click('展開');

    const cards = container!.querySelectorAll('.ggp-pick-card');
    expect(cards).toHaveLength(2);

    // 第一件：現行商品 facts 全齊
    const first = cards[0]!;
    const img = first.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://img.example.com/p1.jpg');
    const text = first.textContent ?? '';
    expect(text).toContain('蕾絲花邊衫');
    expect(text).toContain('貨號 B244');
    expect(text).toContain('上衣'); // 類別
        expect(text).toContain('HK$239'); // 折扣價
    expect(text).toContain('HK$268'); // 原價（刪除線）
    expect(text).toContain('庫存 5');
    expect(text).toContain('20261108');
    expect(text).toContain('第 2 場');
    expect(text).toContain('蕾絲／法式'); // 已批准標籤
    expect(text).toContain('原圖已改');
    expect(text).toContain('對應配搭圖要重生');

    // 第二件：商品已刪除 → 回落 snapshot 原圖＋snapshot 名
    const second = cards[1]!;
    expect(second.querySelector('img')?.getAttribute('src')).toBe('/uploads/gone.png');
    expect(second.textContent).toContain('已刪裙');
    expect(second.textContent).toContain('商品已刪除');
  });
});

describe('逐商品增加生成', () => {
  it('預設揀第一件商品；撳增加生成會送 productId，同一件可以重複再出圖', async () => {
    await renderPanel();
    await click('展開');
    expect(container!.textContent).toContain('初次生成會每件商品出一張');
    expect(container!.textContent).not.toContain('上架要 3–5 張');
    await click('增加生成');
    expect(h.imgGenMut.mutateAsync).toHaveBeenCalledWith({ id: 42, productId: 101 });
    await click('增加生成');
    expect(h.imgGenMut.mutateAsync).toHaveBeenCalledTimes(2);
  });
});

describe('模特兒原圖管理卡', () => {
  it('授權提示長期顯示；列表預覽用 JWT base64 data URI；預設／備用標示清楚', async () => {
    await renderPanel();
    await click('模特兒原圖');

    const text = container!.textContent ?? '';
    expect(text).toContain('只可以上傳真實、已獲授權嘅模特兒照片；唔好用 AI 合成圖當原圖');
    expect(text).toContain('Fashn 生成配搭圖每次淨係用一張');
    expect(text).toContain('模特兒原圖（2/8）');
    expect(text).toContain('預設・新文章用呢張');
    expect(text).toContain('備用');

    const imgs = [...container!.querySelectorAll('.ggp-image-card img')].map((i) =>
      i.getAttribute('src'),
    );
    expect(imgs).toEqual(['data:image/jpeg;base64,QUJD', 'data:image/jpeg;base64,QUJD']);
    // 原圖絕不公開：DOM 入面唔應該有私密 path 做 img src
    expect(imgs.some((s) => s?.startsWith('/uploads/glo-guide-models/'))).toBe(false);
  });

  it('撳「設為預設」→ 真發 mutation（之後先 invalidate）；撳「刪除」→ confirm 後真發 mutation', async () => {
    await renderPanel();
    await click('模特兒原圖');

    await click('設為預設');
    expect(h.setDefaultMut.mutateAsync).toHaveBeenCalledTimes(1);
    expect(h.setDefaultMut.mutateAsync).toHaveBeenCalledWith({ id: 2 });

    const delBtns = [...container!.querySelectorAll('button')].filter(
      (b) => b.textContent?.includes('刪除') && b.closest('.ggp-image-card'),
    );
    expect(delBtns).toHaveLength(2);
    await act(async () => {
      delBtns[0]!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(h.deleteMut.mutateAsync).toHaveBeenCalledTimes(1);
    expect(h.deleteMut.mutateAsync).toHaveBeenCalledWith({ id: 1 });
    expect(h.invalidateModels).toHaveBeenCalled();
  });

  it('DB 冇相 → 清晰標示內建預設 fallback（/gloglo-3.jpg）', async () => {
    h.models.items = [];
    h.models.effective = { ref: '/gloglo-3.jpg', source: 'env' };
    await renderPanel();
    await click('模特兒原圖');
    const text = container!.textContent ?? '';
    expect(text).toContain('而家冇已上傳模特兒原圖');
    expect(text).toContain('/gloglo-3.jpg');
    // 還原
    h.models.items = [
      {
        id: 1, publicId: 'pub-1', path: '/uploads/glo-guide-models/x.jpg', originalFilename: 'model.jpg',
        width: 100, height: 200, isDefault: true, createdByName: '小明', createdAt: '2026-11-01T00:00:00.000Z',
      },
    ];
  });

  it('滿 8 張 → 上傳掣 disabled（唔係假掣，係真擋）', async () => {
    h.models.items = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1, publicId: `pub-${i}`, path: '/uploads/glo-guide-models/x.jpg', originalFilename: 'model.jpg',
      width: 100, height: 200, isDefault: i === 0, createdByName: '小明', createdAt: '2026-11-01T00:00:00.000Z',
    }));
    await renderPanel();
    await click('模特兒原圖');
    const up = btnWith('上傳原圖');
    expect(up.disabled).toBe(true);
    expect(container!.textContent).toContain('已達 8 張上限');
  });
});
