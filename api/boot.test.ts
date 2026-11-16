/**
 * Sitemap／RSS 路由測試（v2026.11.15 sitemap index 分區）——真 Hono app
 * （api/boot.ts default export），**唔掂真 DB、唔起 server**：getDb 用 chainable stub，
 * gloGuidePublic 公開查詢用 vi.mock 注入，逐段查詢獨立控制成功／失敗。
 *
 * 舊有 /sitemap.xml 商品／上架閘測試全部保留，改打 /sitemap-fashion.xml
 * （原本公開靜態頁＋公開商品邏輯一字不變搬咗入呢個 child sitemap）：
 * (1) 商品 URL 帶真 contentUpdatedAt 做 lastmod（listedDate 上架日唔再冒充修改日）；
 *     無效／缺失日期唔出 lastmod（唔放假日期）；靜態頁／直播／公告 URL 永遠冇 lastmod
 * (2) 直播全日／單場 URL 由公開商品嘅真 liveDate/liveSession 得出，query 正確 escape
 * (3) 同一 URL 全表去重（重複場次／同商品頁撞 URL 都只出一次）
 * (4) 直播查詢失敗唔拖垮已成功嘅商品 URL（反之亦然）
 * (5) 只有 winnersPublic=true 嘅公開中獎公告入 sitemap；查劵 URL 永不入
 * (6) 全部 DB 失敗都唔 500，照出首頁＋靜態頁
 * 新增：
 * (9)  /sitemap.xml 係 sitemap index，列出三個 child，唔出 <urlset>／<lastmod>
 * (10) /sitemap-web-design.xml 只列公開 /web-design；私人單據 URL 永不入
 * (11) /sitemap-glo-guide.xml published-only（真 updatedAt 做 lastmod）；
 *      DB 故障照 200 出總覽-only urlset，唔 500
 * (12) /glo-guide/feed.xml 係合法 RSS 2.0，published-only——中途變非 published 嘅
 *      文章唔出現；列表查詢失敗回 500，唔出假成功空 feed
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { GuideDetail, GuideListItem } from "@contracts/gloGuide";

// ── mock DB：sitemap handler 依序用 select（商品）→ selectDistinct（直播）→ select（公告）──
const h = vi.hoisted(() => {
  const state = {
    // 每段查詢嘅結果：Error＝reject（DB 故障）；陣列＝resolve rows
    products: [] as unknown[] | Error,
    live: [] as unknown[] | Error,
    events: [] as unknown[] | Error,
    // handler 內 select 呼叫次序固定：商品先、公告後（中間係 selectDistinct）
    selectCount: 0,
  };
  const settle = (v: unknown[] | Error) =>
    v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  return {
    state,
    db: () => ({
      select: () => ({
        from: () => ({
          // 商品同公告查詢都係 where 之後直接 await
          where: () => settle(state.selectCount++ === 0 ? state.products : state.events),
        }),
      }),
      selectDistinct: () => ({
        from: () => ({
          where: () => settle(state.live),
        }),
      }),
    }),
  };
});

import { resetLuckyAnnouncementPublicCache } from "./lib/luckyAnnouncementVisibility";

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    ...h.db(),
    query: {
      siteSettings: {
        // v2026.11.11.2：對外公告總開關設定（(h.state as any).announcement；Error＝讀取失敗；null＝唔存在＝預設關閉）
        findFirst: () =>
          (h.state as any).announcement instanceof Error
            ? Promise.reject((h.state as any).announcement)
            : Promise.resolve((h.state as any).announcement ?? null),
      },
    },
  }),
}));

// Glo Glo 指南公開查詢：sitemap-glo-guide child 同 RSS feed 都經佢哋，
// 呢度 mock 到實——測試可以證明路由只食 published 公開查詢嘅結果。
// guideList：Error＝reject（DB 故障）；陣列＝published 列表。bySlug 回 null＝中途變非 published。
const g = vi.hoisted(() => ({
  guideList: [] as GuideListItem[] | Error,
  guideBySlug: new Map<string, GuideDetail | null>(),
  listCalls: [] as number[],
}));
vi.mock("./gloGuidePublic", async (importOriginal) => {
  // partial mock：保留 gloGuidePublicRouter 等真 export（api/router.ts 要用），
  // 只攔截兩個公開查詢函數
  const actual = await importOriginal<typeof import("./gloGuidePublic")>();
  return {
    ...actual,
    listPublishedGuides: (limit?: number) => {
      g.listCalls.push(limit ?? -1);
      return g.guideList instanceof Error
        ? Promise.reject(g.guideList)
        : Promise.resolve(g.guideList);
    },
    listPublishedGuideSitemapRows: () => {
      g.listCalls.push(-2);
      return g.guideList instanceof Error
        ? Promise.reject(g.guideList)
        : Promise.resolve(g.guideList.map(({ slug, updatedAt }) => ({ slug, updatedAt })));
    },
    getPublishedGuideBySlug: (slug: string) =>
      Promise.resolve(g.guideBySlug.has(slug) ? (g.guideBySlug.get(slug) ?? null) : null),
  };
});

import app from "./boot";

beforeEach(() => {
  h.state.products = [];
  h.state.live = [];
  h.state.events = [];
  h.state.selectCount = 0;
  // v2026.11.11.2：沿用舊測試假設公告公開（總開關開）；關閉情境由新測試逐個改 null/Error。
  (h.state as any).announcement = { key: "lucky_announcement_public", value: "true" };
  g.guideList = [];
  g.guideBySlug = new Map();
  g.listCalls = [];
  resetLuckyAnnouncementPublicCache();
});

async function getSitemap(): Promise<{ status: number; xml: string }> {
  const res = await app.request("/sitemap-fashion.xml");
  return { status: res.status, xml: await res.text() };
}

/** 結構性 XML 檢查：urlset 包裝完整、url 標籤配對、每個 lastmod 都係合法 ISO 日期字串 */
function expectWellFormedUrlset(xml: string) {
  expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  expect(xml.trim().endsWith("</urlset>")).toBe(true);
  expect(xml.match(/<url>/g)?.length ?? 0).toBe(xml.match(/<\/url>/g)?.length ?? 0);
  for (const m of xml.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)) {
    expect(m[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(m[1]).toISOString()).toBe(m[1]); // parse 完原樣＝合法 ISO
  }
}

/** 抽出每條 <url> 嘅 loc 同有冇 lastmod（靜態斷言 lastmod 只屬於商品 URL 用） */
function urlEntries(xml: string): { loc: string; lastmod: string | null }[] {
  return [...xml.matchAll(/<url><loc>([^<]+)<\/loc>([\s\S]*?)<\/url>/g)].map((m) => ({
    loc: m[1],
    lastmod: m[2].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] ?? null,
  }));
}

describe("/sitemap-fashion.xml", () => {
  it("(1)(2) 商品 URL 帶真 contentUpdatedAt lastmod（精確 ISO）；直播全日／單場 URL 入 sitemap 兼正確 escape", async () => {
    h.state.products = [
      { id: 85, contentUpdatedAt: new Date("2026-11-01T08:30:00.000Z") },
      { id: 251, contentUpdatedAt: "2026-11-05T12:00:00.000Z" },
    ];
    h.state.live = [
      { liveDate: "20261111", liveSession: null },
      { liveDate: "20261111", liveSession: "1" },
    ];
    const { status, xml } = await getSitemap();
    expect(status).toBe(200);
    expectWellFormedUrlset(xml);
    // 真實產品修改日期原樣出現（Date 同 ISO 字串兩種 driver 形態都支援）
    expect(xml).toContain(
      "<url><loc>https://redcode.red/products/85</loc><lastmod>2026-11-01T08:30:00.000Z</lastmod><priority>0.8</priority></url>",
    );
    expect(xml).toContain(
      "<url><loc>https://redcode.red/products/251</loc><lastmod>2026-11-05T12:00:00.000Z</lastmod><priority>0.8</priority></url>",
    );
    expect(xml).toContain("<loc>https://redcode.red/products?liveDate=20261111</loc>");
    expect(xml).toContain(
      "<loc>https://redcode.red/products?liveDate=20261111&amp;liveSession=1</loc>",
    );
    // raw 未 escape 嘅 & 唔准出現喺 XML loc
    expect(xml).not.toContain("liveDate=20261111&liveSession");
  });

  it("(1b) 無效／缺失 contentUpdatedAt → 商品 URL 保留但唔出 lastmod（唔放假日期、唔用 listedDate 頂）", async () => {
    h.state.products = [
      { id: 85, contentUpdatedAt: "not-a-date" },
      { id: 86, contentUpdatedAt: null },
      { id: 87 }, // 欄缺失
    ];
    const { status, xml } = await getSitemap();
    expect(status).toBe(200);
    expectWellFormedUrlset(xml);
    for (const id of [85, 86, 87]) {
      expect(xml).toContain(`<loc>https://redcode.red/products/${id}</loc>`);
    }
    // 全部商品日期無效 → 成張 sitemap 一個 lastmod 都唔准有
    expect(xml).not.toContain("<lastmod>");
    expect(urlEntries(xml).every((e) => e.lastmod === null)).toBe(true);
  });

  it("(1c) lastmod 只屬於商品 URL：首頁／靜態頁／直播／公告 URL 一律冇；URL 集合唔變", async () => {
    h.state.products = [{ id: 85, contentUpdatedAt: new Date("2026-11-01T00:00:00.000Z") }];
    h.state.live = [{ liveDate: "20261111", liveSession: "1" }];
    h.state.events = [{ id: 12 }];
    const { xml } = await getSitemap();
    expectWellFormedUrlset(xml);
    const entries = urlEntries(xml);
    expect(entries.length).toBeGreaterThan(0);
    // 有 lastmod 嘅全部係 /products/:id 商品頁
    const withLastmod = entries.filter((e) => e.lastmod !== null);
    expect(withLastmod).toEqual([
      { loc: "https://redcode.red/products/85", lastmod: "2026-11-01T00:00:00.000Z" },
    ]);
    // 首頁／靜態頁／直播 query／公告頁全部冇 lastmod（冇可靠內容時間唔放假日期）
    for (const e of entries.filter((e) => e.lastmod === null)) {
      expect(e.loc).not.toMatch(/\/products\/\d+$/);
    }
    expect(entries.some((e) => e.loc === "https://redcode.red/")).toBe(true);
    expect(entries.some((e) => e.loc === "https://redcode.red/products")).toBe(true);
    expect(
      entries.some((e) => e.loc === "https://redcode.red/products?liveDate=20261111&amp;liveSession=1"),
    ).toBe(true);
    expect(entries.some((e) => e.loc === "https://redcode.red/lucky-results/12")).toBe(true);
  });

  it("(3) 同一 URL 去重：重複場次／同靜態頁撞車都只出一次", async () => {
    h.state.products = [{ id: 85 }];
    h.state.live = [
      { liveDate: "20261111", liveSession: "1" },
      { liveDate: "20261111", liveSession: "1" },
      { liveDate: "20261111", liveSession: null },
      { liveDate: "20261111", liveSession: null },
    ];
    const { xml } = await getSitemap();
    expect(xml.match(/liveSession=1/g)).toHaveLength(1);
    expect(xml.match(/liveDate=20261111<\/loc>/g)).toHaveLength(1);
    expect(xml.match(/<loc>https:\/\/redcode\.red\/products<\/loc>/g)).toHaveLength(1);
    expect(xml.match(/<loc>https:\/\/redcode\.red\/<\/loc>/g)).toHaveLength(1);
  });

  it("(3b) DB 落嚟嘅非法直播值（假日曆日期／非數字場次）唔入 sitemap", async () => {
    h.state.live = [
      { liveDate: "20261340", liveSession: null },
      { liveDate: "20261111", liveSession: "abc" },
      { liveDate: "20261111", liveSession: "2" },
    ];
    const { xml } = await getSitemap();
    expect(xml).not.toContain("20261340");
    expect(xml).not.toContain("liveSession=abc");
    expect(xml).toContain("liveSession=2");
  });

  it("(4) 直播查詢失敗唔拖垮商品 URL；商品失敗都仲有直播 URL", async () => {
    h.state.products = [{ id: 85 }];
    h.state.live = new Error("live query connection refused");
    const failedLive = await getSitemap();
    expect(failedLive.status).toBe(200);
    expect(failedLive.xml).toContain("/products/85");
    expect(failedLive.xml).not.toContain("liveDate=");

    h.state.products = new Error("products query connection refused");
    h.state.live = [{ liveDate: "20261111", liveSession: "1" }];
    const failedProducts = await getSitemap();
    expect(failedProducts.status).toBe(200);
    expect(failedProducts.xml).not.toContain("/products/85");
    expect(failedProducts.xml).toContain("liveSession=1");
    expect(failedProducts.xml).toContain("<loc>https://redcode.red/</loc>");
  });

  it("(5) 得 winnersPublic=true 嘅公告入 sitemap；查劵 URL 永不入", async () => {
    h.state.events = [{ id: 12 }, { id: 12 }, { id: 7 }];
    const { xml } = await getSitemap();
    expect(xml.match(/<loc>https:\/\/redcode\.red\/lucky-results\/12<\/loc>/g)).toHaveLength(1);
    expect(xml).toContain("<loc>https://redcode.red/lucky-results/7</loc>");
    expect(xml).not.toContain("/lucky-tickets/");
  });

  it("(6) 全部 DB 查詢失敗 → 200 淨首頁＋靜態頁，唔 500", async () => {
    h.state.products = new Error("down");
    h.state.live = new Error("down");
    h.state.events = new Error("down");
    const { status, xml } = await getSitemap();
    expect(status).toBe(200);
    expect(xml).toContain("<loc>https://redcode.red/</loc>");
    expect(xml).toContain("<loc>https://redcode.red/products</loc>");
    expect(xml).toContain("<loc>https://redcode.red/live</loc>");
    expect(xml).not.toContain("/products/8");
    expect(xml).not.toContain("liveDate=");
    expect(xml).not.toContain("/lucky-results/1");
  });

  it("(7) 總開關設定不存在＝預設關閉：總覽同所有單場公告都唔入 sitemap", async () => {
    (h.state as any).announcement = null;
    h.state.products = [{ id: 85 }];
    h.state.live = [{ liveDate: "20261111", liveSession: "1" }];
    h.state.events = [{ id: 12 }];
    const { status, xml } = await getSitemap();
    expect(status).toBe(200);
    expect(xml).toContain("/products/85");
    expect(xml).toContain("liveSession=1");
    expect(xml).not.toContain("/lucky-results");
    expect(xml).not.toContain("/lucky-tickets/");
  });

  it("(8) 總開關讀取失敗都 fail-closed：唔 500，亦唔留總覽或單場公告 URL", async () => {
    (h.state as any).announcement = new Error("settings down");
    h.state.events = [{ id: 12 }];
    const { status, xml } = await getSitemap();
    expect(status).toBe(200);
    expect(xml).toContain("<loc>https://redcode.red/</loc>");
    expect(xml).not.toContain("/lucky-results");
    expect(xml).not.toContain("/lucky-tickets/");
  });

  it("(8b) B2B 分區唔混入女裝 child：fashion 明確過濾 /web-design（避免同獨立 child 重複列出）", async () => {
    h.state.products = [{ id: 85 }];
    const { status, xml } = await getSitemap();
    expect(status).toBe(200);
    expect(xml).not.toContain("/web-design");
    // 其他公開靜態頁照舊
    expect(xml).toContain("<loc>https://redcode.red/products</loc>");
    expect(xml).toContain("<loc>https://redcode.red/products/85</loc>");
  });
});

// ── sitemap index 分區＋Glo Guide child／RSS（v2026.11.15 新增）──────────────────

const guideItem = (slug: string, over: Partial<GuideListItem> = {}): GuideListItem => ({
  id: 1,
  slug,
  title: `指南 ${slug}`,
  excerpt: "摘要",
  theme: "轉季",
  publishedAt: "2026-02-20T10:00:00.000Z",
  updatedAt: "2026-02-21T10:00:00.000Z",
  coverImage: null,
  images: [],
  products: [],
  ...over,
});
const guideDetail = (slug: string): GuideDetail => ({
  ...guideItem(slug),
  body: `正文 ${slug} 第一段。\n\n第二段。`,
  images: [],
  modelImage: null,
});

describe("/sitemap.xml（sitemap index）", () => {
  it("(9) 列出三個 child sitemap；唔出 <urlset>，冇真數據唔放假 lastmod", async () => {
    const res = await app.request("/sitemap.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const xml = await res.text();
    expect(xml).toContain("<sitemapindex xmlns=");
    expect(xml).toContain("<loc>https://redcode.red/sitemap-fashion.xml</loc>");
    expect(xml).toContain("<loc>https://redcode.red/sitemap-glo-guide.xml</loc>");
    expect(xml).toContain("<loc>https://redcode.red/sitemap-web-design.xml</loc>");
    expect(xml).not.toContain("<urlset");
    expect(xml).not.toContain("<lastmod>");
  });
});

describe("/sitemap-web-design.xml", () => {
  it("(10) B2B 分區只列公開 /web-design 主頁一條；有時限私人單據 URL 永不入", async () => {
    const res = await app.request("/sitemap-web-design.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const xml = await res.text();
    expect(xml).toContain("<urlset xmlns=");
    expect(xml).toContain("<loc>https://redcode.red/web-design</loc>");
    // 主頁係唯一一條 url
    expect(xml.match(/<url>/g)).toHaveLength(1);
    expect(xml).not.toContain("web-design-bill");
    // 唔會混入女裝購物內容
    expect(xml).not.toContain("/products");
  });
});

describe("/sitemap-glo-guide.xml", () => {
  it("(11a) published-only：只經 listPublishedGuides 公開查詢，lastmod 用真 updatedAt", async () => {
    g.guideList = [guideItem("spring"), guideItem("summer")];
    const res = await app.request("/sitemap-glo-guide.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-cache");
    const xml = await res.text();
    expect(xml).toContain("<urlset xmlns=");
    expect(xml).toContain("<loc>https://redcode.red/glo-guide</loc>");
    expect(xml).toContain("<loc>https://redcode.red/glo-guide/spring</loc>");
    expect(xml).toContain("<loc>https://redcode.red/glo-guide/summer</loc>");
    expect(xml).toContain("<lastmod>2026-02-21T10:00:00.000Z</lastmod>");
    // 路由數據來源證明：打嘅係全部 published 嘅輕量 sitemap 查詢，唔係最新 50 篇列表
    expect(g.listCalls).toContain(-2);
  });

  it("(11b) DB 故障照 200 出總覽-only urlset，唔 500 亦唔放假 URL", async () => {
    g.guideList = new Error("db down");
    const res = await app.request("/sitemap-glo-guide.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-cache");
    const xml = await res.text();
    expect(xml).toContain("<loc>https://redcode.red/glo-guide</loc>");
    expect(xml).not.toContain("/glo-guide/spring");
  });
});

describe("/glo-guide/feed.xml", () => {
  it("(12a) published-only：bySlug 回 null（中途變非 published）嘅文章唔入 feed", async () => {
    g.guideList = [guideItem("live-one"), guideItem("gone-draft")];
    g.guideBySlug = new Map([
      ["live-one", guideDetail("live-one")],
      ["gone-draft", null], // 列表之後被撤回／改狀態
    ]);
    const res = await app.request("/glo-guide/feed.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    const xml = await res.text();
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain(
      '<atom:link href="https://redcode.red/glo-guide/feed.xml" rel="self"',
    );
    expect(xml).toContain("<link>https://redcode.red/glo-guide/live-one</link>");
    expect(xml).toContain('<guid isPermaLink="true">https://redcode.red/glo-guide/live-one</guid>');
    expect(xml).toContain("<dc:creator>Glo Glo</dc:creator>");
    expect(xml).not.toContain("gone-draft");
  });

  it("(12b) 列表查詢失敗 → 500，唔出假成功空 feed", async () => {
    g.guideList = new Error("db down");
    const res = await app.request("/glo-guide/feed.xml");
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("<rss");
    expect(body).not.toContain("<channel>");
  });

  it("(12c) 空列表照出合法空 channel（200，唔係假資料）", async () => {
    g.guideList = [];
    const res = await app.request("/glo-guide/feed.xml");
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<channel>");
    expect(xml).not.toContain("<item>");
  });
});
