/**
 * SEO 注入測試（2026-10-27 Search Console 修復）——**唔掂真 DB**。
 *
 * 覆蓋三個實際搵到嘅問題：
 * 1) 商品頁 meta[name=description] 之前永遠係首頁通用嗰條（injectProductOg 漏咗換），
 *    /products/85、/products/95 呢類短名商品被 Google 當 near-duplicate。
 * 2) 唔存在嘅商品（例如已刪嘅 /products/94）之前回 200＋首頁 title/canonical（軟 404），
 *    而家 injectProductOg 回 null → vite.ts 回真 404＋noindex；DB 故障仍回 200 原 HTML。
 * 3) 商品頁 raw HTML 有真商品摘要（名/價/描述），唔行 JS 嘅 crawler 都直接讀到。
 *
 * 做法：vi.mock 假 getDb（chainable stub 模擬 drizzle select().from().where().limit()），
 * HTML fixture 直接用 repo 真 index.html（順便防止正則同模板漂移）。
 */
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mock DB：rows 唔空＝商品存在；空＝查詢成功但唔存在；queryError 唔 null＝DB 故障 ──
let mockRows: unknown[] = [];
let queryError: Error | null = null;
let seenWhere: unknown = null;

vi.mock("../queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (where: unknown) => {
          seenWhere = where;
          return {
            limit: () => (queryError ? Promise.reject(queryError) : Promise.resolve(mockRows)),
          };
        },
      }),
    }),
  }),
}));

import { injectProductOg, injectRouteMeta } from "./og";

const TEMPLATE = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const ORIGIN = "https://redcode.red";
const GENERIC_HOME_DESC =
  "RedCode Fashion Design 官方購物網站 — 香港女裝直播，主播 Glo Glo 為你揀選星空下最閃嘅衫。AI 試穿：影張相即刻試穿，即刻睇到著上身效果。不定期優惠、直播重溫、順豐站自取，VIP 會員尊享禮遇。";

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

beforeEach(() => {
  mockRows = [];
  queryError = null;
  seenWhere = null;
});

describe("injectProductOg — 商品存在", () => {
  it("注入商品專屬 title／meta description／canonical／OG", async () => {
    mockRows = [makeProduct()];
    const out = await injectProductOg(TEMPLATE, 85, ORIGIN);
    expect(out).not.toBeNull();
    const html = out!;
    // title 同前端 ProductDetail document.title 格式對齊
    expect(html).toContain("<title>067｜RedCode Fashion Design</title>");
    // ★ 核心修復：meta description 係商品專屬，唔再係首頁通用嗰條
    expect(html).toContain(
      '<meta name="description" content="星空閃石上衣，直播限定色，S/M/L 碼齊。" />',
    );
    expect(html).not.toContain(GENERIC_HOME_DESC);
    // canonical 指返自己（self-canonical）
    expect(html).toContain('<link rel="canonical" href="https://redcode.red/products/85" />');
    expect(html).toContain('<meta property="og:title" content="067｜RedCode Fashion Design" />');
    expect(html).toContain('<meta property="og:url" content="https://redcode.red/products/85" />');
    // 首頁通用 og:image 被商品圖取代
    expect(html).toContain('<meta property="og:image" content="https://redcode.red/uploads/p85.jpg" />');
    expect(html).not.toContain("og-image.jpg");
  });

  it("商品冇 description → 用真貨號、分類、價錢同庫存補強，唔會出首頁通用 description", async () => {
    mockRows = [makeProduct({ description: null })];
    const html = (await injectProductOg(TEMPLATE, 85, ORIGIN))!;
    expect(html).toContain("067｜上衣｜貨號 SKU-067｜HK$199｜現貨 5 件");
    expect(html).toContain("<p>分類：上衣</p>");
    expect(html).toContain("<p>現貨 5 件</p>");
    expect(html).not.toContain(GENERIC_HOME_DESC);
    expect(html).not.toContain("直播優惠價發售，順豐站自取");
  });

  it("description 有 HTML tag／emoji → 入 meta 前剝走做純文字", async () => {
    mockRows = [makeProduct({ description: "<p>靚衫✨</p>\n<b>必買</b>" })];
    const html = (await injectProductOg(TEMPLATE, 85, ORIGIN))!;
    expect(html).toContain('<meta name="description" content="靚衫 必買" />');
    // 原始 markup／emoji 唔准漏入任何輸出（meta／OG／JSON-LD／noscript 全部要純文字）。
    // 注意唔好断言 "<p>靚衫"：noscript 摘要合法地用 <p> 包住剝咗 markup 嘅純文字。
    expect(html).not.toContain("<p>靚衫✨</p>");
    expect(html).not.toContain("<b>必買</b>");
    expect(html).not.toContain("✨");
  });

  it("品名有特殊字元 → HTML attribute escape，唔會整爛 meta tag", async () => {
    mockRows = [makeProduct({ name: 'A"B & <C>' })];
    const html = (await injectProductOg(TEMPLATE, 85, ORIGIN))!;
    expect(html).toContain("<title>A&quot;B &amp; &lt;C&gt;｜RedCode Fashion Design</title>");
    expect(html).not.toContain('content="A"B');
  });

  it("真 HTML 商品摘要：名／貨號／價錢／描述／購物支援連結，#root 保持空", async () => {
    mockRows = [makeProduct()];
    const html = (await injectProductOg(TEMPLATE, 85, ORIGIN))!;
    expect(html).toContain('<main id="redcode-product-seo" data-redcode-prerender');
    expect(html).toContain("<h1>067</h1>");
    expect(html).toContain("<p>貨號：SKU-067</p>");
    expect(html).toContain("<p>尺寸：S、M、L</p>");
    expect(html).toContain("<p>HK$199</p>");
    expect(html).toContain("<p>星空閃石上衣，直播限定色，S/M/L 碼齊。</p>");
    expect(html).toContain("<p>正常情況下，訂單確認後約 7–10 個工作天寄出，惟部分商品可能需要更久。</p>");
    expect(html).toContain("呢個係寄出時間，唔係保證送達時間，亦唔係收貨後 7 天嘅退換申請期限。");
    expect(html).toContain('<a href="/products">全部貨品</a>');
    expect(html).toContain('<a href="/returns">退換貨政策</a>');
    expect(html).not.toContain("<noscript");
    // 商品摘要喺 </body> 前、唔喺 #root 入面（白屏自救 script 靠 root 空唔空判斷）
    expect(html.indexOf('id="redcode-product-seo"')).toBeGreaterThan(html.indexOf('id="root"'));
    expect(html).toMatch(/<div id="root"><\/div>/);
  });

  it("Product JSON-LD：價錢係港元整數 toFixed（唔係 cents），貨存狀態正確", async () => {
    mockRows = [makeProduct()];
    const html = (await injectProductOg(TEMPLATE, 85, ORIGIN))!;
    const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    const productLd = ldBlocks
      .map((m) => JSON.parse(m[1]) as Record<string, unknown>)
      .find((j) => j["@type"] === "Product");
    expect(productLd).toBeTruthy();
    const offers = productLd!.offers as Record<string, unknown>;
    expect(offers.price).toBe("199.00"); // discountPrice 優先
    expect(offers.availability).toBe("https://schema.org/InStock");
    expect(productLd!.name).toBe("067");
    expect(productLd!.size).toEqual(["S", "M", "L"]);
    const returnPolicy = offers.hasMerchantReturnPolicy as Record<string, unknown>;
    expect(returnPolicy.merchantReturnDays).toBe(7);
    expect(returnPolicy.itemDefectReturnFees).toBe("https://schema.org/FreeReturn");
    expect(returnPolicy.customerRemorseReturnFees).toBe("https://schema.org/ReturnShippingFees");
    expect(returnPolicy.returnShippingFeesAmount).toBeUndefined();
    const shippingDetails = offers.shippingDetails as Record<string, unknown>;
    expect(shippingDetails["@type"]).toBe("OfferShippingDetails");
    expect(shippingDetails.description).toBe("正常情況下，訂單確認後約 7–10 個工作天寄出，惟部分商品可能需要更久。");
    expect(shippingDetails.shippingRate).toBeUndefined();
    const deliveryTime = shippingDetails.deliveryTime as Record<string, unknown>;
    expect(deliveryTime["@type"]).toBe("ShippingDeliveryTime");
    expect(deliveryTime.transitTime).toBeUndefined();
    expect(deliveryTime.handlingTime).toEqual({
      "@type": "QuantitativeValue",
      minValue: 7,
      maxValue: 10,
      unitCode: "DAY",
    });
    expect(JSON.stringify(offers)).not.toContain("30.00");
  });

  it("brand 冇真欄位：Product JSON-LD 唔再硬編碼 RedCode 品牌（同 Feed 唔出 g:brand 一致）", async () => {
    mockRows = [makeProduct()];
    const html = (await injectProductOg(TEMPLATE, 85, ORIGIN))!;
    const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    const productLd = ldBlocks
      .map((m) => JSON.parse(m[1]) as Record<string, unknown>)
      .find((j) => j["@type"] === "Product");
    expect(productLd).toBeTruthy();
    expect(productLd!.brand).toBeUndefined();
  });

  it("JSON-LD image 用晒成個真 photos 相簿（同 Feed image_link＋additional_image_link 一致）", async () => {
    mockRows = [makeProduct()];
    const html = (await injectProductOg(TEMPLATE, 85, ORIGIN))!;
    const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    const productLd = ldBlocks
      .map((m) => JSON.parse(m[1]) as Record<string, unknown>)
      .find((j) => j["@type"] === "Product");
    expect(productLd!.image).toEqual([
      "https://redcode.red/uploads/p85.jpg",
      "https://redcode.red/uploads/p85b.jpg",
    ]);
  });

  it("壞折扣（discountPrice ≥ 原價）：JSON-LD offers.price 照原價，唔再出虛高價（同 Feed 口徑）", async () => {
    mockRows = [makeProduct({ discountPrice: 399 })];
    const html = (await injectProductOg(TEMPLATE, 85, ORIGIN))!;
    expect(html).toContain("<p>HK$299</p>");
    const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    const productLd = ldBlocks
      .map((m) => JSON.parse(m[1]) as Record<string, unknown>)
      .find((j) => j["@type"] === "Product");
    expect((productLd!.offers as Record<string, unknown>).price).toBe("299.00");
  });

  it("停用尺寸或冇尺寸資料時，首口摘要同 Product JSON-LD 都唔會虛構尺寸", async () => {
    mockRows = [makeProduct({ sizeEnabled: false, sizes: "S,M,L" })];
    const html = (await injectProductOg(TEMPLATE, 85, ORIGIN))!;
    expect(html).not.toContain("<p>尺寸：");
    const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    const productLd = ldBlocks
      .map((m) => JSON.parse(m[1]) as Record<string, unknown>)
      .find((j) => j["@type"] === "Product");
    expect(productLd).toBeTruthy();
    expect(productLd!.size).toBeUndefined();
  });

  it("AI 標籤重點：aiTagsEnabled=true 先出喺首口描述區；disabled 絕對唔出現", async () => {
    mockRows = [makeProduct({ aiTags: '["直播熱賣","新品"]', aiTagsEnabled: true })];
    const html = (await injectProductOg(TEMPLATE, 85, ORIGIN))!;
    expect(html).toContain("<p>重點：直播熱賣、新品</p>");

    mockRows = [makeProduct({ aiTags: '["直播熱賣","新品"]', aiTagsEnabled: false })];
    const off = (await injectProductOg(TEMPLATE, 85, ORIGIN))!;
    expect(off).not.toContain("重點：");
    expect(off).not.toContain("直播熱賣");

    // enabled 但冇內容／壞 JSON → 唔出重點行，亦唔會炸
    mockRows = [makeProduct({ aiTags: null })];
    expect((await injectProductOg(TEMPLATE, 85, ORIGIN))!).not.toContain("重點：");
    mockRows = [makeProduct({ aiTags: "唔係JSON" })];
    expect((await injectProductOg(TEMPLATE, 85, ORIGIN))!).not.toContain("重點：");
  });

  it("公開查詢同 products.byId 一樣擋人手下架及已到期自動下架", async () => {
    mockRows = [makeProduct()];
    await injectProductOg(TEMPLATE, 85, ORIGIN);
    const query = new PgDialect().sqlToQuery(seenWhere as never);
    expect(query.params.slice(0, 3)).toEqual([85, true, false]);
    expect(Number.isNaN(Date.parse(String(query.params[3])))).toBe(false);
    expect(query.sql).toMatch(/"id" = \$1/);
    expect(query.sql).toMatch(/"isActive" = \$2/);
    expect(query.sql).toMatch(/"delistEnabled" = \$3/);
    expect(query.sql).toContain('"delistAt" is null');
    expect(query.sql).toMatch(/"delistAt" > \$4/);
  });

  it("首頁 canonical 改過 whitespace／quote 都照樣換成商品 self canonical", async () => {
    mockRows = [makeProduct()];
    const varied = TEMPLATE.replace(
      '<link rel="canonical" href="https://redcode.red/" />',
      "<link\n    rel='canonical' href='https://redcode.red/' >",
    );
    const html = (await injectProductOg(varied, 85, ORIGIN))!;
    expect(html).toContain('<link rel="canonical" href="https://redcode.red/products/85" />');
    expect(html.match(/rel=["']canonical["']/g)).toHaveLength(1);
  });
});

describe("injectProductOg — 商品唔存在／DB 故障（軟 404 根治）", () => {
  it("查詢成功但零行 → 回 null（caller 轉真 404＋noindex）", async () => {
    mockRows = [];
    const out = await injectProductOg(TEMPLATE, 94, ORIGIN);
    expect(out).toBeNull();
  });

  it("DB 故障 → 原封不動回 HTML（200），在架商品唔會被一時故障誤當 404", async () => {
    queryError = new Error("connection refused");
    const out = await injectProductOg(TEMPLATE, 85, ORIGIN);
    expect(out).toBe(TEMPLATE);
  });
});

describe("injectRouteMeta — canonical／noindex", () => {
  it("公開頁：title/description/canonical 按 path 注入", () => {
    const out = injectRouteMeta(TEMPLATE, {
      title: "全部貨品｜RedCode Fashion Design",
      description: "全部貨品描述",
      path: "/products",
    });
    expect(out).toContain("<title>全部貨品｜RedCode Fashion Design</title>");
    expect(out).toContain('<meta name="description" content="全部貨品描述" />');
    expect(out).toContain('<link rel="canonical" href="https://redcode.red/products" />');
    expect(out).toContain('<meta property="og:url" content="https://redcode.red/products" />');
    // 淨係一條 canonical（replace 原有，唔會多一條）
    expect(out.match(/rel="canonical"/g)).toHaveLength(1);
  });

  it("公開頁同步換 Twitter title／description、OG image alt，並標記 schema 所屬路徑", () => {
    const out = injectRouteMeta(TEMPLATE, {
      title: "網站設計標題",
      description: "網站設計描述",
      path: "/web-design",
      image: "/web-design/web-design-og.webp",
      structuredData: { "@context": "https://schema.org", "@type": "Service" },
    });
    expect(out).toContain('<meta name="twitter:title" content="網站設計標題" />');
    expect(out).toContain('<meta name="twitter:description" content="網站設計描述" />');
    expect(out).toContain('<meta property="og:image:alt" content="網站設計標題" />');
    expect(out).toContain('data-redcode-route-schema="/web-design"');
  });

  it("直播節目頁 path 帶 query：canonical／og:url 正確 escape（& → &amp;），淨係一條 canonical", () => {
    // v2026.10.28.2：/products?liveDate=...&liveSession=... 嘅 self canonical
    const out = injectRouteMeta(TEMPLATE, {
      title: "2026年10月28日 第2場直播商品｜RedCode Fashion Design",
      description: "RedCode 2026年10月28日 第2場直播商品——即睇直播商品。",
      path: "/products?liveDate=20261028&liveSession=2",
    });
    expect(out).toContain(
      '<link rel="canonical" href="https://redcode.red/products?liveDate=20261028&amp;liveSession=2" />',
    );
    expect(out).toContain(
      '<meta property="og:url" content="https://redcode.red/products?liveDate=20261028&amp;liveSession=2" />',
    );
    expect(out).toContain(
      "<title>2026年10月28日 第2場直播商品｜RedCode Fashion Design</title>",
    );
    expect(out.match(/rel="canonical"/g)).toHaveLength(1);
    // raw & 唔准喺 canonical／og:url 入面（HTML 屬性一定要 escape）
    const canonicalTag = out.match(/<link\s+rel="canonical"[^>]*\/>/)?.[0] ?? "";
    expect(canonicalTag).not.toContain("&liveSession");
  });

  it("noindex：robots meta 由 index,follow 改 noindex,nofollow（私人頁用）", () => {
    const out = injectRouteMeta(TEMPLATE, { noindex: true });
    expect(out).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(out).not.toContain("index, follow");
    expect(out.match(/name="robots"/g)).toHaveLength(1);
  });

  it("404／私人 noindex 可移除首頁 canonical，唔再宣告內容等同首頁", () => {
    const out = injectRouteMeta(TEMPLATE, {
      title: "搵唔到呢件商品｜RedCode Fashion Design",
      canonical: null,
      noindex: true,
    });
    expect(out).toContain("<title>搵唔到呢件商品｜RedCode Fashion Design</title>");
    expect(out).not.toContain('rel="canonical"');
    expect(out).not.toContain('property="og:url"');
    expect(out).toContain('<meta name="robots" content="noindex, nofollow" />');
  });
});
