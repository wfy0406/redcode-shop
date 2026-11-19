/**
 * GloGuideList 頁面測試（v3 潮牌雜誌版）：
 *
 * SSR（renderToString，mock trpc）：
 * - 主視覺：固定路徑 /glo-guide/glo-glo-editorial-hero.webp，eager＋
 *   fetchPriority=high＋固定 width/height（LCP），任何狀態都在
 * - published：期刊期號（No.03／第 3 期）＋非對稱 lead＋「呢期單品」同步欄
 *   （真商品 Link）＋全寬主配搭圖 gallery（呢期全部公開配搭圖出齊 slides，
 *   上一張／下一張制＋「第 X 張，共 Y 張」status）＋thumbnail index
 *   （aria-pressed 預設第一篇）＋今期目錄全部真 Link /glo-guide/:slug；
 *   香港發文時間 <time dateTime=ISO>
 * - 空態：主視覺仍在＋欄目介紹＋/products＋/live CTA＋tabs（tablist）
 * - 載入中（role=status）／錯誤（role=alert＋重試）
 * - 公開措辭：任何狀態都唔准出現「生成」「人工審核」「AI」；必有
 *   「Glo Glo 撰寫」「配搭圖」「商品外觀以商品頁原圖為準」
 * - CSS source assertion：.ggx-hero-img／.ggx-stage-img 原比例完整顯示，
 *   無 aspect-ratio／object-fit:cover／object-position；gallery 制 ≥44px
 *
 * 互動（happy-dom＋createRoot）：
 * - click／focus／hover thumbnail 切換頭版 synopsis＋呢期單品欄；ArrowRight 鍵盤切換
 * - 主圖上一張／下一張制循環（wrap）；切換文章 gallery 歸零返嗰篇第一張
 * - 空態 tabs click／ArrowRight 切換 panel（hidden／aria-selected）
 */

// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GLO_GUIDE_DERIVATIVE_FALLBACK_WIDTH,
  gloGuideDerivativeUrl,
} from '@contracts/gloGuide';
import GloGuideList, { GLO_GUIDE_HERO_SRC } from './GloGuideList';

/** R05：GuidePicture 嘅 <img src> 係中檔 WebP derivative 兜底（唔再係原 PNG） */
const stageSrc = (path: string) =>
  gloGuideDerivativeUrl(path, GLO_GUIDE_DERIVATIVE_FALLBACK_WIDTH, 'webp');

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  listQuery: {
    data: undefined as unknown,
    error: null as null | { message: string },
    isPending: false,
    isError: false,
    isSuccess: false,
    refetch: vi.fn(),
  },
}));

vi.mock('@/providers/trpc', () => ({
  trpc: {
    gloGuide: {
      list: { useQuery: () => mocks.listQuery },
    },
  },
}));

const PRODUCT = (id: number, name: string, price: number, discountPrice: number | null = null) => ({
  id,
  name,
  image: `/p${id}.jpg`,
  photos: [],
  price,
  discountPrice,
  category: 'top',
  stock: 3,
  sizeEnabled: false,
  sizes: [],
  aiTags: [],
  isActive: true,
  liveDate: null,
  liveSession: null,
});

const GUIDE_IMAGE = (id: number, slug: string, position: number, title: string) => ({
  id: id * 10 + position,
  path: `/uploads/glo-guide/${slug}-${position}.png`,
  alt: `${title} 配搭圖 ${position + 1}`,
  width: 800,
  height: 1200,
  position,
  productId: null,
});

const ITEM = (id: number, slug: string, title: string, products: unknown[] = [], imageCount = 2) => {
  const images = Array.from({ length: imageCount }, (_, p) =>
    GUIDE_IMAGE(id, slug, p, title),
  );
  return {
    id,
    slug,
    title,
    excerpt: `第 ${id} 篇節錄。`,
    theme: `主題${id}`,
    publishedAt: '2026-11-14T16:30:00.000Z',
    updatedAt: '2026-11-15T02:00:00.000Z',
    coverImage: images[0] ?? null,
    images,
    products,
  };
};

const THREE_ITEMS = {
  items: [
    ITEM(1, 'first-post', '第一篇', [PRODUCT(101, '米白短外套', 200, 150)], 2),
    ITEM(2, 'second-post', '第二篇', [PRODUCT(102, '軟皮闊腳褲', 168)], 3),
    ITEM(3, 'third-post', '第三篇', [], 1),
  ],
};

function setQuery(partial: Partial<typeof mocks.listQuery>) {
  mocks.listQuery.data = undefined;
  mocks.listQuery.error = null;
  mocks.listQuery.isPending = false;
  mocks.listQuery.isError = false;
  mocks.listQuery.isSuccess = false;
  Object.assign(mocks.listQuery, partial);
}

function renderList() {
  return renderToString(
    <MemoryRouter initialEntries={['/glo-guide']}>
      <GloGuideList />
    </MemoryRouter>,
  );
}

const BANNED = ['生成', '人工審核', 'AI 配搭圖', 'AI 配搭效果圖', 'AI'];

function expectPublicWording(html: string) {
  for (const word of BANNED) {
    expect(html).not.toContain(word);
  }
  expect(html).toContain('Glo Glo 撰寫');
  expect(html).toContain('配搭圖');
  expect(html).toContain('商品外觀以商品頁原圖為準');
}

describe('GloGuideList 主視覺（所有狀態）', () => {
  it('固定路徑 hero：eager＋fetchPriority=high＋固定 width/height＋alt', () => {
    setQuery({ isPending: true });
    const html = renderList();
    expect(html).toContain(`src="${GLO_GUIDE_HERO_SRC}"`);
    expect(html).toContain('width="1536"');
    expect(html).toContain('height="1024"');
    expect(html).toContain('alt="Glo Glo 身穿米白立領短外套配灰色闊腳褲，示範今期直播單品配搭"');
    expect(html.match(/loading="eager"/g)).toHaveLength(1);
    // React 19 SSR 原樣輸出 fetchPriority="high"；HTML 屬性不分大小寫
    expect(html.match(/fetchpriority="high"/gi)).toHaveLength(2); // img 屬性＋React 19 preload link
  });

  it('hero 預設唔出 fallback 舞台（真圖在）；fallback 舞台 class 已備好', () => {
    setQuery({ isPending: true });
    const html = renderList();
    expect(html).not.toContain('ggx-hero-fallback');
  });
});

describe('GloGuideList 內容（published）', () => {
  it('頭版舞台＋期刊期號＋呢期單品欄＋thumbnail index＋目錄全部真連結', () => {
    setQuery({ isSuccess: true, data: THREE_ITEMS });
    const html = renderList();
    expect(html).toContain('ggx-stage');
    expect(html).toContain('ggx-index');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    // 期刊期號：最新一篇係第 3 期（刊登序，最新數字最大）
    expect(html).toContain('No.03');
    expect(html).toContain('第 3 期，共 3 期');
    expect(html).toContain('已刊登 3 期');
    expect(html).toContain('顯示第 3 期：第一篇');
    // 呢期單品欄：第一篇嘅真商品（名＋折扣價＋原價刪線）
    expect(html).toContain('呢期單品');
    expect(html).toContain('href="/products/101"');
    expect(html).toContain('HK$150');
    expect(html).toContain('HK$200');
    expect(html).toContain('href="/glo-guide/first-post"');
    expect(html).toContain('href="/glo-guide/second-post"');
    expect(html).toContain('href="/glo-guide/third-post"');
    expect(html).toContain('今期目錄');
    expect(html).toContain('2026年11月15日 00:30');
  });

  it('LCP：hero eager＋high；頭版首張 slide eager（唔搶 high），其餘 slides＋thumbnails lazy', () => {
    setQuery({ isSuccess: true, data: THREE_ITEMS });
    const html = renderList();
    expect(html.match(/loading="eager"/g)).toHaveLength(2); // hero＋頭版首張 slide
    expect(html.match(/fetchpriority="high"/gi)).toHaveLength(2); // 得 hero（屬性＋preload）
    // 第一篇第二張 slide lazy＋3 個 index thumbnails lazy
    expect(html.match(/loading="lazy"/g)).toHaveLength(4);
  });

  it('頭版主圖 gallery：呢期全部公開配搭圖出齊 slides＋上一張／下一張制＋status', () => {
    setQuery({ isSuccess: true, data: THREE_ITEMS });
    const html = renderList();
    // 第一篇兩張配搭圖都喺 SSR 出現（唔係得封面）
    expect(html).toContain('/uploads/glo-guide/first-post-0.png');
    expect(html).toContain('/uploads/glo-guide/first-post-1.png');
    // 明顯上一張／下一張制（粵語無障礙名）＋位置 status
    expect(html).toContain('aria-label="上一張配搭圖"');
    expect(html).toContain('aria-label="下一張配搭圖"');
    expect(html).toContain('第 1 張，共 2 張');
    expect(html).toContain('role="status"');
  });

  it('只有一篇／一篇得一張圖：唔出上一張／下一張死制', () => {
    setQuery({ isSuccess: true, data: { items: [ITEM(1, 'only-one', '唯一', [], 1)] } });
    const html = renderList();
    expect(html).toContain('ggx-stage');
    expect(html).toContain('No.01');
    expect(html.match(/ggx-index-btn/g)?.length).toBeGreaterThan(0);
    expect(html).toContain('href="/glo-guide/only-one"');
    expect(html).toContain('/uploads/glo-guide/only-one-0.png');
    expect(html).not.toContain('上一張配搭圖');
    expect(html).not.toContain('下一張配搭圖');
  });

  it('舊 fixture 冇 images 欄：落返單張 coverImage，唔會炸', () => {
    const legacy = ITEM(1, 'legacy-one', '舊格式', [], 2) as Record<string, unknown>;
    delete legacy.images;
    setQuery({ isSuccess: true, data: { items: [legacy] } });
    const html = renderList();
    expect(html).toContain('/uploads/glo-guide/legacy-one-0.png');
    expect(html).not.toContain('上一張配搭圖');
  });

  it('公開措辭：有 Glo Glo 撰寫／配搭圖，無禁用字眼', () => {
    setQuery({ isSuccess: true, data: THREE_ITEMS });
    expectPublicWording(renderList());
  });
});

describe('GloGuideList 主視覺／主圖唔裁切（CSS source assertion）', () => {
  it('.ggx-hero-img 用真圖 1536×1024 原比例：無 aspect-ratio／object-fit／object-position', () => {
    const css = readFileSync('src/pages/GloGuideList.css', 'utf8');
    const blocks = css.match(/\.ggx-hero-img\s*\{[^}]*\}/g) ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toContain('aspect-ratio');
      expect(block).not.toContain('object-fit');
      expect(block).not.toContain('object-position');
    }
    expect(blocks[0]).toContain('width: 100%');
    expect(blocks[0]).toContain('height: auto');
  });

  it('.ggx-stage-img 按原圖比例完整顯示：無固定 aspect-ratio／object-fit: cover', () => {
    const css = readFileSync('src/pages/GloGuideList.css', 'utf8');
    const blocks = css.match(/\.ggx-stage-img\s*\{[^}]*\}/g) ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toContain('aspect-ratio');
      expect(block).not.toContain('object-fit: cover');
      expect(block).not.toContain('object-position');
    }
    expect(blocks[0]).toContain('width: 100%');
    expect(blocks[0]).toContain('height: auto');
    expect(blocks[0]).toContain('object-fit: contain');
  });

  it('gallery 上一張／下一張制 ≥44px（全站 index.css 共用區，詳情頁直接開都有）', () => {
    const css = readFileSync('src/index.css', 'utf8');
    const block = css.match(/\.glo-guide-gallery-nav\s*\{[^}]*\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toContain('width: 44px');
    expect(block![0]).toContain('height: 44px');
    expect(block![0]).toContain('position: absolute');
  });
});

describe('GloGuideList 狀態', () => {
  it('載入中 role=status', () => {
    setQuery({ isPending: true });
    const html = renderList();
    expect(html).toContain('role="status"');
    expectPublicWording(html);
  });

  it('錯誤 role=alert＋重新載入按鈕', () => {
    setQuery({ isError: true, error: { message: 'network' } });
    const html = renderList();
    expect(html).toContain('role="alert"');
    expect(html).toContain('重新載入');
    expectPublicWording(html);
  });

  it('空列表：主視覺仍在＋欄目介紹＋CTA＋tabs，無禁用字眼', () => {
    setQuery({ isSuccess: true, data: { items: [] } });
    const html = renderList();
    expect(html).toContain('暫時未有已發布指南');
    expect(html).not.toContain('撰寫中');
    expect(html).toContain(GLO_GUIDE_HERO_SRC);
    expect(html.match(/loading="eager"/g)).toHaveLength(1);
    expect(html).toContain('href="/products"');
    expect(html).toContain('href="/live"');
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('aria-selected="true"');
    expect(html.match(/role="tabpanel"/g)).toHaveLength(3);
    expect(html.match(/hidden/g)?.length).toBeGreaterThanOrEqual(2); // 非選中 panel hidden
    expectPublicWording(html);
  });
});

/* ---------- 互動（happy-dom） ---------- */

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mountList() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={['/glo-guide']}>
        <GloGuideList />
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

function indexButtons(c: HTMLElement) {
  return Array.from(c.querySelectorAll<HTMLButtonElement>('.ggx-index-btn'));
}

function stageTitle(c: HTMLElement) {
  return c.querySelector('.ggx-stage-title')?.textContent ?? '';
}

describe('GloGuideList 互動：article selector', () => {
  it('click 第二個 thumbnail → 頭版切到第二篇，期號同 aria-pressed 跟住走', () => {
    setQuery({ isSuccess: true, data: THREE_ITEMS });
    const c = mountList();
    expect(stageTitle(c)).toContain('第一篇');
    const buttons = indexButtons(c);
    expect(buttons).toHaveLength(3);
    act(() => {
      buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(stageTitle(c)).toContain('第二篇');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
    expect(c.querySelector('.ggx-stage-title a')?.getAttribute('href')).toBe(
      '/glo-guide/second-post',
    );
    expect(c.querySelector('.ggx-issue')?.getAttribute('aria-label')).toBe('第 2 期，共 3 期');
  });

  it('切換文章時「呢期單品」欄同步對應商品資訊', () => {
    setQuery({ isSuccess: true, data: THREE_ITEMS });
    const c = mountList();
    const strip = () => c.querySelector('.ggx-stage-products')?.textContent ?? '';
    expect(strip()).toContain('米白短外套');
    const buttons = indexButtons(c);
    act(() => {
      buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(strip()).toContain('軟皮闊腳褲');
    expect(strip()).not.toContain('米白短外套');
    expect(
      c.querySelector<HTMLAnchorElement>('.ggx-stage-product a')?.getAttribute('href'),
    ).toBe('/products/102');
    // 第三篇冇單品 → 成個欄唔出（唔會留空殼）
    act(() => {
      buttons[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(c.querySelector('.ggx-stage-products')).toBeNull();
  });

  it('focus 第三個 thumbnail → 頭版切到第三篇（鍵盤 Tab 到即用）', () => {
    setQuery({ isSuccess: true, data: THREE_ITEMS });
    const c = mountList();
    const buttons = indexButtons(c);
    act(() => {
      buttons[2].dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(stageTitle(c)).toContain('第三篇');
    expect(buttons[2].getAttribute('aria-pressed')).toBe('true');
  });

  it('hover（mouseover）thumbnail → 頭版跟住切', () => {
    setQuery({ isSuccess: true, data: THREE_ITEMS });
    const c = mountList();
    const buttons = indexButtons(c);
    act(() => {
      buttons[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(stageTitle(c)).toContain('第二篇');
  });

  it('ArrowRight 喺 index 入面移動 selection', () => {
    setQuery({ isSuccess: true, data: THREE_ITEMS });
    const c = mountList();
    const buttons = indexButtons(c);
    act(() => {
      buttons[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(stageTitle(c)).toContain('第二篇');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
  });
});

describe('GloGuideList 互動：主圖 gallery 上一張／下一張', () => {
  const statusText = (c: HTMLElement) =>
    c.querySelector('.glo-guide-gallery-status')?.textContent ?? '';

  it('下一張／上一張循環瀏覽呢期全部配搭圖（wrap：尾→頭、頭→尾）', () => {
    setQuery({ isSuccess: true, data: THREE_ITEMS });
    const c = mountList();
    const next = c.querySelector<HTMLButtonElement>('button[aria-label="下一張配搭圖"]');
    const prev = c.querySelector<HTMLButtonElement>('button[aria-label="上一張配搭圖"]');
    expect(next).not.toBeNull();
    expect(prev).not.toBeNull();
    expect(statusText(c)).toContain('第 1 張，共 2 張');
    expect(
      c.querySelector('[data-active="true"] .ggx-stage-img')?.getAttribute('src'),
    ).toBe(stageSrc('/uploads/glo-guide/first-post-0.png'));
    act(() => {
      next!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(statusText(c)).toContain('第 2 張，共 2 張');
    expect(
      c.querySelector('[data-active="true"] .ggx-stage-img')?.getAttribute('src'),
    ).toBe(stageSrc('/uploads/glo-guide/first-post-1.png'));
    // wrap：最後一張再下一張返第一張
    act(() => {
      next!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(statusText(c)).toContain('第 1 張，共 2 張');
    // wrap：第一張上一張去最後一張
    act(() => {
      prev!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(statusText(c)).toContain('第 2 張，共 2 張');
    // 頭版 synopsis 唔受 gallery 切換影響（仍係第一篇）
    expect(stageTitle(c)).toContain('第一篇');
  });

  it('切換頭版文章 → gallery 歸零返嗰篇第一張（期號／單品欄照舊同步）', () => {
    setQuery({ isSuccess: true, data: THREE_ITEMS });
    const c = mountList();
    act(() => {
      c.querySelector<HTMLButtonElement>(
        'button[aria-label="下一張配搭圖"]',
      )!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(statusText(c)).toContain('第 2 張，共 2 張');
    const buttons = indexButtons(c);
    act(() => {
      buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(stageTitle(c)).toContain('第二篇');
    // 歸零：第二篇第一張（第二篇有 3 張，status 即刻反映新總數）
    expect(statusText(c)).toContain('第 1 張，共 3 張');
    expect(
      c.querySelector('[data-active="true"] .ggx-stage-img')?.getAttribute('src'),
    ).toBe(stageSrc('/uploads/glo-guide/second-post-0.png'));
    // 呢期單品欄照舊跟 article selector 同步
    expect(c.querySelector('.ggx-stage-products')?.textContent).toContain('軟皮闊腳褲');
  });

  it('得一篇一張圖：唔出上一張／下一張制', () => {
    setQuery({ isSuccess: true, data: { items: [ITEM(1, 'only-one', '唯一', [], 1)] } });
    const c = mountList();
    expect(c.querySelector('button[aria-label="下一張配搭圖"]')).toBeNull();
    expect(c.querySelector('button[aria-label="上一張配搭圖"]')).toBeNull();
    expect(c.querySelector('.ggx-stage-img')).not.toBeNull();
  });
});

describe('GloGuideList 互動：hero 載入失敗兜底', () => {  it('主視覺 error → 收起因圖，落設計過嘅期刊舞台（無 broken icon）', () => {
    setQuery({ isPending: true });
    const c = mountList();
    const img = c.querySelector<HTMLImageElement>('.ggx-hero-img');
    expect(img?.getAttribute('src')).toBe(GLO_GUIDE_HERO_SRC);
    act(() => {
      img!.dispatchEvent(new Event('error', { bubbles: false }));
    });
    expect(c.querySelector('.ggx-hero-img')).toBeNull();
    const fallback = c.querySelector('.ggx-hero-fallback');
    expect(fallback).not.toBeNull();
    expect(fallback?.getAttribute('role')).toBe('img');
    expect(fallback?.textContent).toContain('Glo Glo');
    expect(fallback?.textContent).toContain('精選配搭指南');
    // masthead card 同 intro 仍然完整
    expect(c.querySelector('.ggx-masthead-card')?.textContent).toContain('Glo Glo 撰寫');
  });
});

describe('GloGuideList 互動：空態 tabs', () => {
  it('click 第二個 tab → aria-selected 換位、panel 切換', () => {
    setQuery({ isSuccess: true, data: { items: [] } });
    const c = mountList();
    const tabs = Array.from(c.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs).toHaveLength(3);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    act(() => {
      tabs[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    const activePanel = c.querySelector<HTMLElement>('#ggx-panel-buy');
    const firstPanel = c.querySelector<HTMLElement>('#ggx-panel-read');
    expect(activePanel?.hasAttribute('hidden')).toBe(false);
    expect(firstPanel?.hasAttribute('hidden')).toBe(true);
    expect(activePanel?.textContent).toContain('商品頁原圖為準');
  });

  it('ArrowRight 喺 tablist 切下一個 tab', () => {
    setQuery({ isSuccess: true, data: { items: [] } });
    const c = mountList();
    const tabs = Array.from(c.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    act(() => {
      tabs[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(c.querySelector('#ggx-panel-buy')?.hasAttribute('hidden')).toBe(false);
  });
});
