import { and, desc, eq, gt, isNull, ne, or } from "drizzle-orm";
import { gloGuideArticleProducts, gloGuideArticles, products } from "@db/schema";
import { productCategoryLabel } from "@contracts/types";
import { getDb } from "../queries/connection";
import { livePath, parseLiveQuery } from "./liveSeo";

export interface ProductInternalLink {
  href: string;
  label: string;
}

export interface ProductInternalLinkGroups {
  /** 同類目錄／原直播場次：只由 products 真欄位產生。 */
  contexts: ProductInternalLink[];
  /** 同場次優先、其次同日、最後同類；全部由公開商品查詢返回。 */
  related: ProductInternalLink[];
  /** 只有 published 指南同呢個 productId 有真關聯先列出。 */
  guides: ProductInternalLink[];
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderLinks(links: readonly ProductInternalLink[]): string {
  return links
    .map((link) => `<li><a href="${esc(link.href)}">${esc(link.label)}</a></li>`)
    .join("");
}

/** 純注入器：冇商品首口區、冇真關係或已注入時都係 no-op。 */
export function injectProductInternalLinkBlock(
  html: string,
  groups: ProductInternalLinkGroups,
): string {
  try {
    if (!html.includes('id="redcode-product-seo"') || html.includes('id="redcode-product-links-seo"')) {
      return html;
    }
    const sections: string[] = [];
    if (groups.related.length) {
      sections.push(`<section><h2>同場次／同類商品</h2><ul>${renderLinks(groups.related)}</ul></section>`);
    }
    if (groups.guides.length) {
      sections.push(`<section><h2>有呢件商品嘅 Glo Glo 指南</h2><ul>${renderLinks(groups.guides)}</ul></section>`);
    }
    if (groups.contexts.length) {
      sections.push(`<section><h2>繼續揀款</h2><ul>${renderLinks(groups.contexts)}</ul></section>`);
    }
    if (!sections.length) return html;
    const block = `<section id="redcode-product-links-seo">${sections.join("")}</section>`;
    return html.replace(
      '<nav aria-label="購物相關頁面">',
      `${block}<nav aria-label="購物相關頁面">`,
    );
  } catch {
    return html;
  }
}

/**
 * 商品首口內鏈：以公開商品同 published 指南關係為唯一來源。
 * 任何附屬查詢故障都只省略該組，唔會令商品頁由 200 變錯誤或影響原有 OG／schema。
 */
export async function injectProductInternalLinks(html: string, productId: number): Promise<string> {
  if (!html.includes('id="redcode-product-seo"') || html.includes('id="redcode-product-links-seo"')) {
    return html;
  }
  try {
    const db = getDb();
    const publicProduct = and(
      eq(products.isActive, true),
      or(eq(products.delistEnabled, false), isNull(products.delistAt), gt(products.delistAt, new Date()))!,
    );
    const [current] = await db
      .select({
        id: products.id,
        category: products.category,
        liveDate: products.liveDate,
        liveSession: products.liveSession,
      })
      .from(products)
      .where(and(eq(products.id, productId), publicProduct))
      .limit(1);
    if (!current) return html;

    const contexts: ProductInternalLink[] = [];
    const category = typeof current.category === "string" ? current.category.trim() : "";
    if (category) {
      contexts.push({
        href: `/products?category=${encodeURIComponent(category)}`,
        label: `全部${productCategoryLabel(category)}`,
      });
    }
    const live = parseLiveQuery(current.liveDate, current.liveSession);
    if (live) {
      contexts.push({
        href: livePath(live),
        label: live.liveSession
          ? `睇返同一場直播商品（第${live.liveSession}場）`
          : "睇返同一日直播商品",
      });
    }

    let related: ProductInternalLink[] = [];
    const relations = [
      ...(category ? [eq(products.category, category)] : []),
      ...(live ? [eq(products.liveDate, live.liveDate)] : []),
    ];
    if (relations.length) {
      try {
        const rows = await db
          .select({
            id: products.id,
            name: products.name,
            category: products.category,
            liveDate: products.liveDate,
            liveSession: products.liveSession,
          })
          .from(products)
          .where(and(ne(products.id, productId), publicProduct, or(...relations)!))
          .orderBy(desc(products.listedDate), desc(products.id))
          .limit(12);
        const ranked = rows
          .filter((row) => row.id !== productId)
          .map((row) => {
            const exactLive = !!live?.liveSession && row.liveDate === live.liveDate && row.liveSession === live.liveSession;
            const sameDay = !!live && row.liveDate === live.liveDate;
            return { row, rank: exactLive ? 0 : sameDay ? 1 : 2 };
          })
          .sort((a, b) => a.rank - b.rank);
        const seen = new Set<number>();
        related = ranked
          .filter(({ row }) => {
            if (seen.has(row.id)) return false;
            seen.add(row.id);
            return true;
          })
          .slice(0, 6)
          .map(({ row }) => ({ href: `/products/${row.id}`, label: row.name }));
      } catch {
        related = [];
      }
    }

    let guides: ProductInternalLink[] = [];
    try {
      const rows = await db
        .select({ slug: gloGuideArticles.slug, title: gloGuideArticles.title })
        .from(gloGuideArticleProducts)
        .innerJoin(gloGuideArticles, eq(gloGuideArticleProducts.articleId, gloGuideArticles.id))
        .where(and(eq(gloGuideArticleProducts.productId, productId), eq(gloGuideArticles.status, "published")))
        .orderBy(desc(gloGuideArticles.publishedAt))
        .limit(4);
      guides = rows.map((row) => ({ href: `/glo-guide/${row.slug}`, label: row.title }));
    } catch {
      guides = [];
    }

    return injectProductInternalLinkBlock(html, { contexts, related, guides });
  } catch {
    return html;
  }
}
