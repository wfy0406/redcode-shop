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
import type { RouteMeta } from "./lib/og";
import { productCategoryLabel } from "@contracts/types";
import { getDb } from "./queries/connection";
import { gloGuideArticles } from "@db/schema";
import { desc, eq } from "drizzle-orm";

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

/** sitemap 用：/glo-guide ＋ 全部 published 指南 URL（只呢個函數掂 DB） */
export async function gloGuideSitemapPaths(): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ slug: gloGuideArticles.slug })
    .from(gloGuideArticles)
    .where(eq(gloGuideArticles.status, "published"))
    .orderBy(desc(gloGuideArticles.publishedAt))
    .limit(200);
  return [GLO_GUIDE_INDEX_PATH, ...rows.map((r) => gloGuidePath(r.slug))];
}

/** /glo-guide 總覽 meta */
export function gloGuideListRouteMeta(): RouteMeta {
  return {
    title: "Glo Glo 精選配搭指南｜RedCode Fashion Design",
    description:
      "Glo Glo 按香港天氣同生活場景揀選直播單品，每篇附主題配搭文同 AI 配搭效果圖；商品外觀以商品頁原圖為準。",
    path: GLO_GUIDE_INDEX_PATH,
  };
}

/** /glo-guide/:slug meta＋Article JSON-LD（同可見文章一致嘅真內容） */
export function gloGuideDetailRouteMeta(detail: GuideDetail): RouteMeta {
  const pageUrl = `${ORIGIN}${gloGuidePath(detail.slug)}`;
  const image = detail.coverImage ? absUrl(detail.coverImage.path) : undefined;
  const graph: Record<string, unknown>[] = [
    {
      "@type": "Article",
      "@id": `${pageUrl}#article`,
      headline: detail.title,
      description: detail.excerpt,
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
    image,
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
    `<p>Glo Glo 每週精選直播新品配搭靈感；配搭圖係 AI 效果圖，商品外觀以商品原圖為準。</p>` +
    (items.length > 0 ? `<ul>${rows}</ul>` : `<p>暫時未有已發布指南，唔該遲啲再嚟睇。</p>`) +
    `<nav aria-label="相關頁面"><ul><li><a href="/products">全部貨品</a></li><li><a href="/">首頁</a></li></ul></nav>` +
    `</main>`
  );
}

function renderImage(img: GuideImage, eager = false): string {
  const dims =
    img.width > 0 && img.height > 0 ? ` width="${img.width}" height="${img.height}"` : "";
  // 首圖（cover）係 LCP 候選：唔准 lazy；其餘 lazy
  const loading = eager ? ` fetchpriority="high"` : ` loading="lazy"`;
  return `<figure><img src="${esc(absUrl(img.path))}" alt="${esc(img.alt)}"${dims}${loading} decoding="async" /></figure>`;
}

/** 詳情首口：完整文章＋Glo Glo 署名＋香港發文時間＋3–5 相集＋真商品卡（名／價／標籤／場次）。
 *  相集註明係 AI 配搭效果圖（唔扮實拍）；cover eager 載入，gallery 唔重複 cover。 */
export function renderGloGuideDetail(detail: GuideDetail): string {
  const paragraphs = detail.body
    .split(/\n{2,}|\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join("");
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
    `<p>Glo Glo｜發文時間（香港）：${esc(hkDateTimeLabel(detail.publishedAt))}</p>` +
    (detail.coverImage ? renderImage(detail.coverImage, true) : "") +
    paragraphs +
    (gallery
      ? `<section><h2>配搭相集</h2><p>相集係 AI 配搭效果圖；商品外觀以商品原圖為準。</p>${gallery}</section>`
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
    return html.replace("</body>", `    ${block}\n  </body>`);
  } catch {
    return html;
  }
}
