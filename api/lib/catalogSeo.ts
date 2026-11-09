import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
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
