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
import { PAGE_SEO, resolveSeo } from "./seo";

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
    const viteSrc = readFileSync(new URL("../../api/lib/vite.ts", import.meta.url), "utf8");
    expect(viteSrc).toContain(PAGE_SEO["/about"].description);
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

  it("未知路由 fallback 首頁", () => {
    expect(resolveSeo("/no-such-page").title).toBe(PAGE_SEO["/"].title);
  });
});
