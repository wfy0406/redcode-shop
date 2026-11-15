/**
 * Glo Glo 指南 SEO 純邏輯測試：Article JSON-LD 結構、絕對 URL、
 * published/modified time 原樣透傳、商品 ItemList，同最重要嘅
 * `<script>` escaping（文章內容有 "</script>" 都唔會截斷標籤）。
 */

import { describe, expect, it } from 'vitest';
import {
  buildGuideArticleJsonLd,
  guideAbsUrl,
  guideDetailDescription,
  guideDetailTitle,
  GLO_GUIDE_LIST_SEO,
  GLO_GUIDE_NOT_FOUND_SEO,
  GLO_GUIDE_ORIGIN,
  serializeJsonLd,
} from './seo';
import type { GuideDetail } from './types';

function detail(partial: Partial<GuideDetail>): GuideDetail {
  return {
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
    ...partial,
  };
}

const IMG = {
  id: 1,
  path: '/uploads/glo-guide/a.png',
  alt: '實著相',
  width: 800,
  height: 1200,
  position: 0,
  productId: 1,
};

describe('buildGuideArticleJsonLd', () => {
  it('Article＋BreadcrumbList，同 server 首口（api/gloGuideSeo.ts）同一結構', () => {
    const data = buildGuideArticleJsonLd(
      detail({
        coverImage: IMG,
        products: [
          { id: 1, name: '甲' } as never,
          { id: 2, name: '乙' } as never,
        ],
      }),
    ) as { '@context': string; '@graph': Array<Record<string, unknown>> };
    expect(data['@context']).toBe('https://schema.org');
    const types = data['@graph'].map((n) => n['@type']);
    expect(types).toEqual(['Article', 'BreadcrumbList']);
    const article = data['@graph'][0];
    expect(article.headline).toBe('轉季針織咁襯');
    expect(article.description).toBe('香港轉季三件頭配搭。');
    expect(article.datePublished).toBe('2026-11-14T16:30:00.000Z');
    expect(article.dateModified).toBe('2026-11-15T02:00:00.000Z');
    expect(article.inLanguage).toBe('zh-Hant-HK');
    expect(article.mainEntityOfPage).toBe(`${GLO_GUIDE_ORIGIN}/glo-guide/autumn-knit`);
    expect(article.image).toEqual([`${GLO_GUIDE_ORIGIN}/uploads/glo-guide/a.png`]);
    expect(article.author).toEqual({ '@type': 'Person', name: 'Glo Glo' });
    expect(article.publisher).toEqual({ '@id': `${GLO_GUIDE_ORIGIN}/#org` });
  });

  it('image 口徑同 server：只放 coverImage；冇 cover 就唔出 image 欄', () => {
    const noCover = buildGuideArticleJsonLd(detail({ images: [IMG] })) as {
      '@graph': Array<Record<string, unknown>>;
    };
    expect('image' in noCover['@graph'][0]).toBe(false);
    const withCover = buildGuideArticleJsonLd(detail({ coverImage: IMG })) as {
      '@graph': Array<Record<string, unknown>>;
    };
    expect(withCover['@graph'][0].image).toEqual([`${GLO_GUIDE_ORIGIN}/uploads/glo-guide/a.png`]);
  });
});

describe('serializeJsonLd escaping', () => {
  it('文章內容有 "</script>" 會被 escape，唔會截斷 script 標籤', () => {
    const malicious = detail({ title: 'X</script><script>alert(1)</script>' });
    const text = serializeJsonLd(buildGuideArticleJsonLd(malicious));
    expect(text).not.toContain('</script>');
    expect(text).toContain('\\u003c/script>');
    // 語義不變：parse 返係原字串
    expect(JSON.parse(text)).toEqual(buildGuideArticleJsonLd(malicious));
  });

  it('HTML 敏感字元 < & 全部唔會以原文出現喺 < 開頭嘅標籤位置', () => {
    const text = serializeJsonLd({ a: '<b>&amp;</b>' });
    expect(text).toBe('{"a":"\\u003cb>&amp;</b>"}'.replace('</b>', '\\u003c/b>'));
  });
});

describe('URL／標題常數', () => {
  it('guideAbsUrl：站內相對路徑補 origin；http(s) 原樣', () => {
    expect(guideAbsUrl('/uploads/glo-guide/a.png')).toBe(
      'https://redcode.red/uploads/glo-guide/a.png',
    );
    expect(guideAbsUrl('https://cdn.example.com/x.png')).toBe('https://cdn.example.com/x.png');
  });

  it('詳情 title 同 server「Glo Glo 精選配搭指南」後綴逐字一致', () => {
    expect(guideDetailTitle(detail({}))).toBe(
      '轉季針織咁襯｜Glo Glo 精選配搭指南｜RedCode Fashion Design',
    );
  });

  it('詳情 description 同 server 口徑：excerpt 原文（唔 trim）；空 excerpt 先兜底', () => {
    expect(guideDetailDescription(detail({ excerpt: ' 有料 excerpt ' }))).toBe(' 有料 excerpt ');
    expect(guideDetailDescription(detail({}))).toBe('香港轉季三件頭配搭。');
    expect(guideDetailDescription(detail({ excerpt: '  ' }))).toContain('轉季 layering');
  });

  it('列表／404 SEO 文案存在且非空', () => {
    expect(GLO_GUIDE_LIST_SEO.title).toBe('Glo Glo 精選配搭指南｜RedCode Fashion Design');
    // 主線最終定稿（同 server 首口列表 description 逐字一致）
    expect(GLO_GUIDE_LIST_SEO.description).toBe(
      'Glo Glo 按香港天氣同生活場景揀選直播單品，每篇附主題配搭文同 AI 配搭效果圖；商品外觀以商品頁原圖為準。',
    );
    expect(GLO_GUIDE_NOT_FOUND_SEO.title).toContain('搵唔到');
  });
});
