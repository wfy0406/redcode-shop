/**
 * GloGuideList 頁面測試（v2 editorial 雜誌版）：
 *
 * SSR（renderToString，mock trpc）：
 * - published：頭版舞台（ggx-stage）＋ thumbnail index（aria-pressed 預設第一篇）
 *   ＋今期目錄全部真 Link /glo-guide/:slug；香港發文時間 <time dateTime=ISO>
 * - LCP：頭版封面 eager＋fetchPriority=high，thumbnails 全部 lazy
 * - 空態：完整雜誌首頁（/gloglo-3.jpg 授權圖 eager、/products＋/live CTA、
 *   tablist＋aria-selected＋tabpanel）
 * - 載入中（role=status）／錯誤（role=alert＋重試）
 * - 公開措辭：任何狀態都唔准出現「生成」「人工審核」「AI」；必有
 *   「Glo Glo 撰寫」「配搭圖」「商品外觀以商品頁原圖為準」
 *
 * 互動（happy-dom＋createRoot）：
 * - click／focus／hover thumbnail 切換頭版 synopsis；ArrowRight 鍵盤切換
 * - 空態 tabs click／ArrowRight 切換 panel（hidden／aria-selected）
 */

// @vitest-environment happy-dom

import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GloGuideList from './GloGuideList';

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

const ITEM = (id: number, slug: string, title: string) => ({
  id,
  slug,
  title,
  excerpt: `第 ${id} 篇節錄。`,
  theme: `主題${id}`,
  publishedAt: '2026-11-14T16:30:00.000Z',
  updatedAt: '2026-11-15T02:00:00.000Z',
  coverImage: {
    id: id * 10,
    path: `/uploads/glo-guide/${slug}.png`,
    alt: `${title} 封面`,
    width: 800,
    height: 1200,
    position: 0,
    productId: null,
  },
  products: [],
});

const THREE_ITEMS = {
  items: [
    ITEM(1, 'first-post', '第一篇'),
    ITEM(2, 'second-post', '第二篇'),
    ITEM(3, 'third-post', '第三篇'),
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

describe('GloGuideList 內容（published）', () => {
  it('頭版舞台＋thumbnail index（預設第一篇 aria-pressed）＋目錄全部真連結', () => {
    setQuery({ isSuccess: true, data: THREE_ITEMS });
    const html = renderList();
    expect(html).toContain('ggx-stage');
    expect(html).toContain('ggx-index');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain('顯示第 1 篇：第一篇');
    expect(html).toContain('href="/glo-guide/first-post"');
    expect(html).toContain('href="/glo-guide/second-post"');
    expect(html).toContain('href="/glo-guide/third-post"');
    expect(html).toContain('今期目錄');
    expect(html).toContain('2026年11月15日 00:30');
  });

  it('LCP：得頭版封面 eager＋fetchPriority=high，thumbnails 全部 lazy', () => {
    setQuery({ isSuccess: true, data: THREE_ITEMS });
    const html = renderList();
    // React 19 SSR 原樣輸出 fetchPriority="high"；HTML 屬性不分大小寫
    expect(html.match(/loading="eager"/g)).toHaveLength(1);
    expect(html.match(/fetchpriority="high"/gi)).toHaveLength(2); // img 屬性＋React 19 preload link
    expect(html.match(/loading="lazy"/g)).toHaveLength(3);
  });

  it('只有一篇：舞台＋單個 selector＋單行目錄都正常', () => {
    setQuery({ isSuccess: true, data: { items: [ITEM(1, 'only-one', '唯一')] } });
    const html = renderList();
    expect(html).toContain('ggx-stage');
    expect(html.match(/ggx-index-btn/g)?.length).toBeGreaterThan(0);
    expect(html).toContain('href="/glo-guide/only-one"');
  });

  it('公開措辭：有 Glo Glo 撰寫／配搭圖，無禁用字眼', () => {
    setQuery({ isSuccess: true, data: THREE_ITEMS });
    expectPublicWording(renderList());
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

  it('空列表：完整雜誌首頁（授權圖 eager＋CTA＋tabs），無禁用字眼', () => {
    setQuery({ isSuccess: true, data: { items: [] } });
    const html = renderList();
    expect(html).toContain('暫時未有已發布指南');
    expect(html).not.toContain('撰寫中');
    expect(html).toContain('/gloglo-3.jpg');
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
  it('click 第二個 thumbnail → 頭版切到第二篇，aria-pressed 跟住走', () => {
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
