/**
 * 直播節目頁 SEO helper 測試（v2026.10.28.2）——純函數，唔掂 DB、唔掂 fs。
 * 覆蓋：真實日曆日期／數字場次驗證、全日／單場 title/description 分別、
 * canonical path 編碼、無效輸入回 null（絕不反射）。
 */
import { describe, expect, it } from "vitest";
import {
  formatLiveDateLabel,
  isValidLiveDate,
  isValidLiveSession,
  liveDescription,
  livePath,
  liveRouteMeta,
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
