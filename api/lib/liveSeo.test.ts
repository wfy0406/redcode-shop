/**
 * 直播節目頁 SEO helper 測試（v2026.10.28.2）——純函數，唔掂 DB、唔掂 fs。
 * 覆蓋：真實日曆日期／數字場次驗證、全日／單場 title/description 分別、
 * canonical path 編碼、無效輸入回 null（絕不反射）。
 * v2026.11.11 補強：真空場次 emptyLiveRouteMeta（noindex、唔扮有貨）、
 * sitemap 直播 URL 去重＋非法 DB 值過濾、文案唔再無條件承諾直播優惠價。
 */
import { describe, expect, it } from "vitest";
import {
  emptyLiveRouteMeta,
  formatLiveDateLabel,
  isValidLiveDate,
  isValidLiveSession,
  liveDescription,
  livePath,
  liveRouteMeta,
  liveSitemapPaths,
  liveTitle,
  parseLiveQuery,
} from "./liveSeo";

describe("isValidLiveDate — 真實日曆日期", () => {
  it("正常日期過（閏年 2/29 都過）", () => {
    expect(isValidLiveDate("20261028")).toBe(true);
    expect(isValidLiveDate("20240229")).toBe(true);
  });
  it("假日曆日期唔過", () => {
    expect(isValidLiveDate("20230229")).toBe(false);
    expect(isValidLiveDate("20261301")).toBe(false);
    expect(isValidLiveDate("20260230")).toBe(false);
    expect(isValidLiveDate("20260001")).toBe(false);
  });
  it("格式／注入字串唔過", () => {
    expect(isValidLiveDate("")).toBe(false);
    expect(isValidLiveDate("2026-10-28")).toBe(false);
    expect(isValidLiveDate('20261028"><script>')).toBe(false);
  });
});

describe("isValidLiveSession — 正整數場次", () => {
  it("正整數過；零／前導零／負數／小數／注入唔過", () => {
    expect(isValidLiveSession("1")).toBe(true);
    expect(isValidLiveSession("23")).toBe(true);
    for (const bad of ["", "0", "01", "-1", "1.5", "abc", '1"><img']) {
      expect(isValidLiveSession(bad)).toBe(false);
    }
  });
});

describe("parseLiveQuery — 無效輸入回 null", () => {
  it("冇 liveDate → null（通用 /products，唔係錯）", () => {
    expect(parseLiveQuery(null, null)).toBeNull();
    expect(parseLiveQuery("", null)).toBeNull();
  });
  it("有效全日／單場", () => {
    expect(parseLiveQuery("20261028", null)).toEqual({
      liveDate: "20261028",
      liveSession: null,
    });
    expect(parseLiveQuery("20261028", "3")).toEqual({
      liveDate: "20261028",
      liveSession: "3",
    });
  });
  it("無效日期／場次 → null（絕不反射）", () => {
    expect(parseLiveQuery("20261340", null)).toBeNull();
    expect(parseLiveQuery("20261028", "abc")).toBeNull();
    expect(parseLiveQuery('20261028"><script>', null)).toBeNull();
  });
});

describe("live meta — 全日／單場文案有分別", () => {
  it("日期格式化", () => {
    expect(formatLiveDateLabel("20261028")).toBe("2026年10月28日");
  });
  it("全日：title/description 强调全部場次；path 淨 liveDate", () => {
    const f = { liveDate: "20261028", liveSession: null };
    expect(liveTitle(f)).toBe("2026年10月28日 全日直播商品｜RedCode Fashion Design");
    expect(liveDescription(f)).toContain("全部場次");
    expect(livePath(f)).toBe("/products?liveDate=20261028");
  });
  it("單場：title/description 强调指定場次＋即睇直播商品；path 加 liveSession", () => {
    const f = { liveDate: "20261028", liveSession: "2" };
    expect(liveTitle(f)).toBe("2026年10月28日 第2場直播商品｜RedCode Fashion Design");
    expect(liveDescription(f)).toContain("第2場");
    expect(liveDescription(f)).toContain("即睇直播商品");
    expect(livePath(f)).toBe("/products?liveDate=20261028&liveSession=2");
  });
});

describe("live meta — 公開事實文案 regression", () => {
  it("唔再無條件承諾「直播優惠價發售」；品名／價錢／庫存以商品頁為準", () => {
    for (const f of [
      { liveDate: "20261028", liveSession: null },
      { liveDate: "20261028", liveSession: "2" },
    ]) {
      const d = liveDescription(f);
      expect(d).not.toContain("直播優惠價發售");
      expect(d).not.toContain("優惠繼續生效");
      expect(d).toContain("以商品頁為準");
    }
  });
});

describe("emptyLiveRouteMeta — 真空場次唔准扮有貨", () => {
  it("全日空場次：noindex＋移除 self canonical＋如實文案", () => {
    const meta = emptyLiveRouteMeta({ liveDate: "20261028", liveSession: null });
    expect(meta.noindex).toBe(true);
    expect(meta.canonical).toBeNull();
    expect(meta.path).toBeUndefined();
    expect(meta.title).toBe("2026年10月28日 直播暫未有公開商品｜RedCode Fashion Design");
    expect(meta.description).toContain("冇公開商品");
    expect(meta.description).toContain("以商品頁為準");
    expect(meta.description).not.toContain("直播優惠");
  });
  it("單場空場次帶場次號；合法日期先會出現喺文案", () => {
    const meta = emptyLiveRouteMeta({ liveDate: "20261111", liveSession: "3" });
    expect(meta.title).toContain("第3場");
    expect(meta.title).toContain("2026年11月11日");
    expect(meta.noindex).toBe(true);
    expect(meta.canonical).toBeNull();
  });
});

describe("liveSitemapPaths — sitemap 直播 URL", () => {
  it("合法全日／單場出 URL，同一 URL 去重", () => {
    const paths = liveSitemapPaths([
      { liveDate: "20261111", liveSession: null },
      { liveDate: "20261111", liveSession: "1" },
      { liveDate: "20261111", liveSession: "1" }, // 重複場次
      { liveDate: "20261111", liveSession: null }, // 重複全日
      { liveDate: "20261111", liveSession: "2" },
    ]);
    expect(paths).toEqual([
      "/products?liveDate=20261111",
      "/products?liveDate=20261111&liveSession=1",
      "/products?liveDate=20261111&liveSession=2",
    ]);
  });
  it("DB 落嚟嘅非法值（假日曆日期／非數字場次／null）一律唔入 sitemap", () => {
    const paths = liveSitemapPaths([
      { liveDate: "20261340", liveSession: null },
      { liveDate: "20261111", liveSession: "abc" },
      { liveDate: "20261111", liveSession: "0" },
      { liveDate: '20261111"><script>', liveSession: null },
      null,
      undefined,
      { liveDate: "20261111", liveSession: "1" },
    ]);
    expect(paths).toEqual(["/products?liveDate=20261111&liveSession=1"]);
  });
});

describe("liveRouteMeta — 俾 injectRouteMeta 用", () => {
  it("有效輸入出 title/description/path", () => {
    const meta = liveRouteMeta("20261028", "2");
    expect(meta).toEqual({
      title: "2026年10月28日 第2場直播商品｜RedCode Fashion Design",
      description: expect.stringContaining("第2場"),
      path: "/products?liveDate=20261028&liveSession=2",
    });
  });
  it("無效／冇參數 → null（通用 fallback）", () => {
    expect(liveRouteMeta(null, null)).toBeNull();
    expect(liveRouteMeta("20261340", null)).toBeNull();
    expect(liveRouteMeta("20261028", "0")).toBeNull();
  });
});
