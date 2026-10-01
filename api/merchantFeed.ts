// Google Merchant Center 產品 feed（v2.2.21 項目 F1）：老闆要上 Google 購物免費刊登。
// RSS 2.0＋g namespace，GMC 定期爬 /merchant-feed.xml。
// 過濾條件同 sitemap route 一致：isActive=true＋未自動下架（delistEnabled/delistAt）。
// 價錢注意：products 表 price/discountPrice 係整數港元（唔係 cents），直接 toFixed(2)，唔准 ÷100。
// 鐵律：任何單一產品壞咗 skip 佢，唔准炸成個 feed；URL 唔落 log。
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { products } from "@db/schema";

const SITE_ORIGIN = "https://redcode.red";
// 首頁 meta description（同 index.html 一致），做 channel description
const CHANNEL_DESCRIPTION =
  "RedCode Fashion Design 官方購物網站 — 香港女裝直播，主播 Glo Glo 每晚為你揀選星空下最閃嘅衫。直播專屬優惠、直播重溫、順豐站自取，VIP 會員尊享禮遇。";

/** XML escape：品名/描述入面嘅 & " < > ' 會整爛 XML */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** strip HTML tag＋控制字元＋emoji（跟 og.ts stripText 同款），再截到 maxLen 字元 */
function stripText(s: string, maxLen: number): string {
  const plain = s
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > maxLen ? plain.slice(0, maxLen) : plain;
}

/** 首圖絕對 URL：photos[0]（封面，同 image 欄同步）優先，跟 og.ts 攞圖方式 */
function firstImageAbsUrl(photos: string[] | null, image: string): string {
  const src = photos && photos.length > 0 ? photos[0] : image;
  return src.startsWith("http") ? src : `${SITE_ORIGIN}${src}`;
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
      const title = p.name.length > 150 ? p.name.slice(0, 150) : p.name;
      const descSrc = p.description?.trim() || `${p.name}｜RedCode 香港女裝直播`;
      const description = stripText(descSrc, 5000);
      const link = `${SITE_ORIGIN}/products/${p.id}`;
      const imageLink = firstImageAbsUrl(p.photos, p.image);
      // 整數港元直接 toFixed(2) → "123.00 HKD"
      const price = `${p.price.toFixed(2)} HKD`;
      const salePrice =
        p.discountPrice != null && p.discountPrice < p.price
          ? `${p.discountPrice.toFixed(2)} HKD`
          : null;
      const availability = p.stock > 0 ? "in stock" : "out of stock";

      const lines = [
        `    <g:id>${p.id}</g:id>`,
        `    <title>${xmlEscape(title)}</title>`,
        `    <description>${xmlEscape(description)}</description>`,
        `    <link>${xmlEscape(link)}</link>`,
        `    <g:image_link>${xmlEscape(imageLink)}</g:image_link>`,
        `    <g:price>${price}</g:price>`,
        ...(salePrice ? [`    <g:sale_price>${salePrice}</g:sale_price>`] : []),
        `    <g:availability>${availability}</g:availability>`,
        `    <g:condition>new</g:condition>`,
        `    <g:brand>RedCode</g:brand>`,
        `    <g:identifier_exists>no</g:identifier_exists>`,
        `    <g:google_product_category>166</g:google_product_category>`,
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
