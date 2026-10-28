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
 * (1) 在架商品 /products/85 → 200＋self canonical＋專屬 description＋noscript
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
    // server-rendered noscript 商品摘要（唔行 JS 嘅 crawler 讀到真內容）
    expect(html).toContain("<noscript><h1>067</h1>");
    expect(html).toContain("<p>HK$199</p>");
  });

  it("(2) 已刪商品 /products/94 → 真 404＋noindex＋搵唔到商品 title（軟 404 根治）", async () => {
    mockRows = []; // DB 查詢成功、零行＝確定唔存在
    const res = await makeApp().request("/products/94", { headers: PROXY_HEADERS });
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<title>搵唔到呢件商品｜RedCode Fashion Design</title>");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
    // 唔准有商品專屬內容／self canonical（軟 404 訊號清零）
    expect(html).not.toContain("<noscript>");
    expect(canonicalHref(html)).toBe("https://redcode.red/");
  });

  it("(3) 私人頁 /account 同 /cart → 200＋robots noindex, nofollow", async () => {
    for (const path of ["/account", "/cart"]) {
      const res = await makeApp().request(path);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
      expect(html).not.toContain("index, follow");
      // noindex 唔附帶 title/canonical 改動（照預設首頁版）
      expect(canonicalHref(html)).toBe("https://redcode.red/");
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

  it("(5) /about 首口 HTML 有批准文案「影張相即刻試穿」「即刻睇到著上身效果」", async () => {
    const res = await makeApp().request("/about");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("影張相即刻試穿");
    expect(html).toContain("即刻睇到著上身效果");
    expect(html).toContain("<title>關於我們｜RedCode Fashion Design</title>");
    expect(canonicalHref(html)).toBe("https://redcode.red/about");
  });

  it("(7) /products?liveDate=20261028（有效全日）→ 全日專屬 title/description/canonical", async () => {
    const res = await makeApp().request("/products?liveDate=20261028");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>2026年10月28日 全日直播商品｜RedCode Fashion Design</title>");
    expect(html).toContain("全日全部場次");
    expect(canonicalHref(html)).toBe("https://redcode.red/products?liveDate=20261028");
    // og:image 保留 index.html 預設嗰張（直播頁冇專屬圖）
    expect(html).toContain('<meta property="og:image" content="https://redcode.red/og-image.jpg" />');
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
  });

  it("(8) /products?liveDate=20261028&liveSession=2（有效單場）→ 單場 meta＋escaped canonical", async () => {
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
