/**
 * Glo Glo 指南——sitemap／RSS syndication 純 helper（唔掂 HTTP、唔掂路由）。
 *
 * 資料來源：只用 api/gloGuidePublic.ts 嘅公開 published 查詢
 * （listPublishedGuides / getPublishedGuideBySlug）＋ contracts/gloGuide.ts DTO；
 * helper 本身冇任何 status 繞道，非 published 永遠入唔到 feed。
 *
 * 安全規矩：
 * ─ canonical origin 寫死 https://redcode.red；path 白名單式校驗（必須單個 / 開頭、
 *   唔准 //、控制字元、空白、反斜線），絕對唔反射任憑意外部 URL；
 * ─ XML 五字元 escape（& < > " '）；content:encoded 用 CDATA 並安全拆開 ]]>
 * ─ lastmod 只輸出合法日期；無效日期直接唔出，唔會放假日期；
 * ─ 圖片只用 DTO 已提供嘅站內公開圖，唔會自己查未批資產。
 */
import type { GuideDetail, GuideImage, GuideListItem, GuideProduct } from "@contracts/gloGuide";
import { getPublishedGuideBySlug, listPublishedGuides } from "./gloGuidePublic";
import { GLO_GUIDE_INDEX_PATH, gloGuidePath } from "./gloGuideSeo";

/** 全站唯一 canonical origin */
export const REDCODE_ORIGIN = "https://redcode.red";
/** RSS feed 固定路徑 */
export const GLO_GUIDE_FEED_PATH = "/glo-guide/feed.xml";

/** AI 效果圖披露（必填；唔准用真人實穿字眼） */
export const AI_IMAGE_DISCLOSURE = "配搭圖係 AI 配搭效果圖；商品外觀以商品原圖為準。";

/** XML escape：& 一定要最先 */
export function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 站內 path → canonical 絕對 URL；唔合法就回 null（調用方要略過，唔好照出）。
 * 白名單式：必須單個 `/` 開頭；拒絕 `//`（protocol-relative）、控制字元、
 * 空白、反斜線——任何外部 URL／scheme 都唔可能過到。
 */
export function toCanonicalUrl(path: string): string | null {
  if (typeof path !== "string" || path.length === 0) return null;
  if (!path.startsWith("/") || path.includes("//")) return null;
  // 控制字元（含 \x00-\x1F、\x7F）、所有空白、反斜線一律拒絕
  if (/[\x00-\x20\x7F\\]/.test(path)) return null;
  return `${REDCODE_ORIGIN}${path}`;
}

/** lastmod 只出真日期：parse 唔到就回 null（唔輸出假日期） */
export function validLastmod(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString();
}

// ────────────────────────────── sitemap ──────────────────────────────

export interface SitemapUrlEntry {
  /** 站內 path（會經 toCanonicalUrl 白名單校驗，唔合法成條略過） */
  path: string;
  /** ISO 日期字串；無效會當冇 lastmod */
  lastmod?: string | null;
  changefreq?: string;
  priority?: number;
}

const CHANGEFREQ_VALUES = new Set([
  "always",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "never",
]);

function renderUrlEntry(entry: SitemapUrlEntry): string | null {
  const loc = toCanonicalUrl(entry.path);
  if (!loc) return null;
  let inner = `<loc>${escapeXml(loc)}</loc>`;
  const lastmod = validLastmod(entry.lastmod);
  if (lastmod) inner += `<lastmod>${lastmod}</lastmod>`;
  if (entry.changefreq && CHANGEFREQ_VALUES.has(entry.changefreq)) {
    inner += `<changefreq>${entry.changefreq}</changefreq>`;
  }
  if (typeof entry.priority === "number" && Number.isFinite(entry.priority)) {
    const clamped = Math.min(Math.max(entry.priority, 0), 1);
    inner += `<priority>${clamped.toFixed(1)}</priority>`;
  }
  return `<url>${inner}</url>`;
}

/** urlset renderer：非法 path 略過、按 loc 去重；永遠唔反射外部 URL */
export function renderSitemapUrlset(entries: readonly SitemapUrlEntry[]): string {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const entry of entries) {
    const loc = toCanonicalUrl(entry.path);
    if (!loc || seen.has(loc)) continue;
    seen.add(loc);
    const rendered = renderUrlEntry(entry);
    if (rendered) urls.push(rendered);
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    (urls.length ? `  ${urls.join("\n  ")}\n` : "") +
    `</urlset>`
  );
}

/** sitemap index renderer：同 urlset 一套 path／lastmod 規矩 */
export function renderSitemapIndex(
  sitemaps: readonly { path: string; lastmod?: string | null }[],
): string {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const s of sitemaps) {
    const loc = toCanonicalUrl(s.path);
    if (!loc || seen.has(loc)) continue;
    seen.add(loc);
    const lastmod = validLastmod(s.lastmod);
    rows.push(
      `<sitemap><loc>${escapeXml(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</sitemap>`,
    );
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    (rows.length ? `  ${rows.join("\n  ")}\n` : "") +
    `</sitemapindex>`
  );
}

/** Glo Guide sitemap entries：總覽＋每篇 published 指南；lastmod 用真 updatedAt */
export function gloGuideSitemapEntries(
  items: readonly Pick<GuideListItem, "slug" | "updatedAt">[],
): SitemapUrlEntry[] {
  return [
    { path: GLO_GUIDE_INDEX_PATH, changefreq: "weekly", priority: 0.6 },
    ...items.map((item) => ({
      path: gloGuidePath(item.slug),
      lastmod: item.updatedAt,
      changefreq: "weekly" as const,
      priority: 0.6,
    })),
  ];
}

// ────────────────────────────── RSS 2.0 ──────────────────────────────

export interface GuideFeedDeps {
  /** 預設用真公開查詢；測試可注入假實作，完全唔掂 DB */
  listPublished?: (limit: number) => Promise<GuideListItem[]>;
  getBySlug?: (slug: string) => Promise<GuideDetail | null>;
}

/**
 * /glo-guide/feed.xml 資料：先攞 published 公開列表，再逐篇用公開 bySlug 詳情。
 * 任何一篇中途變非 published（bySlug 回 null）就略過，絕對唔 leak。
 * limit clamp 1..50，預設 20。
 */
export async function loadPublishedGuideFeed(limit = 20, deps: GuideFeedDeps = {}): Promise<GuideDetail[]> {
  const list = deps.listPublished ?? listPublishedGuides;
  const bySlug = deps.getBySlug ?? getPublishedGuideBySlug;
  const n = Number.isFinite(limit) ? Math.trunc(limit) : 20;
  const clamped = Math.min(Math.max(n, 1), 50);
  const items = await list(clamped);
  const details: GuideDetail[] = [];
  for (const item of items) {
    const detail = await bySlug(item.slug);
    // 中途被撤回／改狀態 → null → 略過
    if (detail) details.push(detail);
  }
  return details;
}

/** CDATA 安全封裝：內容入面嘅 ]]> 拆開，唔會提早終止 CDATA */
export function cdata(value: string): string {
  return `<![CDATA[${String(value).replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function rfc822(iso: string | null | undefined): string | null {
  const time = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(time)) return null;
  return new Date(time).toUTCString();
}

function productPriceLabel(p: GuideProduct): string {
  return p.discountPrice != null && p.discountPrice < p.price
    ? `HK$${p.discountPrice}（原價 HK$${p.price}）`
    : `HK$${p.price}`;
}

/** content:encoded 入面嘅 HTML：完整 body＋全部公開圖＋商品卡＋AI 披露；user text 全 escape */
function renderItemContent(detail: GuideDetail): string {
  const paragraphs = detail.body
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeXml(p)}</p>`)
    .join("");
  // 只用 DTO 已提供嘅公開圖；path 過唔到站內白名單就略過（唔反射外部 URL）
  const figures = detail.images
    .map((img: GuideImage) => {
      const src = toCanonicalUrl(img.path);
      if (!src) return "";
      const dims = img.width > 0 && img.height > 0 ? ` width="${img.width}" height="${img.height}"` : "";
      return `<figure><img src="${escapeXml(src)}" alt="${escapeXml(img.alt)}"${dims} /></figure>`;
    })
    .filter(Boolean)
    .join("");
  const productItems = detail.products
    .map((p) => {
      const href = toCanonicalUrl(`/products/${p.id}`);
      if (!href) return "";
      return (
        `<li><a href="${escapeXml(href)}">${escapeXml(p.name)}</a>` +
        `（${escapeXml(productPriceLabel(p))}）</li>`
      );
    })
    .filter(Boolean)
    .join("");
  return (
    `<p><strong>${escapeXml(AI_IMAGE_DISCLOSURE)}</strong></p>` +
    paragraphs +
    (figures ? `<section><h2>配搭相集</h2>${figures}</section>` : "") +
    (productItems
      ? `<section><h2>呢篇用嘅商品</h2><p>品名、價錢同庫存以商品頁為準。</p><ul>${productItems}</ul></section>`
      : "")
  );
}

/**
 * RSS 2.0 renderer（/glo-guide/feed.xml）：channel 有 title/link/description/
 * language/atom:self/lastBuildDate；item 有真 title、link、guid isPermaLink、
 * pubDate、dc:creator Glo Glo、description=excerpt、content:encoded 全文。
 * 只食已公開 GuideDetail；空列表照出合法空 channel。
 */
export function renderGloGuideRss(
  details: readonly GuideDetail[],
  opts: { now?: Date } = {},
): string {
  const now = opts.now ?? new Date();
  const feedUrl = toCanonicalUrl(GLO_GUIDE_FEED_PATH) as string;
  const channelLink = toCanonicalUrl(GLO_GUIDE_INDEX_PATH) as string;
  const items = details
    .map((detail) => {
      const link = toCanonicalUrl(gloGuidePath(detail.slug));
      if (!link) return "";
      const pubDate = rfc822(detail.publishedAt) ?? rfc822(detail.updatedAt);
      return (
        `<item>` +
        `<title>${escapeXml(detail.title)}</title>` +
        `<link>${escapeXml(link)}</link>` +
        `<guid isPermaLink="true">${escapeXml(link)}</guid>` +
        (pubDate ? `<pubDate>${pubDate}</pubDate>` : "") +
        `<dc:creator>Glo Glo</dc:creator>` +
        `<description>${escapeXml(detail.excerpt)}</description>` +
        `<content:encoded>${cdata(renderItemContent(detail))}</content:encoded>` +
        `</item>`
      );
    })
    .filter(Boolean);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"` +
    ` xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">\n` +
    `<channel>` +
    `<title>Glo Glo 精選配搭指南｜RedCode Fashion Design</title>` +
    `<link>${escapeXml(channelLink)}</link>` +
    `<atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />` +
    `<description>Glo Glo 每週精選直播新品配搭靈感；配搭圖係 AI 效果圖，商品外觀以商品原圖為準。</description>` +
    `<language>zh-Hant-HK</language>` +
    `<lastBuildDate>${now.toUTCString()}</lastBuildDate>` +
    (items.length ? `\n  ${items.join("\n  ")}\n` : "") +
    `</channel>\n</rss>`
  );
}
