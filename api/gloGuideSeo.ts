/**
 * Glo Glo 指南——首口 SEO（SPEC v1「SEO／GEO 加強」必修）：
 * /glo-guide 及 /glo-guide/:slug 嘅首口 HTML 直接含完整可讀文章、發文日期（香港時間）、
 * Glo Glo 署名、商品真名／真實價錢／重點標籤、圖片 URL、canonical、OG、Article JSON-LD。
 * 未 published 唔會入到呢度（vite.ts 先攞 data；null → 真 404/noindex）。
 * 資料來源同公開 tRPC 一致（gloGuidePublic 嘅 published 查詢＋DTO），唔准虛構。
 * 純字串操作；注入失敗只回原 HTML，絕對唔阻正常出頁。React mount 後由 App 移除
 * data-redcode-prerender 區塊（同其他首口注入一致，唔會重複 visible DOM）。
 */
import type { GuideDetail, GuideImage, GuideListItem } from "@contracts/gloGuide";
import {
  gloGuideRichTextPlain,
  parseGloGuideRichText,
  renderGloGuideBodyHtml,
} from "@contracts/gloGuideRichText";
import type { RouteMeta } from "./lib/og";
import { productCategoryLabel } from "@contracts/types";
import { isGloGuideImagePath } from "./gloGuideValidation";
import {
  GLO_GUIDE_SOCIAL_IMAGE_HEIGHT,
  GLO_GUIDE_SOCIAL_IMAGE_WIDTH,
  gloGuideSocialImagePath,
} from "./gloGuideSocialImage";

const ORIGIN = "https://redcode.red";
export const GLO_GUIDE_INDEX_PATH = "/glo-guide";
export const gloGuidePath = (slug: string) => `/glo-guide/${slug}`;

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 網站相對路徑 → 絕對 URL（OG／JSON-LD／首口圖片都用絕對） */
function absUrl(path: string): string {
  return path.startsWith("http") ? path : `${ORIGIN}${path}`;
}

/** 發文日期香港時間顯示（YYYY-MM-DD HH:mm） */
export function hkDateTimeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** /glo-guide 總覽 meta */
export function gloGuideListRouteMeta(): RouteMeta {
  return {
    title: "Glo Glo 精選配搭指南｜RedCode Fashion Design",
    description:
      "Glo Glo 按香港天氣同生活場景撰寫配搭指南，每篇附主題配搭文、重點標籤同配搭圖；商品外觀以商品頁原圖為準。",
    path: GLO_GUIDE_INDEX_PATH,
    ogType: "website",
  };
}

/** SEO／GEO 字詞全部來自可見正文重點、主題、真商品名及已批准商品標籤。 */
export function gloGuideSeoKeywords(detail: GuideDetail): string[] {
  return [
    ...new Set(
      [
        detail.theme,
        ...parseGloGuideRichText(detail.body).highlights,
        ...detail.products.flatMap((product) => [product.name, ...product.aiTags]),
      ]
        .map((term) => term.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  ];
}

/** /glo-guide/:slug meta＋Article JSON-LD（同可見文章一致嘅真內容） */
export function gloGuideDetailRouteMeta(detail: GuideDetail): RouteMeta {
  const pageUrl = `${ORIGIN}${gloGuidePath(detail.slug)}`;
  const image = detail.coverImage ? absUrl(detail.coverImage.path) : undefined;
  const socialImage = `${ORIGIN}${gloGuideSocialImagePath(detail.slug)}`;
  const keywords = gloGuideSeoKeywords(detail);
  const graph: Record<string, unknown>[] = [
    {
      "@type": "Article",
      "@id": `${pageUrl}#article`,
      headline: detail.title,
      description: detail.excerpt,
      articleBody: gloGuideRichTextPlain(detail.body),
      ...(keywords.length ? { keywords: keywords.join(", ") } : {}),
      about: detail.products.map((product) => ({
        "@type": "Product",
        name: product.name,
        url: `${ORIGIN}/products/${product.id}`,
        image: absUrl(product.image),
        category: productCategoryLabel(product.category),
        ...(product.aiTags.length ? { keywords: product.aiTags.join(", ") } : {}),
      })),
      isAccessibleForFree: true,
      ...(image ? { image: [image] } : {}),
      datePublished: detail.publishedAt,
      dateModified: detail.updatedAt,
      inLanguage: "zh-Hant-HK",
      mainEntityOfPage: pageUrl,
      author: { "@type": "Person", name: "Glo Glo" },
      publisher: { "@id": `${ORIGIN}/#org` },
      isPartOf: { "@type": "WebSite", name: "RedCode Fashion Design", url: `${ORIGIN}/` },
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "首頁", item: `${ORIGIN}/` },
        { "@type": "ListItem", position: 2, name: "Glo Glo 精選配搭指南", item: `${ORIGIN}${GLO_GUIDE_INDEX_PATH}` },
        { "@type": "ListItem", position: 3, name: detail.title, item: pageUrl },
      ],
    },
  ];
  return {
    title: `${detail.title}｜Glo Glo 精選配搭指南｜RedCode Fashion Design`,
    description: detail.excerpt,
    path: gloGuidePath(detail.slug),
    image: socialImage,
    imageWidth: GLO_GUIDE_SOCIAL_IMAGE_WIDTH,
    imageHeight: GLO_GUIDE_SOCIAL_IMAGE_HEIGHT,
    imageAlt: `${detail.title}｜Glo Glo 精選指南分享預覽圖`,
    ogType: "article",
    articlePublishedTime: detail.publishedAt,
    articleModifiedTime: detail.updatedAt,
    structuredData: { "@context": "https://schema.org", "@graph": graph },
  };
}

/** 總覽首口：全部已發布指南真連結（標題＋主題＋日期＋摘要） */
export function renderGloGuideIndex(items: readonly GuideListItem[]): string {
  const rows = items
    .map((item, index) => {
      const products = item.products
        .map((p) => `<li><a href="/products/${p.id}">${esc(p.name)}</a>｜HK$${p.discountPrice != null && p.discountPrice < p.price ? p.discountPrice : p.price}</li>`)
        .join("");
      return (
        `<li><article><a href="${esc(gloGuidePath(item.slug))}"><h2>${esc(item.title)}</h2></a>` +
        (item.coverImage ? renderImage(item.coverImage, index === 0) : "") +
        `<p>${esc(item.theme)}｜${esc(hkDateTimeLabel(item.publishedAt))}</p>` +
        `<p>${esc(item.excerpt)}</p>` +
        (products ? `<p>文中商品：</p><ul>${products}</ul>` : "") +
        `</article></li>`
      );
    })
    .join("");
  return (
    `<main id="redcode-glo-guide-seo" data-redcode-prerender style="max-width:56rem;margin:0 auto;padding:4rem 1.5rem;color:#fff;background:#0a0614;line-height:1.8">` +
    `<h1>Glo Glo 精選配搭指南</h1>` +
    `<p>Glo Glo 撰寫每週直播新品配搭靈感，附重點標籤同配搭圖；商品外觀以商品原圖為準。</p>` +
    (items.length > 0 ? `<ul>${rows}</ul>` : `<p>Glo Glo 最新撰寫嘅指南刊登後會喺呢度見到，不妨先去睇最新直播商品。</p>`) +
    `<nav aria-label="相關頁面"><ul><li><a href="/products">全部貨品</a></li><li><a href="/">首頁</a></li></ul></nav>` +
    `</main>`
  );
}

function renderImage(img: GuideImage, eager = false): string {
  // 防禦性收口：就算上游 DTO 日後改壞，都唔會將任意外鏈當已批准指南圖輸出。
  if (!isGloGuideImagePath(img.path)) return "";
  const dims =
    img.width > 0 && img.height > 0 ? ` width="${img.width}" height="${img.height}"` : "";
  // 首圖（cover）係 LCP 候選：唔准 lazy；其餘 lazy
  const loading = eager ? ` fetchpriority="high"` : ` loading="lazy"`;
  return `<figure><img src="${esc(absUrl(img.path))}" alt="${esc(img.alt)}"${dims}${loading} decoding="async" /></figure>`;
}

/** 詳情首口：完整文章＋Glo Glo 署名＋香港發文時間＋3–5 配搭圖＋真商品卡。
 *  商品外觀以商品原圖為準；cover eager 載入，gallery 唔重複 cover。 */
export function renderGloGuideDetail(detail: GuideDetail): string {
  const paragraphs = renderGloGuideBodyHtml(detail.body);
  const coverId = detail.coverImage?.id ?? null;
  const galleryImages = detail.images.filter((img) => img.id !== coverId);
  const gallery = galleryImages.map((img) => renderImage(img)).join("");
  const productCards = detail.products
    .map((p) => {
      const price =
        p.discountPrice != null && p.discountPrice < p.price
          ? `<s>HK$${p.price}</s> HK$${p.discountPrice}`
          : `HK$${p.price}`;
      const live = p.liveDate
        ? `直播場次：${p.liveDate}${p.liveSession ? ` 第 ${p.liveSession} 場` : ""}｜`
        : "";
      return (
        `<li><a href="/products/${p.id}">` +
        `<img src="${esc(absUrl(p.image))}" alt="${esc(p.name)}" width="240" height="320" loading="lazy" decoding="async" />` +
        `<strong>${esc(p.name)}</strong></a>` +
        `<p>${esc(productCategoryLabel(p.category))}｜${live}${p.stock > 0 ? "有貨" : "暫時缺貨"}</p>` +
        `<p>${price}</p>` +
        (p.aiTags.length ? `<p>重點：${esc(p.aiTags.join("、"))}</p>` : "") +
        `</li>`
      );
    })
    .join("");
  return (
    `<main id="redcode-glo-guide-seo" data-redcode-prerender style="max-width:56rem;margin:0 auto;padding:4rem 1.5rem;color:#fff;background:#0a0614;line-height:1.8">` +
    `<article>` +
    `<h1>${esc(detail.title)}</h1>` +
    `<p>主題：${esc(detail.theme)}</p>` +
    `<p>Glo Glo 撰寫｜發文時間（香港）：${esc(hkDateTimeLabel(detail.publishedAt))}</p>` +
    (detail.coverImage ? renderImage(detail.coverImage, true) : "") +
    paragraphs +
    (gallery
      ? `<section><h2>配搭相集</h2><p>配搭圖只供配搭參考；商品外觀以商品原圖為準。</p>${gallery}</section>`
      : "") +
    (productCards
      ? `<section><h2>呢篇用嘅商品</h2><p>品名、價錢同庫存以商品頁為準。</p><ul>${productCards}</ul></section>`
      : "") +
    `<nav aria-label="相關頁面"><ul><li><a href="${GLO_GUIDE_INDEX_PATH}">全部配搭指南</a></li><li><a href="/products">全部貨品</a></li></ul></nav>` +
    `</article></main>`
  );
}

/** 注入失敗只係回原 HTML；同一頁唔會重複注入。 */
export function injectGloGuideContent(html: string, block: string): string {
  try {
    if (!block || html.includes('id="redcode-glo-guide-seo"')) return html;
    // JS 可用時喺首次繪畫前收起無 JS／crawler fallback，避免 React mount 移除區塊造成 CLS；
    // 停用 JS 時 script 唔會執行，完整公開內容仍然可見、可讀、可索引。
    const prerenderBoot =
      '<script>(function(){var nodes=document.querySelectorAll(\'#redcode-glo-guide-seo[data-redcode-prerender]\');for(var i=0;i<nodes.length;i++){nodes[i].style.display=\'none\';}})();</script>';
    return html.replace("</body>", `    ${block}\n    ${prerenderBoot}\n  </body>`);
  } catch {
    return html;
  }
}
