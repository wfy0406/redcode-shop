/**
 * Glo Glo 指南 React 端 SEO：canonical／OG／Article JSON-LD 同 server 首口同一套事實。
 *
 * 背景：SeoManager（src/lib/seo.ts）每次轉頁會先跑一次，佢唔識 /glo-guide，
 * 會畀通用 404 title＋noindex——呢個 hook 喺頁面 effect（行喺 SeoManager 之後）
 * 覆寫返正確值，轉走時 cleanup 還原，唔會留低舊 OG／JSON-LD。
 *
 * JSON-LD 結構跟 api/lib/guideSeo.ts 嘅 Article 模式（author/publisher 指返
 * index.html 嘅 Organization @id，唔重複虛構機構資料），另加 BreadcrumbList
 * 同商品 ItemList；「唔重複 visible server prerender DOM」——呢度只改 <head>。
 */

import { useEffect } from 'react';
import { guideDescription, guidePath } from './guideUtils';
import type { GuideDetail, GuideListItem } from './types';

export const GLO_GUIDE_ORIGIN = 'https://redcode.red';

/** 站內相對路徑 → 絕對 URL（OG 圖／JSON-LD 用絕對，crawler 唔使估 host） */
export function guideAbsUrl(path: string): string {
  return path.startsWith('http') ? path : `${GLO_GUIDE_ORIGIN}${path}`;
}

export const GLO_GUIDE_LIST_SEO = {
  title: 'Glo Glo 精選配搭指南｜RedCode Fashion Design',
  // 主線最終定稿（同 server 首口 gloGuideListRouteMeta 一致）
  description:
    'Glo Glo 按香港天氣同生活場景揀選直播單品，每篇附主題配搭文同 AI 配搭效果圖；商品外觀以商品頁原圖為準。',
} as const;

export function guideDetailTitle(detail: Pick<GuideListItem, 'title'>): string {
  // 同 server 首口 gloGuideDetailRouteMeta 逐字一致
  return `${detail.title}｜Glo Glo 精選配搭指南｜RedCode Fashion Design`;
}

/** 詳情 meta description：同 server 一樣用真 excerpt；空 excerpt 先至用主題組句兜底 */
export function guideDetailDescription(
  detail: Pick<GuideListItem, 'excerpt' | 'theme' | 'title'>,
): string {
  return detail.excerpt.trim() !== '' ? detail.excerpt : guideDescription(detail);
}

export const GLO_GUIDE_NOT_FOUND_SEO = {
  title: '搵唔到呢篇指南｜RedCode Fashion Design',
  description: '呢篇指南可能未發布或已下架，去 Glo Glo 精選配搭指南睇最新文章。',
} as const;

/**
 * 詳情頁 Article JSON-LD：同 server 首口（api/gloGuideSeo.ts）同一結構——
 * Article＋BreadcrumbList，內容全部嚟自公開 DTO；image 只放 cover（server 口徑），
 * published/modified time 用原始 ISO，唔改時區唔改字。
 */
export function buildGuideArticleJsonLd(detail: GuideDetail): Record<string, unknown> {
  const path = guidePath(detail.slug);
  const pageUrl = `${GLO_GUIDE_ORIGIN}${path}`;
  const cover = detail.coverImage;
  const image = cover ? guideAbsUrl(cover.path) : undefined;
  const graph: Record<string, unknown>[] = [
    {
      '@type': 'Article',
      '@id': `${pageUrl}#article`,
      headline: detail.title,
      description: guideDetailDescription(detail),
      ...(image ? { image: [image] } : {}),
      datePublished: detail.publishedAt,
      dateModified: detail.updatedAt,
      inLanguage: 'zh-Hant-HK',
      mainEntityOfPage: pageUrl,
      // author 用真實公開身份 Glo Glo（Person，只標名，唔虛構生平／URL）；
      // publisher 指返 index.html 嘅 Organization @id，唔重複機構資料
      author: { '@type': 'Person', name: 'Glo Glo' },
      publisher: { '@id': `${GLO_GUIDE_ORIGIN}/#org` },
      isPartOf: { '@type': 'WebSite', name: 'RedCode Fashion Design', url: `${GLO_GUIDE_ORIGIN}/` },
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '首頁', item: `${GLO_GUIDE_ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: 'Glo Glo 精選配搭指南', item: `${GLO_GUIDE_ORIGIN}/glo-guide` },
        { '@type': 'ListItem', position: 3, name: detail.title, item: pageUrl },
      ],
    },
  ];
  return { '@context': 'https://schema.org', '@graph': graph };
}

/**
 * JSON-LD → <script> 內容：將 `<` 轉做 <，唔係嘅話文章內容一旦有
 * "</script>" 會截斷 script 標籤（XSS／HTML parse 事故）。JSON 語義不變。
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

type MetaSnapshot = { el: HTMLMetaElement | null; content: string | null };

function setMetaProperty(property: string, content: string, snapshots: MetaSnapshot[]): void {
  let el = document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
  if (snapshots.every((s) => s.el !== el)) {
    snapshots.push({ el, content: el?.getAttribute('content') ?? null });
  }
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute('property', property);
    document.head.appendChild(el);
    snapshots[snapshots.length - 1] = { el, content: null };
  }
  el.setAttribute('content', content);
}

function removeMetaProperty(property: string): void {
  document.querySelectorAll(`meta[property="${property}"]`).forEach((el) => el.remove());
}

const JSON_LD_ATTR = 'data-glo-guide-schema';

function upsertJsonLd(path: string, data: unknown): void {
  document.querySelectorAll<HTMLScriptElement>(`script[${JSON_LD_ATTR}]`).forEach((s) => s.remove());
  const script = document.createElement('script');
  script.type = 'application/ld+json';
  // data-redcode-route-schema：SeoManager 轉頁時會清走唔屬於新路徑嘅 schema
  script.setAttribute('data-redcode-route-schema', path);
  script.setAttribute(JSON_LD_ATTR, 'article');
  script.textContent = serializeJsonLd(data);
  document.head.appendChild(script);
}

function removeJsonLd(): void {
  document.querySelectorAll<HTMLScriptElement>(`script[${JSON_LD_ATTR}]`).forEach((s) => s.remove());
}

function setCanonical(path: string | null): void {
  const existing = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (path === null) {
    existing?.remove();
    ogUrl?.remove();
    return;
  }
  const href = `${GLO_GUIDE_ORIGIN}${path}`;
  const link = existing ?? document.createElement('link');
  link.setAttribute('rel', 'canonical');
  link.setAttribute('href', href);
  if (!existing) document.head.appendChild(link);
  const nextOgUrl = ogUrl ?? document.createElement('meta');
  nextOgUrl.setAttribute('property', 'og:url');
  nextOgUrl.setAttribute('content', href);
  if (!ogUrl) document.head.appendChild(nextOgUrl);
}

function applyCommonHead(opts: {
  title: string;
  description: string;
  indexable: boolean;
  canonicalPath: string | null;
}): void {
  document.title = opts.title;
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute('content', opts.description);
  document
    .querySelector('meta[name="robots"]')
    ?.setAttribute('content', opts.indexable ? 'index, follow' : 'noindex, nofollow');
  setCanonical(opts.canonicalPath);
}

/** 還原 og:* 到進入指南頁之前嘅值（index.html 預設或上一頁 server 注入） */
function restoreMetaSnapshots(snapshots: MetaSnapshot[]): void {
  for (const snap of snapshots) {
    if (snap.el === null) continue;
    if (snap.content === null) snap.el.remove();
    else snap.el.setAttribute('content', snap.content);
  }
}

/** 列表頁 SEO：static title/description/canonical/OG；唔放 JSON-LD（首口由 server 出）。 */
export function useGloGuideListSeo(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const snapshots: MetaSnapshot[] = [];
    applyCommonHead({
      title: GLO_GUIDE_LIST_SEO.title,
      description: GLO_GUIDE_LIST_SEO.description,
      indexable: true,
      canonicalPath: '/glo-guide',
    });
    setMetaProperty('og:type', 'website', snapshots);
    setMetaProperty('og:title', GLO_GUIDE_LIST_SEO.title, snapshots);
    setMetaProperty('og:description', GLO_GUIDE_LIST_SEO.description, snapshots);
    return () => {
      restoreMetaSnapshots(snapshots);
    };
  }, []);
}

/**
 * 詳情頁 SEO：
 * - undefined（載入中）→ 唔郁，等 SeoManager 過渡版（同 ProductDetail 做法一致）；
 * - null（NOT_FOUND）→ noindex＋清 canonical（draft/pending/rejected server 都係 404）；
 * - GuideDetail → title/description/index/canonical/OG article/JSON-LD。
 */
export function useGloGuideDetailSeo(detail: GuideDetail | null | undefined): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (detail === undefined) return;
    const snapshots: MetaSnapshot[] = [];
    if (detail === null) {
      applyCommonHead({
        title: GLO_GUIDE_NOT_FOUND_SEO.title,
        description: GLO_GUIDE_NOT_FOUND_SEO.description,
        indexable: false,
        canonicalPath: null,
      });
      return () => restoreMetaSnapshots(snapshots);
    }
    const path = guidePath(detail.slug);
    const description = guideDetailDescription(detail);
    applyCommonHead({
      title: guideDetailTitle(detail),
      description,
      indexable: true,
      canonicalPath: path,
    });
    // og:image 同 server 口徑：只用 coverImage，唔好用相集第一張頂替
    const cover = detail.coverImage;
    setMetaProperty('og:type', 'article', snapshots);
    setMetaProperty('og:title', guideDetailTitle(detail), snapshots);
    setMetaProperty('og:description', description, snapshots);
    if (cover) setMetaProperty('og:image', guideAbsUrl(cover.path), snapshots);
    setMetaProperty('article:published_time', detail.publishedAt, snapshots);
    setMetaProperty('article:modified_time', detail.updatedAt, snapshots);
    upsertJsonLd(path, buildGuideArticleJsonLd(detail));
    return () => {
      restoreMetaSnapshots(snapshots);
      removeMetaProperty('article:published_time');
      removeMetaProperty('article:modified_time');
      removeJsonLd();
    };
    // 換文章（slug 變）或資料刷新都重跑；同一 detail 物件嘅 effect 係冪等嘅
  }, [detail]);
}
