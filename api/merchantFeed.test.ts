/**
 * Merchant Feed 測試（v2026.11.11 商品公開資料一致性）——**唔掂真 DB**。
 *
 * 覆蓋：
 * 1) Feed 描述同可見首口／JSON-LD 行同一份 contracts 規則（清理＋截斷一致），
 *    冇描述時用真貨號／分類／價錢／庫存補強，唔再出「{名}｜RedCode 香港女裝直播」模板假內容。
 * 2) google_product_category 按內部 8 類明確 mapping；other／未知類省略元素；
 *    product_type 用真內部分類 label。
 * 3) 多圖：image_link＝封面、additional_image_link＝其餘真 photos；同 JSON-LD image 一致。
 * 4) 價錢／折扣／庫存同 injectProductOg 嘅 Product JSON-LD 逐件對照（壞折扣口徑一致）。
 * 5) AI 標籤無論開關都唔會入 Feed（唔准 AI tags 充當規格）。
 * 6) 鐵律保留：公開下架過濾、單件壞資料 skip 唔炸成個 feed。
 * 7) brand 冇真欄位：唔出 g:brand，用 identifier_exists=no。
 *
 * mock 同 og.test.ts 同款，但 where() 回 thenable＋limit()，等 injectProductOg
 * （where().limit()）同 buildMerchantFeedXml（直接 await where()）都用得。
 */
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockRows: unknown[] = [];
let queryError: Error | null = null;
let seenWhere: unknown = null;

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (where: unknown) => {
          seenWhere = where;
          const result: Promise<unknown[]> & { limit?: () => Promise<unknown[]> } = queryError
            ? Promise.reject(queryError)
            : Promise.resolve(mockRows);
          result.limit = () => result;
          return result;
        },
      }),
    }),
  }),
}));

import { buildMerchantFeedXml } from "./merchantFeed";
import { injectProductOg } from "./lib/og";

const TEMPLATE = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const ORIGIN = "https://redcode.red";

function makeProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: 85,
    sku: "SKU-067",
    name: "067",
    description: "星空閃石上衣，直播限定色，S/M/L 碼齊。",
    image: "/uploads/p85.jpg",
    photos: ["/uploads/p85.jpg", "/uploads/p85b.jpg"],
    price: 299,
    discountPrice: 199,
    sizes: "S,M,L",
    sizeEnabled: true,
    delistEnabled: false,
    delistAt: null,
    liveDate: null,
    liveSession: null,
    note: null,
    category: "top",
    listedDate: new Date("2026-10-01"),
    stock: 5,
    isActive: true,
    aiTags: null,
    aiTagsEnabled: true,
    createdAt: new Date("2026-10-01"),
    ...overrides,
  };
}

/** 由 injectProductOg 出嘅 HTML 抽 Product JSON-LD（同 og.test.ts 同款做法） */
function productJsonLd(html: string): Record<string, unknown> {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  const ld = blocks
    .map((m) => JSON.parse(m[1]) as Record<string, unknown>)
    .find((j) => j["@type"] === "Product");
  expect(ld).toBeTruthy();
  return ld!;
}

beforeEach(() => {
  mockRows = [];
  queryError = null;
  seenWhere = null;
});

describe("描述口徑一致＋冇模板假內容", () => {
  it("有描述：Feed description 係剝咗 HTML／emoji 嘅純文字，同 og meta description 同源", async () => {
    const p = makeProduct({ description: "<p>靚衫✨</p>\n<b>必買</b>" });
    mockRows = [p];
    const xml = await buildMerchantFeedXml();
    expect(xml).toContain("<description>靚衫 必買</description>");
    expect(xml).not.toContain("✨");
    expect(xml).not.toContain("<b>必買</b>");

    const html = (await injectProductOg(TEMPLATE, 85, ORIGIN))!;
    expect(html).toContain('<meta name="description" content="靚衫 必買" />');
  });

  it("冇描述：用真貨號／分類／售價／庫存補強，唔再出舊模板兜底", async () => {
    mockRows = [makeProduct({ description: null })];
    const xml = await buildMerchantFeedXml();
    expect(xml).toContain("067｜上衣｜貨號 SKU-067｜HK$199｜現貨 5 件");
    expect(xml).not.toContain("RedCode 香港女裝直播");
  });
});

describe("分類：google_product_category mapping＋真 product_type", () => {
  it("top → 212、product_type 上衣", async () => {
    mockRows = [makeProduct({ category: "top" })];
    const xml = await buildMerchantFeedXml();
    expect(xml).toContain("<g:google_product_category>212</g:google_product_category>");
    expect(xml).toContain("<g:product_type>上衣</g:product_type>");
  });

  it("dress → 2271、skincare → 567、shoes → 187", async () => {
    mockRows = [
      makeProduct({ id: 1, category: "dress" }),
      makeProduct({ id: 2, category: "skincare" }),
      makeProduct({ id: 3, category: "shoes" }),
    ];
    const xml = await buildMerchantFeedXml();
    expect(xml).toContain("<g:google_product_category>2271</g:google_product_category>");
    expect(xml).toContain("<g:google_product_category>567</g:google_product_category>");
    expect(xml).toContain("<g:google_product_category>187</g:google_product_category>");
    expect(xml).toContain("<g:product_type>裙</g:product_type>");
    expect(xml).toContain("<g:product_type>護膚品</g:product_type>");
    expect(xml).toContain("<g:product_type>鞋</g:product_type>");
  });

  it("other／未知類省略 google_product_category（唔再一律 166）", async () => {
    mockRows = [makeProduct({ category: "other" })];
    const xml = await buildMerchantFeedXml();
    expect(xml).not.toContain("google_product_category");
    expect(xml).toContain("<g:product_type>其他</g:product_type>");
    mockRows = [makeProduct({ category: "乜都唔係" })];
    expect(await buildMerchantFeedXml()).not.toContain("google_product_category");
  });
});

describe("多圖：Feed 同 JSON-LD 用同一個真相簿", () => {
  it("封面做 image_link，其餘 photos 做 additional_image_link，同 JSON-LD image 一致", async () => {
    const p = makeProduct();
    mockRows = [p];
    const xml = await buildMerchantFeedXml();
    expect(xml).toContain("<g:image_link>https://redcode.red/uploads/p85.jpg</g:image_link>");
    expect(xml).toContain(
      "<g:additional_image_link>https://redcode.red/uploads/p85b.jpg</g:additional_image_link>",
    );

    const ld = productJsonLd((await injectProductOg(TEMPLATE, 85, ORIGIN))!);
    expect(ld.image).toEqual([
      "https://redcode.red/uploads/p85.jpg",
      "https://redcode.red/uploads/p85b.jpg",
    ]);
  });

  it("冇 photos 淨出 image 一張，唔會虛構額外圖", async () => {
    mockRows = [makeProduct({ photos: null })];
    const xml = await buildMerchantFeedXml();
    expect(xml).toContain("<g:image_link>https://redcode.red/uploads/p85.jpg</g:image_link>");
    expect(xml).not.toContain("additional_image_link");
  });
});

describe("價錢／折扣／庫存／尺寸：Feed 同首口＋JSON-LD 一致", () => {
  it("真折扣：Feed price＋sale_price，同 JSON-LD offers.price、首口售價一致", async () => {
    mockRows = [makeProduct()];
    const xml = await buildMerchantFeedXml();
    expect(xml).toContain("<g:price>299.00 HKD</g:price>");
    expect(xml).toContain("<g:sale_price>199.00 HKD</g:sale_price>");
    expect(xml).toContain("<g:availability>in stock</g:availability>");
    expect(xml).toContain("<g:size>S/M/L</g:size>");

    const html = (await injectProductOg(TEMPLATE, 85, ORIGIN))!;
    const ld = productJsonLd(html);
    const offers = ld.offers as Record<string, unknown>;
    expect(offers.price).toBe("199.00"); // ＝Feed sale_price
    expect(offers.availability).toBe("https://schema.org/InStock");
    expect(ld.size).toEqual(["S", "M", "L"]);
    expect(html).toContain("<p>HK$199</p>"); // 首口可見售價同一口徑
  });

  it("壞折扣（discountPrice ≥ price）：Feed 唔出 sale_price，JSON-LD 都照原價（舊版會出虛高價）", async () => {
    mockRows = [makeProduct({ discountPrice: 399 })];
    const xml = await buildMerchantFeedXml();
    expect(xml).toContain("<g:price>299.00 HKD</g:price>");
    expect(xml).not.toContain("sale_price");

    const ld = productJsonLd((await injectProductOg(TEMPLATE, 85, ORIGIN))!);
    expect((ld.offers as Record<string, unknown>).price).toBe("299.00");
  });

  it("缺貨：Feed out of stock 同 JSON-LD OutOfStock 一致", async () => {
    mockRows = [makeProduct({ stock: 0 })];
    const xml = await buildMerchantFeedXml();
    expect(xml).toContain("<g:availability>out of stock</g:availability>");
    const ld = productJsonLd((await injectProductOg(TEMPLATE, 85, ORIGIN))!);
    expect((ld.offers as Record<string, unknown>).availability).toBe(
      "https://schema.org/OutOfStock",
    );
  });

  it("sizeEnabled=false：Feed 同 JSON-LD 都唔虛構尺寸", async () => {
    mockRows = [makeProduct({ sizeEnabled: false })];
    const xml = await buildMerchantFeedXml();
    expect(xml).not.toContain("<g:size>");
    const ld = productJsonLd((await injectProductOg(TEMPLATE, 85, ORIGIN))!);
    expect(ld.size).toBeUndefined();
  });
});

describe("AI 標籤唔入 Feed、brand 唔虛構", () => {
  it("aiTagsEnabled=false 唔洩標籤；就算 enabled，Feed 都唔會將 AI 標籤當規格出街", async () => {
    mockRows = [makeProduct({ aiTags: '["直播熱賣","新品"]', aiTagsEnabled: false })];
    let xml = await buildMerchantFeedXml();
    expect(xml).not.toContain("直播熱賣");
    expect(xml).not.toContain("新品");

    mockRows = [makeProduct({ aiTags: '["直播熱賣","新品"]', aiTagsEnabled: true })];
    xml = await buildMerchantFeedXml();
    expect(xml).not.toContain("直播熱賣");
    expect(xml).not.toContain("新品");
  });

  it("brand 冇真欄位：唔出 g:brand，保留 identifier_exists=no", async () => {
    mockRows = [makeProduct()];
    const xml = await buildMerchantFeedXml();
    expect(xml).not.toContain("g:brand");
    expect(xml).toContain("<g:identifier_exists>no</g:identifier_exists>");
  });
});

describe("鐵律保留：下架過濾＋單件壞資料 skip", () => {
  it("公開查詢同 sitemap 一樣擋人手下架及已到期自動下架", async () => {
    mockRows = [makeProduct()];
    await buildMerchantFeedXml();
    const query = new PgDialect().sqlToQuery(seenWhere as never);
    expect(query.params.slice(0, 2)).toEqual([true, false]);
    expect(Number.isNaN(Date.parse(String(query.params[2])))).toBe(false);
    expect(query.sql).toMatch(/"isActive" = \$1/);
    expect(query.sql).toMatch(/"delistEnabled" = \$2/);
    expect(query.sql).toContain('"delistAt" is null');
    expect(query.sql).toMatch(/"delistAt" > \$3/);
  });

  it("單件壞資料 skip：其餘商品照出，成個 feed 唔炸、log 唔落 URL", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRows = [makeProduct(), makeProduct({ id: 99, name: null })];
    const xml = await buildMerchantFeedXml();
    expect(xml).toContain("<g:id>85</g:id>");
    expect(xml).not.toContain("<g:id>99</g:id>");
    expect(xml).toContain("</rss>");
    expect(errSpy).toHaveBeenCalledOnce();
    expect(String(errSpy.mock.calls[0][0])).not.toContain("http");
    errSpy.mockRestore();
  });
});
