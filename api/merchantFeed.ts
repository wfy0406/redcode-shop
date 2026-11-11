// Google Merchant Center 產品 feed（v2.2.21 項目 F1）：老闆要上 Google 購物免費刊登。
// RSS 2.0＋g namespace，GMC 定期爬 /merchant-feed.xml。
// 過濾條件同 sitemap route 一致：isActive=true＋未自動下架（delistEnabled/delistAt）。
// 價錢注意：products 表 price/discountPrice 係整數港元（唔係 cents），直接 toFixed(2)，唔准 ÷100。
// 鐵律：任何單一產品壞咗 skip 佢，唔准炸成個 feed；URL 唔落 log。
// v2026.11.11 一致性：描述／分類／價錢／折扣／庫存／尺寸／相片全部經
// api/lib/productPublicFacts.ts 取材，同可見首口 HTML 及 Product JSON-LD 同一套口徑；
// brand 冇真欄位所以唔出 g:brand（identifier_exists=no），唔再假設全部貨係 RedCode 品牌。
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { products } from "@db/schema";
import {
  FEED_ADDITIONAL_IMAGE_MAX,
  googleProductCategoryId,
  productFeedDescription,
  productFeedTitle,
  productImageUrls,
  productInStock,
  productSalePrice,
  productSizeOptions,
  productTypeLabel,
} from "./lib/productPublicFacts";
import { PUBLIC_PAGES } from "./lib/publicSeo";

const SITE_ORIGIN = "https://redcode.red";
// 首頁 meta description（同 index.html／首口 HTML 一致），做 channel description。
const CHANNEL_DESCRIPTION = PUBLIC_PAGES["/"].description;

/** XML escape：品名/描述入面嘅 & " < > ' 會整爛 XML */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function buildMerchantFeedXml(): Promise<string> {
  const db = getDb();
  const rows = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.isActive, true),
        or(
          eq(products.delistEnabled, false),
          isNull(products.delistAt),
          gt(products.delistAt, new Date()),
        )!,
      ),
    );

  const items: string[] = [];
  for (const p of rows) {
    // 單一產品壞咗 skip 佢，唔准炸成個 feed
    try {
      const title = productFeedTitle(p);
      const description = productFeedDescription(p);
      const link = `${SITE_ORIGIN}/products/${p.id}`;
      const images = productImageUrls(p, SITE_ORIGIN);
      const imageLink = images[0];
      const additionalImages = images.slice(1, 1 + FEED_ADDITIONAL_IMAGE_MAX);
      // 整數港元直接 toFixed(2) → "123.00 HKD"；折扣口徑同 JSON-LD 一致
      const price = `${p.price.toFixed(2)} HKD`;
      const sale = productSalePrice(p);
      const salePrice = sale != null ? `${sale.toFixed(2)} HKD` : null;
      const availability = productInStock(p) ? "in stock" : "out of stock";
      const googleCategory = googleProductCategoryId(p.category);
      const sizes = productSizeOptions(p);

      const lines = [
        `    <g:id>${p.id}</g:id>`,
        `    <title>${xmlEscape(title)}</title>`,
        `    <description>${xmlEscape(description)}</description>`,
        `    <link>${xmlEscape(link)}</link>`,
        `    <g:image_link>${xmlEscape(imageLink)}</g:image_link>`,
        ...additionalImages.map(
          (u) => `    <g:additional_image_link>${xmlEscape(u)}</g:additional_image_link>`,
        ),
        `    <g:price>${price}</g:price>`,
        ...(salePrice ? [`    <g:sale_price>${salePrice}</g:sale_price>`] : []),
        `    <g:availability>${availability}</g:availability>`,
        `    <g:condition>new</g:condition>`,
        // brand 冇真欄位：唔出 g:brand，用 identifier_exists=no（冇 GTIN/MPN/brand 嘅合法組合）
        `    <g:identifier_exists>no</g:identifier_exists>`,
        // google_product_category 按內部 8 類明確 mapping；other／未知類冇誠實對應就省略
        ...(googleCategory
          ? [`    <g:google_product_category>${googleCategory}</g:google_product_category>`]
          : []),
        // product_type 用真內部分類 label（同商品頁可見分類一致）
        `    <g:product_type>${xmlEscape(productTypeLabel(p.category))}</g:product_type>`,
        // 尺寸選項係真欄位；DB 冇 per-variant 行，多碼以 "/" 合併出（唔虛構缺碼）
        ...(sizes.length ? [`    <g:size>${xmlEscape(sizes.join("/"))}</g:size>`] : []),
        `    <g:adult>no</g:adult>`,
      ];
      items.push(`  <item>\n${lines.join("\n")}\n  </item>`);
    } catch (e) {
      // log 遮罩：唔落產品資料／URL，淨落 id 同錯誤類別
      console.error(
        `[merchant-feed] 產品 ${p.id} 跳過（${e instanceof Error ? e.name : "unknown"}）`,
      );
    }
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n` +
    `<channel>\n` +
    `  <title>RedCode Fashion Design</title>\n` +
    `  <link>${SITE_ORIGIN}</link>\n` +
    `  <description>${xmlEscape(CHANNEL_DESCRIPTION)}</description>\n` +
    `${items.join("\n")}\n` +
    `</channel>\n</rss>`
  );
}
