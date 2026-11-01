import { beforeEach, describe, expect, it, vi } from "vitest";

let mockRows: unknown[] = [];
let queryError: Error | null = null;
let seenLimit = 0;

vi.mock("../queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => {
              seenLimit = n;
              return queryError ? Promise.reject(queryError) : Promise.resolve(mockRows);
            },
          }),
        }),
      }),
    }),
  }),
}));

import { injectPublicCatalog, listPublicCatalog, renderPublicCatalog } from "./catalogSeo";

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
});
