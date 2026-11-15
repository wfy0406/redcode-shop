/**
 * GloGuideList 頁面 render 測試（renderToString，mock trpc）：
 * - 頭版非對稱 split（第一篇 featured）＋其餘 masonry；連結去 /glo-guide/:slug
 * - LCP：頭版封面 eager＋fetchPriority=high，其餘 lazy
 * - 香港發文時間 <time dateTime=ISO>
 * - 載入中（role=status）／錯誤（role=alert＋重試）／空狀態
 */

import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import GloGuideList from './GloGuideList';

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

describe('GloGuideList 內容', () => {
  it('多篇：第一篇 featured＋其餘入 masonry，全部有真連結', () => {
    setQuery({
      isSuccess: true,
      data: { items: [ITEM(1, 'first-post', '第一篇'), ITEM(2, 'second-post', '第二篇'), ITEM(3, 'third-post', '第三篇')] },
    });
    const html = renderList();
    expect(html).toContain('gg-featured');
    expect(html).toContain('gg-masonry');
    expect(html).toContain('href="/glo-guide/first-post"');
    expect(html).toContain('href="/glo-guide/second-post"');
    expect(html).toContain('href="/glo-guide/third-post"');
    expect(html).toContain('2026年11月15日 00:30');
  });

  it('LCP：得頭版封面 eager＋fetchPriority=high，其他 lazy', () => {
    setQuery({
      isSuccess: true,
      data: { items: [ITEM(1, 'first-post', '第一篇'), ITEM(2, 'second-post', '第二篇')] },
    });
    const html = renderList();
    // React 19 SSR 原樣輸出 fetchPriority="high"；HTML 屬性不分大小寫
    expect(html.match(/loading="eager"/g)).toHaveLength(1);
    expect(html.match(/fetchpriority="high"/gi)).toHaveLength(2); // img 屬性＋React 19 preload link
    expect(html.match(/loading="lazy"/g)).toHaveLength(1);
  });

  it('只有一篇 → 冇 masonry 區', () => {
    setQuery({ isSuccess: true, data: { items: [ITEM(1, 'only-one', '唯一')] } });
    const html = renderList();
    expect(html).toContain('gg-featured');
    expect(html).not.toContain('gg-masonry');
  });
});

describe('GloGuideList 狀態', () => {
  it('載入中 role=status', () => {
    setQuery({ isPending: true });
    const html = renderList();
    expect(html).toContain('role="status"');
  });

  it('錯誤 role=alert＋重新載入按鈕', () => {
    setQuery({ isError: true, error: { message: 'network' } });
    const html = renderList();
    expect(html).toContain('role="alert"');
    expect(html).toContain('重新載入');
  });

  it('空列表 → 空狀態＋去全部貨品真連結', () => {
    setQuery({ isSuccess: true, data: { items: [] } });
    const html = renderList();
    expect(html).toContain('暫時未有已發布指南');
    expect(html).not.toContain('撰寫中');
    expect(html).toContain('href="/products"');
  });
});
