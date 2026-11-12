import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { Product } from '@/data/products';
import ProductCard from './ProductCard';

/**
 * 商品卡「重點標籤」改版測試（2026-11-12）：
 * - 標籤文字原樣保留、順序不變（真資料唔准改字）
 * - 新 pill class（pc-tag）＋逐粒 stagger delay（一次性 cascade）
 * - 貨號／價錢唔會俾標籤頂走（同區照出）
 * - CSS 有 prefers-reduced-motion 停用 guard
 */

vi.mock('@/providers/trpc', () => ({
  trpc: {
    useUtils: () => ({ cart: { list: { invalidate: vi.fn() } } }),
    cart: { add: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) } },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: null }),
}));

const product: Product = {
  id: '261',
  name: '米白立領金屬鈕扣短外套',
  sku: 'B261',
  price: 144,
  category: 'top',
  listedAt: '2026-01-01', // 舊日期：唔觸發 New badge，畫面淨啲
  image: '/product-2.jpg',
  aiTags: ['米白', '立領', '拉鏈', '金屬鈕扣'],
};

function renderCard(p: Product = product) {
  return renderToString(
    <MemoryRouter>
      <ProductCard product={p} />
    </MemoryRouter>,
  );
}

/** 抽出標籤區 HTML（避免標籤字撞商品名等頁面其他位置） */
function tagsBlock(html: string): string {
  const start = html.indexOf('pc-tags');
  const end = html.indexOf('</ul>', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe('ProductCard 重點標籤（內容保留＋新 pill 外觀）', () => {
  it('標籤文字原樣逐個出現，順序同資料一致', () => {
    const block = tagsBlock(renderCard());
    const i0 = block.indexOf('米白');
    const i1 = block.indexOf('立領');
    const i2 = block.indexOf('拉鏈');
    const i3 = block.indexOf('金屬鈕扣');
    expect(i0).toBeGreaterThan(-1);
    expect(i0).toBeLessThan(i1);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
  });

  it('用新 pc-tags/pc-tag class，每粒帶遞增 --pc-tag-delay（55ms stagger）', () => {
    const html = renderCard();
    expect(html).toContain('pc-tags');
    expect(html.match(/class="pc-tag"/g)).toHaveLength(4);
    expect(html).toContain('--pc-tag-delay:0ms');
    expect(html).toContain('--pc-tag-delay:55ms');
    expect(html).toContain('--pc-tag-delay:110ms');
    expect(html).toContain('--pc-tag-delay:165ms');
  });

  it('stagger delay 有上限（第 8 粒起唔再增加，唔會拖到好耐先入）', () => {
    const many: Product = {
      ...product,
      aiTags: ['一', '二', '三', '四', '五', '六', '七', '八', '九'],
    };
    const html = renderCard(many);
    expect(html).toContain('--pc-tag-delay:385ms'); // min(7, i) * 55
    expect(html).not.toContain('--pc-tag-delay:440ms');
  });

  it('貨號同價錢照常顯示（標籤唔會頂走重要內容）', () => {
    const html = renderCard();
    // SSR 會喺文字節點之間插 <!-- -->，分開斷言
    expect(html).toContain('貨號');
    expect(html).toContain('B261');
    expect(html).toContain('HK$144');
  });

  it('冇 aiTags 就唔出標籤區', () => {
    const html = renderCard({ ...product, aiTags: undefined });
    expect(html).not.toContain('pc-tags');
  });
});

describe('product-card.css（motion guard）', () => {
  const css = readFileSync(resolve(__dirname, './product-card.css'), 'utf8');

  it('有一次性 cascade keyframes（唔係循環動畫）', () => {
    expect(css).toContain('@keyframes pc-tag-in');
    expect(css).toMatch(/animation:\s*pc-tag-in 360ms[^;]*both/);
    expect(css).not.toMatch(/pc-tag-in[^;]*infinite/);
  });

  it('prefers-reduced-motion 下停用標籤動畫', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    const guard = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(guard).toContain('.pc-tag');
    expect(guard).toMatch(/animation:\s*none/);
  });
});
