/**
 * /sitemap.xml 測試（v2026.11.11）——真 Hono app（api/boot.ts default export），
 * **唔掂真 DB、唔起 server**：getDb 用 chainable stub，逐段查詢獨立控制成功／失敗。
 *
 * 覆蓋：
 * (1) 商品 URL 唔再有 lastmod（listedDate 係上架日，唔係內容最後修改日）
 * (2) 直播全日／單場 URL 由公開商品嘅真 liveDate/liveSession 得出，query 正確 escape
 * (3) 同一 URL 全表去重（重複場次／同商品頁撞 URL 都只出一次）
 * (4) 直播查詢失敗唔拖垮已成功嘅商品 URL（反之亦然）
 * (5) 只有 winnersPublic=true 嘅公開中獎公告入 sitemap；查劵 URL 永不入
 * (6) 全部 DB 失敗都唔 500，照出首頁＋靜態頁
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

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

import app from "./boot";

beforeEach(() => {
  h.state.products = [];
  h.state.live = [];
  h.state.events = [];
  h.state.selectCount = 0;
  // v2026.11.11.2：沿用舊測試假設公告公開（總開關開）；關閉情境由新測試逐個改 null/Error。
  (h.state as any).announcement = { key: "lucky_announcement_public", value: "true" };
  resetLuckyAnnouncementPublicCache();
});

async function getSitemap(): Promise<{ status: number; xml: string }> {
  const res = await app.request("/sitemap.xml");
  return { status: res.status, xml: await res.text() };
}

describe("/sitemap.xml", () => {
  it("(1)(2) 商品 URL 冇 lastmod；直播全日／單場 URL 入 sitemap 兼正確 escape", async () => {
    h.state.products = [{ id: 85 }, { id: 251 }];
    h.state.live = [
      { liveDate: "20261111", liveSession: null },
      { liveDate: "20261111", liveSession: "1" },
    ];
    const { status, xml } = await getSitemap();
    expect(status).toBe(200);
    expect(xml).toContain("<loc>https://redcode.red/products/85</loc>");
    expect(xml).toContain("<loc>https://redcode.red/products/251</loc>");
    // lastmod 移除：listedDate 唔可以冒充內容最後修改日
    expect(xml).not.toContain("<lastmod>");
    expect(xml).toContain("<loc>https://redcode.red/products?liveDate=20261111</loc>");
    expect(xml).toContain(
      "<loc>https://redcode.red/products?liveDate=20261111&amp;liveSession=1</loc>",
    );
    // raw 未 escape 嘅 & 唔准出現喺 XML loc
    expect(xml).not.toContain("liveDate=20261111&liveSession");
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
});
