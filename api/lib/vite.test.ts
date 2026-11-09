/**
 * Route-level SEO 測試（2026-10-27 交付前驗收）——真 Hono app＋真 serveStaticFiles
 * handler（api/lib/vite.ts），**唔掂真 DB、唔掂真静态檔、唔起 server**。
 *
 * Mock 邊界（三個，全部喺我呢個檔入面）：
 * 1) @hono/node-server/serve-static → 一律 next()：測試環境冇 dist/public，
 *    等請求落入 notFound fallback（SPA 出 index.html 嗰段就係要驗嘅真 handler）。
 * 2) fs.readFileSync → 回 repo 真 index.html fixture（spyOn 共享 builtin 物件，
 *    淨係攔截 handler 嗰次 index.html read；fixture 喺 module 頂用真 fs 預讀）。
 * 3) ../queries/connection getDb → chainable stub（同 og.test.ts 同一 pattern）：
 *    rows 唔空＝商品存在；空＝查詢成功但唔存在；queryError 唔 null＝DB 故障。
 *
 * 覆蓋（對應交付驗收六項）：
 * (1) 在架商品 /products/85 → 200＋self canonical＋專屬 description＋真 HTML 商品摘要
 * (2) 已刪商品 /products/94 → 真 404 狀態＋noindex＋「搵唔到呢件商品」title
 * (3) 私人頁 /account、/cart → 200＋robots noindex, nofollow
 * (4) /products?category=top → canonical 係 /products，query 唔入 canonical
 * (5) /about 首口 HTML 含批准文案「影張相即刻試穿」「即刻睇到著上身效果」
 * (6) DB 查詢故障 → 商品頁照回 200，唔會被一時故障誤當 404 踢出索引
 */
import fs from "node:fs";
import { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock 1：serveStatic 唔派静态檔，全部落入 notFound fallback ──
vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

// ── mock 3：DB（rows 控制商品存在與否；queryError 模擬 DB 故障）──
let mockRows: unknown[] = [];
let queryError: Error | null = null;
vi.mock("../queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => (queryError ? Promise.reject(queryError) : Promise.resolve(mockRows)),
          orderBy: () => ({
            limit: () => (queryError ? Promise.reject(queryError) : Promise.resolve(mockRows)),
          }),
        }),
      }),
    }),
  }),
}));

import { serveStaticFiles } from "./vite";

// fixture：repo 真 index.html（module 頂用真 fs 預讀，唔經 mock 2 嘅 spy）
const TEMPLATE = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");

function makeApp() {
  const app = new Hono<{ Bindings: HttpBindings }>();
  serveStaticFiles(app);
  return app;
}

function makeProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: 85,
    sku: "SKU-067",
    name: "067",
    description: "星空閃石上衣，直播限定色，S/M/L 碼齊。",
    image: "/uploads/p85.jpg",
    photos: ["/uploads/p85.jpg"],
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
    createdAt: new Date("2026-10-01"),
    ...overrides,
  };
}

/** 模擬 Render 反向代理後面嘅訪客：handler 靠呢兩個 header 還原 https origin */
const PROXY_HEADERS = { "x-forwarded-proto": "https", "x-forwarded-host": "redcode.red" };

function canonicalHref(html: string): string | null {
  return html.match(/<link\s+rel="canonical"\s+href="([^"]*)"\s*\/>/)?.[1] ?? null;
}

beforeEach(() => {
  mockRows = [];
  queryError = null;
  // mock 2：攔截 handler 嘅 index.html read，回 fixture（每個 test 前裝，完即還原）
  vi.spyOn(fs, "readFileSync").mockImplementation(() => TEMPLATE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("serveStaticFiles — route-level（真 handler，mock DB／serveStatic／fs）", () => {
  it("(1) 在架商品 /products/85 → 200＋self canonical＋專屬 description＋noscript", async () => {
    mockRows = [makeProduct()];
    const res = await makeApp().request("/products/85", { headers: PROXY_HEADERS });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    // self canonical：指返自己（經 x-forwarded-* 還原 https://redcode.red）
    expect(canonicalHref(html)).toBe("https://redcode.red/products/85");
    // 商品專屬 meta description（唔係首頁通用嗰條）
    expect(html).toContain(
      '<meta name="description" content="星空閃石上衣，直播限定色，S/M/L 碼齊。" />',
    );
    expect(html).toContain("<title>067｜RedCode Fashion Design</title>");
    // server-rendered 真 HTML 商品摘要（唔行 JS 嘅 crawler 都直接讀到）
    expect(html).toContain('<main id="redcode-product-seo" data-redcode-prerender');
    expect(html).toContain("<h1>067</h1>");
    expect(html).toContain("<p>HK$199</p>");
    expect(html).not.toContain('id="redcode-public-seo"');
  });

  it("(1b) www／代理 host 入嚟都統一用 HTTPS apex canonical，唔會出第二個 self host", async () => {
    mockRows = [makeProduct()];
    const res = await makeApp().request("/products/85", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "www.redcode.red" },
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(canonicalHref(html)).toBe("https://redcode.red/products/85");
    expect(html).toContain('<meta property="og:url" content="https://redcode.red/products/85" />');
    expect(html).not.toContain("https://www.redcode.red/products/85");
  });

  it("(2) 已刪商品 /products/94 → 真 404＋noindex＋搵唔到商品 title（軟 404 根治）", async () => {
    mockRows = []; // DB 查詢成功、零行＝確定唔存在
    const res = await makeApp().request("/products/94", { headers: PROXY_HEADERS });
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<title>搵唔到呢件商品｜RedCode Fashion Design</title>");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
    // 唔准有商品專屬內容；404 亦唔應宣告自己等同首頁，所以移除首頁 canonical。
    expect(html).not.toContain("data-redcode-prerender");
    expect(canonicalHref(html)).toBeNull();
    expect(html).not.toContain('property="og:url"');
  });

  it("(2b) 超出 pg integer 嘅商品 ID → 直接真 404，唔會跌入 DB error 嘅 200 兜底", async () => {
    queryError = new Error("呢個 ID 唔應該查 DB");
    const res = await makeApp().request("/products/99999999999999999999", { headers: PROXY_HEADERS });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("搵唔到呢件商品");
    expect(canonicalHref(html)).toBeNull();
    expect(html).not.toContain('property="og:url"');
  });

  it("(3) 私人頁 /account 同 /cart → 200＋robots noindex, nofollow", async () => {
    for (const path of ["/account", "/orders", "/cart"]) {
      const res = await makeApp().request(path);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
      expect(html).not.toContain("index, follow");
      // noindex 保留，但唔再帶一條同內容唔相符嘅首頁 canonical／og:url。
      expect(canonicalHref(html)).toBeNull();
      expect(html).not.toContain('property="og:url"');
      expect(html.match(/name="robots"/g)).toHaveLength(1);
    }
  });

  it("(4) /products?category=top → canonical 係 /products，query 唔入 canonical", async () => {
    const res = await makeApp().request("/products?category=top");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(canonicalHref(html)).toBe("https://redcode.red/products");
    expect(html).toContain("<title>全部貨品｜RedCode Fashion Design</title>");
    // canonical 乾淨：成個 canonical tag 冇 query 痕跡
    const tag = html.match(/<link\s+rel="canonical"[^>]*\/>/)?.[0] ?? "";
    expect(tag).not.toContain("category");
    expect(tag).not.toContain("?");
    // 淨係一條 canonical
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
  });

  it("(4b) /products 首口 HTML 有真公開商品目錄；DB 故障保留通用摘要", async () => {
    mockRows = [makeProduct({ name: 'A"B & <C>' })];
    const res = await makeApp().request("/products");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('id="redcode-catalog-seo"');
    expect(html).toContain('<a href="/products/85"><strong>A&quot;B &amp; &lt;C&gt;</strong></a>');
    expect(html).toContain("（貨號 SKU-067）");
    expect(html).toContain("HK$199；有貨");
    expect(html).toContain('<div id="root"></div>');
    expect(html).not.toContain("<noscript");

    queryError = new Error("connection refused");
    const fallback = await (await makeApp().request("/products")).text();
    expect(fallback).toContain('id="redcode-public-seo"');
    expect(fallback).not.toContain('id="redcode-catalog-seo"');
  });

  it("(5) /about 首口 HTML 有批准文案「影張相即刻試穿」「即刻睇到著上身效果」", async () => {
    const res = await makeApp().request("/about");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("影張相即刻試穿");
    expect(html).toContain("即刻睇到著上身效果");
    expect(html).toContain("<title>關於我們｜RedCode Fashion Design</title>");
    expect(canonicalHref(html)).toBe("https://redcode.red/about");
  });

  it("(7) /products?liveDate=20261028（有效全日）→ 全日專屬 meta＋該日真商品首口目錄", async () => {
    mockRows = [makeProduct({ name: "全日直播真商品", liveDate: "20261028" })];
    const res = await makeApp().request("/products?liveDate=20261028");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>2026年10月28日 全日直播商品｜RedCode Fashion Design</title>");
    expect(html).toContain("全日全部場次");
    expect(canonicalHref(html)).toBe("https://redcode.red/products?liveDate=20261028");
    expect(html).toContain("<h2>2026年10月28日 全日直播商品</h2>");
    expect(html).toContain('<a href="/products/85"><strong>全日直播真商品</strong></a>');
    // og:image 保留 index.html 預設嗰張（直播頁冇專屬圖）
    expect(html).toContain('<meta property="og:image" content="https://redcode.red/og-image.jpg" />');
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
  });

  it("(8) /products?liveDate=20261028&liveSession=2（有效單場）→ 單場 meta＋真商品＋escaped canonical", async () => {
    mockRows = [makeProduct({ name: "第2場直播真商品", liveDate: "20261028", liveSession: "2" })];
    const res = await makeApp().request("/products?liveDate=20261028&liveSession=2");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      "<title>2026年10月28日 第2場直播商品｜RedCode Fashion Design</title>",
    );
    expect(html).toContain("即睇直播商品");
    expect(canonicalHref(html)).toBe(
      "https://redcode.red/products?liveDate=20261028&amp;liveSession=2",
    );
    // og:url 同 canonical 一致（都要 escape）
    expect(html).toContain(
      '<meta property="og:url" content="https://redcode.red/products?liveDate=20261028&amp;liveSession=2" />',
    );
    expect(html).toContain("<h2>2026年10月28日 第2場直播商品</h2>");
    expect(html).toContain("第2場直播真商品");
  });

  it("(8b) live+category URL 係完整直播頁嘅篩選視圖；canonical 合併去完整場次，首口仍出該場商品", async () => {
    mockRows = [makeProduct({ name: "場次商品", liveDate: "20261028", liveSession: "2", category: "top" })];
    const res = await makeApp().request("/products?category=top&liveDate=20261028&liveSession=2");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(canonicalHref(html)).toBe("https://redcode.red/products?liveDate=20261028&amp;liveSession=2");
    expect(html).toContain("場次商品");
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
  });

  it("(9) 無效日期 /products?liveDate=20261340 → 通用 /products meta，絕不反射輸入", async () => {
    const res = await makeApp().request("/products?liveDate=20261340");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>全部貨品｜RedCode Fashion Design</title>");
    expect(canonicalHref(html)).toBe("https://redcode.red/products");
    // canonical／og:title／title 全部唔准出現無效日期
    const canonicalTag = html.match(/<link\s+rel="canonical"[^>]*\/>/)?.[0] ?? "";
    expect(canonicalTag).not.toContain("20261340");
    expect(html).not.toContain("2026年13月40日");
  });

  it("(10) 無效場次 /products?liveDate=20261028&liveSession=abc → 通用 /products，abc 唔入 meta", async () => {
    const res = await makeApp().request("/products?liveDate=20261028&liveSession=abc");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>全部貨品｜RedCode Fashion Design</title>");
    expect(canonicalHref(html)).toBe("https://redcode.red/products");
    expect(html).not.toContain("liveSession=abc");
    expect(html).not.toContain("第abc場");
  });

  it("(11) /faq → 獨立 meta／self canonical＋19 條無 JS 問答同內部連結", async () => {
    const res = await makeApp().request("/faq");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>常見問題｜RedCode Fashion Design</title>");
    expect(canonicalHref(html)).toBe("https://redcode.red/faq");
    expect(html).toContain('id="redcode-public-seo"');
    expect(html).toContain("AI 試穿點玩？");
    expect(html).toContain("用 WhatsApp 分享試穿結果安全嗎？");
    expect(html).toContain('<a href="/try-on">AI 試穿</a>');
    expect(html).toContain("index, follow");
  });

  it("(12) /returns 同 /try-on → 各自 self canonical，唔再指向首頁", async () => {
    for (const path of ["/returns", "/try-on"]) {
      const res = await makeApp().request(path);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(canonicalHref(html)).toBe(`https://redcode.red${path}`);
      expect(html).toContain('id="redcode-public-seo"');
      expect(html).toContain("index, follow");
    }
    const tryOn = await makeApp().request("/try-on");
    expect(await tryOn.text()).toContain("<title>AI 試穿｜RedCode Fashion Design</title>");
  });

  it("(12b) AI 試穿商品 query 係同一工具頁視圖，canonical 合併去 /try-on", async () => {
    const res = await makeApp().request("/try-on?productId=251&photoIndex=0");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(canonicalHref(html)).toBe("https://redcode.red/try-on");
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).not.toContain("productId=251");
  });

  it("(13) 有時限試穿分享同私人工具頁 → noindex，query token 唔反射入 HTML", async () => {
    for (const path of [
      "/try-on/shared/private-id?e=2099999999&s=secret-token",
      "/try-on/history",
      "/guest-checkout",
      "/guest-payment",
      "/wallet-topup",
    ]) {
      const res = await makeApp().request(path);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
      expect(html).not.toContain("secret-token");
      expect(html).not.toContain('id="redcode-public-seo"');
    }
  });

  it("(14) 未知路由 → 真 404＋noindex＋NotFound 文案，唔再回 200 首頁", async () => {
    const res = await makeApp().request("/seo-audit-nonexistent-20261101");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("<title>搵唔到呢頁｜RedCode Fashion Design</title>");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(html).not.toContain('id="redcode-public-seo"');
    expect(canonicalHref(html)).toBeNull();
    expect(html).not.toContain('property="og:url"');
  });

  it("(14b) /lucky-results 總頁首口列真公開活動連結，唔再只有通用摘要", async () => {
    mockRows = [{ id: 12, name: "雙十一．壓軸狂歡", scheduledDrawDate: "20261111" }];
    const res = await makeApp().request("/lucky-results");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(canonicalHref(html)).toBe("https://redcode.red/lucky-results");
    expect(html).toContain('id="redcode-lucky-event-index"');
    expect(html).toContain('<a href="/lucky-results/12">《雙十一．壓軸狂歡》中獎公告</a>');
  });

  it("(15) 公開 /lucky-results/12 → 活動名獨立標題、self canonical＋該場公開摘要", async () => {
    mockRows = [{ id: 12, name: "雙十一．壓軸狂歡", scheduledDrawDate: "20261111" }];
    const res = await makeApp().request("/lucky-results/12");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>《雙十一．壓軸狂歡》中獎名單｜RedCode Fashion Design</title>");
    expect(canonicalHref(html)).toBe("https://redcode.red/lucky-results/12");
    expect(html).toContain("<h1>《雙十一．壓軸狂歡》中獎公告</h1>");
    expect(html).toContain("預定抽獎日：2026-11-11");
    expect(html).not.toMatch(/winnerName|holderName|ticketCount/i);
  });

  it("(15b) 未公開／唔存在嘅單場公告 → 真 404＋noindex＋無首頁 canonical", async () => {
    mockRows = [];
    const res = await makeApp().request("/lucky-results/999");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("中獎公告未公開或唔存在");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(canonicalHref(html)).toBeNull();
    expect(html).not.toContain('property="og:url"');
    expect(html).not.toContain("data-redcode-prerender");
  });

  it("(15d) 超出 pg integer 嘅活動 ID → 真 404，唔會誤用 DB error 通用 200", async () => {
    queryError = new Error("呢個 ID 唔應該查 DB");
    const res = await makeApp().request("/lucky-results/99999999999999999999");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("中獎公告未公開或唔存在");
    expect(canonicalHref(html)).toBeNull();
    expect(html).not.toContain('property="og:url"');
  });

  it("(15c) 單場公告 DB 故障 → 通用 200，唔好將可能公開嘅活動誤當 404", async () => {
    queryError = new Error("connection refused");
    const res = await makeApp().request("/lucky-results/12");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>中獎名單｜RedCode Fashion Design</title>");
    expect(canonicalHref(html)).toBe("https://redcode.red/lucky-results/12");
  });

  it("(17) /lucky-tickets/12 → 200＋專屬 title/description＋self canonical＋noindex；零參加者資料", async () => {
    // mockRows 預設 []——呢條路由根本唔查 DB（唔存在查詢成功與否嘅分叉）
    const res = await makeApp().request("/lucky-tickets/12");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    // title／description 同 src/lib/seo.ts PAGE_SEO['/lucky-tickets/:eventId'] 逐字一致
    expect(html).toContain("<title>抽獎劵查詢｜RedCode Fashion Design</title>");
    expect(html).toContain(
      '<meta name="description" content="RedCode 公開抽獎劵查詢——輸入完整姓名查自己有幾張抽獎劵；呢頁唔會公開參加者名單。" />',
    );
    // self canonical 指返自己；noindex, nofollow（唔入搜尋索引）
    expect(canonicalHref(html)).toBe("https://redcode.red/lucky-tickets/12");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(html).not.toContain("index, follow");
    // 私隱邊界：唔注入公開摘要區塊／商品 prerender／任何活動名、參加者名單、winner 或劵數
    expect(html).not.toContain('id="redcode-public-seo"');
    expect(html).not.toContain("data-redcode-prerender");
    expect(html).not.toMatch(/holderName|winnerName|ticketCount|winnersPublic/i);
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
  });

  it("(17b) /lucky-tickets/12/（尾斜線）→ 一樣 200，canonical 唔帶尾斜線", async () => {
    const res = await makeApp().request("/lucky-tickets/12/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>抽獎劵查詢｜RedCode Fashion Design</title>");
    expect(canonicalHref(html)).toBe("https://redcode.red/lucky-tickets/12");
  });

  it("(18) /lucky-tickets/abc（非數字 id）→ 真 404＋noindex，唔准變軟 404", async () => {
    const res = await makeApp().request("/lucky-tickets/abc");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("<title>搵唔到呢頁｜RedCode Fashion Design</title>");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(html).not.toContain("抽獎劵查詢");
  });

  it("(16) /llms.txt 回應帶 X-Robots-Tag: noindex（静态檔存在與否由部署驗收）", async () => {
    const res = await makeApp().request("/llms.txt");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("(6) DB 查詢故障 → 商品頁照回 200 原 HTML，在架商品唔會被誤當 404", async () => {
    queryError = new Error("connection refused");
    const res = await makeApp().request("/products/85", { headers: PROXY_HEADERS });
    expect(res.status).toBe(200);
    const html = await res.text();
    // 唔准出 404 頁訊號；原 HTML（首頁預設 title/canonical/robots）照出
    expect(html).not.toContain("搵唔到呢件商品");
    expect(html).not.toContain("noindex");
    expect(canonicalHref(html)).toBe("https://redcode.red/");
  });
});
