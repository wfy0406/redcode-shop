/**
 * PAGE_SEO／resolveSeo 測試（2026-10-27 Search Console 修復）。
 *
 * 驗證：
 * 1) 老闆批准嘅 AI 試穿文案「影張相即刻試穿」「即刻睇到著上身效果」有入首頁／關於我哋
 *    嘅公開 SEO description（同 server 側 api/lib/vite.ts ROUTE_SEO 一致——測試直接對照源碼）。
 * 2) 每頁 title/description 唯一（duplicate title/description 係 Search Console 常見警告）。
 * 3) resolveSeo 路由對應：/products/:id 動態段、私人頁、未知路由 fallback。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { liveRouteMeta } from "../../api/lib/liveSeo";
import { isNoIndexPath, NOT_FOUND_SEO, PAGE_SEO, resolveCanonicalPath, resolveSeo } from "./seo";

const PHRASE_TRYON = "影張相即刻試穿";
const PHRASE_EFFECT = "即刻睇到著上身效果";

describe("PAGE_SEO 文案", () => {
  it("首頁 description 含兩句批准文案", () => {
    expect(PAGE_SEO["/"].description).toContain(PHRASE_TRYON);
    expect(PAGE_SEO["/"].description).toContain(PHRASE_EFFECT);
  });

  it("/about description 含兩句批准文案，且同 server ROUTE_SEO 一致", () => {
    expect(PAGE_SEO["/about"].description).toContain(PHRASE_TRYON);
    expect(PAGE_SEO["/about"].description).toContain(PHRASE_EFFECT);
    // server 首口 HTML（crawler 睇）同 client 轉頁後嘅 meta 必須一致，唔係會有兩個版本
    const serverSeoSrc = readFileSync(new URL("../../api/lib/publicSeo.ts", import.meta.url), "utf8");
    expect(serverSeoSrc).toContain(PAGE_SEO["/about"].description);
  });

  it("網站設計頁前端同 server 首口 SEO 一致，而且可公開收錄", () => {
    const serverSeoSrc = readFileSync(new URL("../../api/lib/publicSeo.ts", import.meta.url), "utf8");
    expect(serverSeoSrc).toContain(PAGE_SEO["/web-design"].title);
    expect(serverSeoSrc).toContain(PAGE_SEO["/web-design"].description);
    expect(resolveSeo("/web-design")).toEqual(PAGE_SEO["/web-design"]);
    expect(resolveSeo("/web-design/")).toEqual(PAGE_SEO["/web-design"]);
    expect(isNoIndexPath("/web-design")).toBe(false);
    expect(isNoIndexPath("/web-design/")).toBe(false);
  });

  it("index.html 預設 description 同 PAGE_SEO['/'] 一致", () => {
    const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    expect(indexHtml).toContain(`<meta name="description" content="${PAGE_SEO["/"].description}" />`);
  });

  it("全部頁 title 互不重复", () => {
    const titles = Object.values(PAGE_SEO).map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("全部公開頁 description 互不重复（動態段同靜態頁分開計）", () => {
    // /lucky-results 同 /lucky-results/:eventId 係同一頁嘅靜態/動態版，刻意相同，剔除再驗
    const entries = Object.entries(PAGE_SEO).filter(([k]) => k !== "/lucky-results/:eventId");
    const descs = entries.map(([, s]) => s.description);
    expect(new Set(descs).size).toBe(descs.length);
  });
});

describe("resolveSeo 路由對應", () => {
  it("/products/:id 動態段 → 商品詳情過渡版（載入後 ProductDetail 覆寫做商品名）", () => {
    expect(resolveSeo("/products/85").title).toBe(PAGE_SEO["/products/:id"].title);
    expect(resolveSeo("/products/95").title).toBe(PAGE_SEO["/products/:id"].title);
  });

  it("私人頁同公開頁各自攞返自己條目", () => {
    expect(resolveSeo("/cart").title).toBe("購物車｜RedCode Fashion Design");
    expect(resolveSeo("/account").title).toBe("會員中心｜RedCode Fashion Design");
    expect(resolveSeo("/products").title).toBe("全部貨品｜RedCode Fashion Design");
  });

  it("有效直播日期／場次喺 React mount 後仍同 server 首口 title、description 一致", () => {
    for (const [date, session] of [["20261028", "2"], ["20261101", null]] as const) {
      const search = `?liveDate=${date}${session ? `&liveSession=${session}` : ""}`;
      const server = liveRouteMeta(date, session);
      expect(server).not.toBeNull();
      expect(resolveSeo("/products", search)).toEqual({
        title: server!.title,
        description: server!.description,
      });
    }
  });

  it("無效直播 query 唔反射入 title，照用通用商品頁 SEO", () => {
    for (const search of [
      "?liveDate=2026-11-01&liveSession=2",
      "?liveDate=20260230",
      "?liveDate=20261101&liveSession=0",
      "?liveDate=%3Cscript%3E",
    ]) {
      expect(resolveSeo("/products", search)).toEqual(PAGE_SEO["/products"]);
    }
  });

  it("未知路由用自己嘅 404 文案，唔再冒充首頁", () => {
    expect(resolveSeo("/no-such-page")).toEqual(NOT_FOUND_SEO);
  });

  it("FAQ、AI 試穿及有時限分享都有對應前端 meta", () => {
    expect(resolveSeo("/faq")).toEqual(PAGE_SEO["/faq"]);
    expect(resolveSeo("/try-on")).toEqual(PAGE_SEO["/try-on"]);
    expect(resolveSeo("/try-on/shared/abc123")).toEqual(PAGE_SEO["/try-on/shared/:publicId"]);
  });

  it("robots：公開頁可收錄；私人、分享、後台及未知頁 noindex", () => {
    for (const path of ["/", "/faq", "/returns", "/try-on", "/web-design", "/products/85", "/lucky-results/12"]) {
      expect(isNoIndexPath(path), path).toBe(false);
    }
    for (const path of [
      "/account",
      "/guest-checkout",
      "/wallet-topup",
      "/try-on/history",
      "/try-on/shared/abc123",
      "/admin",
      "/no-such-page",
    ]) {
      expect(isNoIndexPath(path), path).toBe(true);
    }
  });

  it("SPA canonical：category／try-on query 合併；有效直播 query 保留；私人同 404 唔指首頁", () => {
    expect(resolveCanonicalPath("/products", "?category=skincare")).toBe("/products");
    expect(resolveCanonicalPath("/try-on", "?productId=251&photoIndex=0")).toBe("/try-on");
    expect(resolveCanonicalPath("/products", "?liveDate=20261103&liveSession=1&category=top")).toBe(
      "/products?liveDate=20261103&liveSession=1",
    );
    expect(resolveCanonicalPath("/products/251")).toBe("/products/251");
    expect(resolveCanonicalPath("/lucky-results/12")).toBe("/lucky-results/12");
    expect(resolveCanonicalPath("/account")).toBeNull();
    expect(resolveCanonicalPath("/no-such-page")).toBeNull();
  });
});
