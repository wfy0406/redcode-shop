import { describe, expect, it } from "vitest";
import {
  changeTryOnLiveDate,
  changeTryOnLiveSession,
  countTryOnLiveMatches,
  deriveTryOnLiveDates,
  filterTryOnProducts,
  formatTryOnLiveDate,
  isValidTryOnLiveDate,
  parseTryOnLiveSession,
  sortTryOnProductsByListed,
  tryOnEmptyReason,
  tryOnLiveSessionsForDate,
  tryOnLiveSessionLabel,
  type TryOnFilterProduct,
  type TryOnProductFilters,
} from "./tryonFilters";

function product(partial: Partial<TryOnFilterProduct> & { id: number }): TryOnFilterProduct {
  return {
    name: `商品 ${partial.id}`,
    sku: `SKU${partial.id}`,
    tryOnKind: "top",
    listedDate: "2026-10-01T00:00:00.000Z",
    liveDate: null,
    liveSession: null,
    ...partial,
  };
}

const baseFilters: TryOnProductFilters = {
  search: "",
  kind: "all",
  liveDate: null,
  liveSession: null,
  sort: "newest",
};

describe("直播日期／場次驗證", () => {
  it("只接受真實日曆日期嘅 YYYYMMDD", () => {
    expect(isValidTryOnLiveDate("20261028")).toBe(true);
    expect(isValidTryOnLiveDate("20260229")).toBe(false); // 2026 唔係閏年
    expect(isValidTryOnLiveDate("20261340")).toBe(false);
    expect(isValidTryOnLiveDate("2026-10-28")).toBe(false);
    expect(isValidTryOnLiveDate("")).toBe(false);
    expect(isValidTryOnLiveDate(null)).toBe(false);
  });

  it("場次只接受正整數字串", () => {
    expect(parseTryOnLiveSession("1")).toBe(1);
    expect(parseTryOnLiveSession("12")).toBe(12);
    expect(parseTryOnLiveSession("0")).toBe(null);
    expect(parseTryOnLiveSession("-1")).toBe(null);
    expect(parseTryOnLiveSession("1.5")).toBe(null);
    expect(parseTryOnLiveSession("abc")).toBe(null);
    expect(parseTryOnLiveSession(null)).toBe(null);
  });
});

describe("由合資格商品衍生日期場次選項", () => {
  it("日期新至舊、場次數字序，非直播商品唔會混入", () => {
    const options = deriveTryOnLiveDates([
      product({ id: 1, liveDate: "20261020", liveSession: "2" }),
      product({ id: 2, liveDate: "20261028", liveSession: "10" }),
      product({ id: 3, liveDate: "20261028", liveSession: "2" }),
      product({ id: 4, liveDate: "20261028", liveSession: "2" }),
      product({ id: 5 }), // 普通商品
      product({ id: 6, liveDate: "20269999", liveSession: "1" }), // 假日期唔計
    ]);
    expect(options).toEqual([
      { date: "20261028", sessions: [2, 10] },
      { date: "20261020", sessions: [2] },
    ]);
  });

  it("有日期但冇場次嘅商品仍形成日期選項，場次留空", () => {
    const options = deriveTryOnLiveDates([product({ id: 1, liveDate: "20261028", liveSession: null })]);
    expect(options).toEqual([{ date: "20261028", sessions: [] }]);
  });

  it("空清單衍生空選項", () => {
    expect(deriveTryOnLiveDates([])).toEqual([]);
    expect(tryOnLiveSessionsForDate([], "20261028")).toEqual([]);
  });
});

describe("最新上架排序", () => {
  const items = [
    product({ id: 1, listedDate: "2026-10-01T00:00:00.000Z" }),
    product({ id: 2, listedDate: "2026-10-28T00:00:00.000Z" }),
    product({ id: 3, listedDate: "2026-10-15T00:00:00.000Z" }),
    product({ id: 4, listedDate: "2026-10-15T00:00:00.000Z" }),
  ];

  it("預設新至舊，同刻以 id 新至舊穩定", () => {
    expect(sortTryOnProductsByListed(items, "newest").map((item) => item.id)).toEqual([2, 4, 3, 1]);
  });

  it("反向最早上架舊至新", () => {
    expect(sortTryOnProductsByListed(items, "oldest").map((item) => item.id)).toEqual([1, 3, 4, 2]);
  });

  it("唔會改動原陣列", () => {
    const before = items.map((item) => item.id);
    sortTryOnProductsByListed(items, "newest");
    expect(items.map((item) => item.id)).toEqual(before);
  });
});

describe("換日期重設場次", () => {
  it("揀新日期時場次重設為 null", () => {
    const next = changeTryOnLiveDate({ liveDate: "20261020", liveSession: 2 }, "20261028");
    expect(next).toEqual({ liveDate: "20261028", liveSession: null });
  });

  it("清除日期（揀全部）都重設場次", () => {
    expect(changeTryOnLiveDate({ liveDate: "20261020", liveSession: 2 }, null)).toEqual({
      liveDate: null,
      liveSession: null,
    });
  });

  it("揀返同一日期原樣保留場次", () => {
    const current = { liveDate: "20261020", liveSession: 2 };
    expect(changeTryOnLiveDate(current, "20261020")).toBe(current);
  });

  it("換場次唔郁日期", () => {
    expect(changeTryOnLiveSession({ liveDate: "20261020", liveSession: 2 }, 3)).toEqual({
      liveDate: "20261020",
      liveSession: 3,
    });
  });
});

describe("疊加篩選", () => {
  const items = [
    product({ id: 1, name: "針織外套", sku: "TOP001", tryOnKind: "top", liveDate: "20261028", liveSession: "1", listedDate: "2026-10-28T00:00:00.000Z" }),
    product({ id: 2, name: "闊腳長褲", sku: "BTM002", tryOnKind: "bottom", liveDate: "20261028", liveSession: "2", listedDate: "2026-10-27T00:00:00.000Z" }),
    product({ id: 3, name: "針織短裙", sku: "SKT003", tryOnKind: "skirt", liveDate: "20261020", liveSession: "1", listedDate: "2026-10-20T00:00:00.000Z" }),
    product({ id: 4, name: "白波鞋", sku: "SHO004", tryOnKind: "shoes", listedDate: "2026-10-01T00:00:00.000Z" }),
  ];

  it("直播日期篩選只留當日商品", () => {
    const result = filterTryOnProducts(items, { ...baseFilters, liveDate: "20261020" });
    expect(result.map((item) => item.id)).toEqual([3]);
  });

  it("日期＋場次雙重篩選", () => {
    const result = filterTryOnProducts(items, { ...baseFilters, liveDate: "20261028", liveSession: 2 });
    expect(result.map((item) => item.id)).toEqual([2]);
  });

  it("同部位篩選疊加", () => {
    const result = filterTryOnProducts(items, { ...baseFilters, liveDate: "20261028", kind: "top" });
    expect(result.map((item) => item.id)).toEqual([1]);
  });

  it("再疊加搜尋品名／貨號", () => {
    const result = filterTryOnProducts(items, { ...baseFilters, liveDate: "20261028", kind: "top", search: "top001" });
    expect(result.map((item) => item.id)).toEqual([1]);
    expect(filterTryOnProducts(items, { ...baseFilters, liveDate: "20261028", kind: "top", search: "長褲" })).toEqual([]);
  });

  it("篩選後仍按上架次序排列", () => {
    const result = filterTryOnProducts(items, { ...baseFilters, sort: "oldest" });
    expect(result.map((item) => item.id)).toEqual([4, 3, 2, 1]);
  });

  it("篩選只影響返回清單，唔會改動輸入商品", () => {
    const before = items.map((item) => item.id);
    filterTryOnProducts(items, { ...baseFilters, liveDate: "20261028" });
    expect(items.map((item) => item.id)).toEqual(before);
  });
});

describe("直播條件單獨計數", () => {
  const items = [
    product({ id: 1, liveDate: "20261028", liveSession: "1" }),
    product({ id: 2, liveDate: "20261028", liveSession: "2" }),
    product({ id: 3, liveDate: "20261020", liveSession: "1" }),
    product({ id: 4 }),
  ];

  it("冇日期時等於總數", () => {
    expect(countTryOnLiveMatches(items, null, null)).toBe(4);
  });

  it("日期計所有場次，場次再收窄", () => {
    expect(countTryOnLiveMatches(items, "20261028", null)).toBe(2);
    expect(countTryOnLiveMatches(items, "20261028", 2)).toBe(1);
    expect(countTryOnLiveMatches(items, "20261028", 9)).toBe(0);
  });
});

describe("空狀態分類", () => {
  it("本身冇合資格商品", () => {
    expect(tryOnEmptyReason({ totalEligible: 0, liveFilterActive: false, liveMatchCount: 0 })).toBe("no-eligible");
  });

  it("揀咗嘅日期／場次本身冇合資格試穿商品", () => {
    expect(tryOnEmptyReason({ totalEligible: 5, liveFilterActive: true, liveMatchCount: 0 })).toBe("no-live-products");
  });

  it("日期場次有貨，但搜尋／部位組合冇結果", () => {
    expect(tryOnEmptyReason({ totalEligible: 5, liveFilterActive: true, liveMatchCount: 2 })).toBe("no-filter-match");
    expect(tryOnEmptyReason({ totalEligible: 5, liveFilterActive: false, liveMatchCount: 5 })).toBe("no-filter-match");
  });
});

describe("顯示格式", () => {
  it("日期格式化", () => {
    expect(formatTryOnLiveDate("20261028")).toBe("2026.10.28");
    expect(formatTryOnLiveDate("20261028", "short")).toBe("10.28");
    expect(formatTryOnLiveDate("invalid")).toBe("invalid");
  });

  it("場次標籤", () => {
    expect(tryOnLiveSessionLabel(3)).toBe("第 3 場");
  });
});
