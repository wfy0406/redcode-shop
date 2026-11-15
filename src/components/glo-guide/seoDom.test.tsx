// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useGloGuideDetailSeo } from './seo';
import type { GuideDetail } from './types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const DETAIL: GuideDetail = {
  id: 1,
  slug: 'autumn-knit',
  title: '轉季針織咁襯',
  excerpt: '香港轉季三件頭配搭。',
  theme: '轉季 layering',
  publishedAt: '2026-11-14T16:30:00.000Z',
  updatedAt: '2026-11-15T02:00:00.000Z',
  coverImage: null,
  products: [],
  body: '正文',
  images: [],
  modelImage: null,
};

function SeoProbe() {
  useGloGuideDetailSeo(DETAIL);
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  document.head.innerHTML = '';
});

describe('Glo Guide 首口 schema → client hydration', () => {
  it('同 path 只留一份 Article JSON-LD；其他路由 schema 保持不變', () => {
    document.head.innerHTML = `
      <script type="application/ld+json" data-redcode-route-schema="/glo-guide/autumn-knit">{"@type":"Article"}</script>
      <script type="application/ld+json" data-redcode-route-schema="/products">{"@type":"ItemList"}</script>
    `;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<SeoProbe />));

    const current = document.head.querySelectorAll(
      'script[data-redcode-route-schema="/glo-guide/autumn-knit"]',
    );
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute('data-glo-guide-schema')).toBe('article');
    expect(current[0].textContent).toContain('"articleBody":"正文"');
    expect(
      document.head.querySelectorAll('script[data-redcode-route-schema="/products"]'),
    ).toHaveLength(1);
  });
});
