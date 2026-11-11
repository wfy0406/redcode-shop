import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockRows: unknown[] = [];
let queryError: Error | null = null;
let seenLimit = 0;
let seenWhere: unknown = null;
let liveRows: unknown[] = [];
let liveError: Error | null = null;
let liveWhere: unknown = null;

vi.mock("../queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (where: unknown) => {
          seenWhere = where;
          return {
            orderBy: () => ({
              limit: (n: number) => {
                seenLimit = n;
                return queryError ? Promise.reject(queryError) : Promise.resolve(mockRows);
              },
            }),
          };
        },
      }),
    }),
    // listPublicLiveFilters 用 selectDistinct：where 之後直接 await（thenable）
    selectDistinct: () => ({
      from: () => ({
        where: (where: unknown) => {
          liveWhere = where;
          return liveError ? Promise.reject(liveError) : Promise.resolve(liveRows);
        },
      }),
    }),
  }),
}));

import { injectPublicCatalog, listPublicCatalog, listPublicLiveFilters, renderPublicCatalog } from "./catalogSeo";

const item = {
  id: 85,
  sku: 'SKU"<&',
  name: 'A"B & <C>',
  price: 299,
  discountPrice: 199,
  stock: 5,
};

beforeEach(() => {
  mockRows = [];
  queryError = null;
  seenLimit = 0;
  seenWhere = null;
  liveRows = [];
  liveError = null;
  liveWhere = null;
});

describe("公開商品目錄首口 HTML", () => {
  it("輸出真商品連結、貨號、折扣價同庫存，所有文字正確 escape", () => {
    const html = renderPublicCatalog([item]);
    expect(html).toContain('<a href="/products/85"><strong>A&quot;B &amp; &lt;C&gt;</strong></a>');
    expect(html).toContain("（貨號 SKU&quot;&lt;&amp;）");
    expect(html).toContain("HK$199；有貨");
    expect(html).not.toContain("<C>");
  });

  it("零商品唔輸出假空目錄；重複注入唔會整出兩份", () => {
    expect(renderPublicCatalog([])).toBe("");
    const template = '<main id="redcode-public-seo"><nav aria-label="相關公開頁面"></nav></main>';
    const once = injectPublicCatalog(template, [item]);
    expect(injectPublicCatalog(once, [item])).toBe(once);
    expect(injectPublicCatalog(template, [])).toBe(template);
  });

  it("公開查詢最多 60 件；DB 錯誤交畀 caller 保留通用摘要", async () => {
    mockRows = [item];
    await expect(listPublicCatalog(500)).resolves.toEqual([item]);
    expect(seenLimit).toBe(60);
    queryError = new Error("connection refused");
    await expect(listPublicCatalog()).rejects.toThrow("connection refused");
  });

  it("有效直播日期／場次會落入 SQL filter，同時保留公開上架條件", async () => {
    mockRows = [item];
    await listPublicCatalog(48, { liveDate: "20261103", liveSession: "1" });
    const query = new PgDialect().sqlToQuery(seenWhere as never);
    expect(query.sql).toMatch(/"isActive" = \$1/);
    expect(query.sql).toMatch(/"delistEnabled" = \$2/);
    expect(query.sql).toContain('"delistAt" is null');
    expect(query.sql).toMatch(/"delistAt" > \$3/);
    expect(query.sql).toMatch(/"liveDate" = \$4/);
    expect(query.sql).toMatch(/"liveSession" = \$5/);
    expect(query.params[0]).toBe(true);
    expect(query.params[1]).toBe(false);
    expect(Number.isNaN(Date.parse(String(query.params[2])))).toBe(false);
    expect(query.params.slice(3)).toEqual(["20261103", "1"]);
  });

  it("直播目錄可以用日期場次做真標題，唔再只得通用全部貨品", () => {
    const html = renderPublicCatalog([item], "2026年11月3日 第1場直播商品");
    expect(html).toContain("<h2>2026年11月3日 第1場直播商品</h2>");
  });
});

describe("listPublicLiveFilters — sitemap 直播場次來源", () => {
  it("用同一套公開上架條件＋liveDate 非空，回傳真日期／場次組合", async () => {
    liveRows = [
      { liveDate: "20261111", liveSession: "1" },
      { liveDate: "20261111", liveSession: null },
    ];
    await expect(listPublicLiveFilters()).resolves.toEqual([
      { liveDate: "20261111", liveSession: "1" },
      { liveDate: "20261111", liveSession: null },
    ]);
    const query = new PgDialect().sqlToQuery(liveWhere as never);
    expect(query.sql).toMatch(/"isActive" = \$1/);
    expect(query.sql).toMatch(/"delistEnabled" = \$2/);
    expect(query.sql).toContain('"delistAt" is null');
    expect(query.sql).toContain('"liveDate" is not null');
  });

  it("liveDate 非字串嘅行會被丟棄；DB 錯誤原樣抛出畀 caller 分清故障", async () => {
    liveRows = [{ liveDate: null, liveSession: "1" }, { liveDate: "20261111", liveSession: "2" }];
    await expect(listPublicLiveFilters()).resolves.toEqual([
      { liveDate: "20261111", liveSession: "2" },
    ]);
    liveError = new Error("connection refused");
    await expect(listPublicLiveFilters()).rejects.toThrow("connection refused");
  });
});
