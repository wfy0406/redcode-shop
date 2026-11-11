import { and, desc, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { products } from "@db/schema";
import type { LiveFilter } from "./liveSeo";

export interface PublicCatalogItem {
  id: number;
  sku: string | null;
  name: string;
  price: number;
  discountPrice: number | null;
  stock: number;
}

/** 同 sitemap／merchant feed 一樣，只讀上架中而且未自動下架嘅公開商品。 */
export async function listPublicCatalog(limit = 48, live?: LiveFilter): Promise<PublicCatalogItem[]> {
  const cap = Number.isFinite(limit) ? Math.max(1, Math.min(60, Math.floor(limit))) : 48;
  return getDb()
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      price: products.price,
      discountPrice: products.discountPrice,
      stock: products.stock,
    })
    .from(products)
    .where(
      and(
        eq(products.isActive, true),
        or(eq(products.delistEnabled, false), isNull(products.delistAt), gt(products.delistAt, new Date())),
        ...(live ? [eq(products.liveDate, live.liveDate)] : []),
        ...(live?.liveSession ? [eq(products.liveSession, live.liveSession)] : []),
      ),
    )
    .orderBy(desc(products.listedDate), desc(products.id))
    .limit(cap);
}

export interface PublicLiveCatalogItem extends PublicCatalogItem {
  category: string | null;
}

/**
 * 直播節目頁專用（v2026.11.11.2）：攞該日／該場**全場**公開商品，
 * 同 listPublicCatalog 同一套公開上架條件，但**唔設展示 cap**——
 * SEO／GEO 摘要（件數、分類組成、代表商品）要數晒全場先係真數，
 * 唔好用 48/60 或任何硬上限冒充總數（場次商品量自然有限，係真場次先會有頁）。
 * 展示清單由 caller 自己 slice（首口 HTML 目錄照舊淨係出頭 48 件）。
 */
export async function listPublicLiveCatalog(
  live: LiveFilter,
): Promise<PublicLiveCatalogItem[]> {
  return getDb()
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      price: products.price,
      discountPrice: products.discountPrice,
      stock: products.stock,
      category: products.category,
    })
    .from(products)
    .where(
      and(
        eq(products.isActive, true),
        or(eq(products.delistEnabled, false), isNull(products.delistAt), gt(products.delistAt, new Date())),
        eq(products.liveDate, live.liveDate),
        ...(live.liveSession ? [eq(products.liveSession, live.liveSession)] : []),
      ),
    )
    .orderBy(desc(products.listedDate), desc(products.id));
}

/**
 * sitemap 用：公開商品實際出現過嘅直播日期／場次組合（distinct）。
 * 同 listPublicCatalog 同一套公開條件（上架中＋未自動下架），
 * 所以入到 sitemap 嘅直播 URL 一定對應至少一件真公開商品。
 * 回嚟嘅值未保證格式合法——caller 要過 liveSitemapPaths（內部會再驗證）。
 */
export async function listPublicLiveFilters(): Promise<LiveFilter[]> {
  const rows = await getDb()
    .selectDistinct({ liveDate: products.liveDate, liveSession: products.liveSession })
    .from(products)
    .where(
      and(
        eq(products.isActive, true),
        or(eq(products.delistEnabled, false), isNull(products.delistAt), gt(products.delistAt, new Date())),
        isNotNull(products.liveDate),
      ),
    );
  return rows
    .filter((r): r is { liveDate: string; liveSession: string | null } => typeof r.liveDate === "string")
    .map((r) => ({ liveDate: r.liveDate, liveSession: r.liveSession ?? null }));
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 公開商品目錄係真正 <a href>，令無 JS crawler 都可以由列表去到商品頁。 */
export function renderPublicCatalog(
  items: readonly PublicCatalogItem[],
  heading = "最新公開商品",
): string {
  if (items.length === 0) return "";
  const rows = items
    .map((p) => {
      const price = p.discountPrice ?? p.price;
      const sku = p.sku ? `（貨號 ${esc(p.sku)}）` : "";
      const stock = p.stock > 0 ? "有貨" : "暫時缺貨";
      return `<li><a href="/products/${p.id}"><strong>${esc(p.name)}</strong></a>${sku} — HK$${price}；${stock}</li>`;
    })
    .join("");
  return `<section id="redcode-catalog-seo"><h2>${esc(heading)}</h2><ul>${rows}</ul></section>`;
}

/** 加落已注入嘅 /products 公開摘要；冇貨或 DB 失敗時保留通用摘要，唔扮空目錄。 */
export function injectPublicCatalog(
  html: string,
  items: readonly PublicCatalogItem[],
  heading?: string,
): string {
  try {
    if (html.includes('id="redcode-catalog-seo"')) return html;
    const block = renderPublicCatalog(items, heading);
    if (!block) return html;
    return html.replace(
      '<nav aria-label="相關公開頁面">',
      `${block}<nav aria-label="相關公開頁面">`,
    );
  } catch {
    return html;
  }
}
