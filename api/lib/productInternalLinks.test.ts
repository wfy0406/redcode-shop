import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockQuery = { rows?: unknown[]; error?: Error };

let mockQueries: MockQuery[] = [];
let dbCalls = 0;
let seen: Array<{ where: unknown; limit: number }> = [];
let activeWhere: unknown = null;

vi.mock("../queries/connection", () => ({
  getDb: () => {
    dbCalls += 1;
    return {
      select: () => ({
        from: () => {
          const joinable = {
            innerJoin: () => joinable,
            where: (where: unknown) => {
              activeWhere = where;
              const complete = (limit: number) => {
                const index = seen.length;
                seen.push({ where, limit });
                const query = mockQueries[index] ?? {};
                return query.error ? Promise.reject(query.error) : Promise.resolve(query.rows ?? []);
              };
              return {
                limit: complete,
                orderBy: () => ({ limit: complete }),
              };
            },
          };
          return joinable;
        },
      }),
    };
  },
}));

import { injectProductInternalLinkBlock, injectProductInternalLinks } from "./productInternalLinks";

const PRODUCT_HTML = '<html><body><main id="redcode-product-seo"><h1>商品</h1><nav aria-label="購物相關頁面"><ul><li><a href="/products">全部貨品</a></li></ul></nav></main></body></html>';

describe("商品首口真關係內鏈", () => {
  it("加入真同類、場次、相關商品及已發布指南，唔再只有三條通用鏈", () => {
    const out = injectProductInternalLinkBlock(PRODUCT_HTML, {
      contexts: [
        { href: "/products?category=top", label: "全部上衣" },
        { href: "/products?liveDate=20261111&liveSession=2", label: "睇返同一場直播商品（第2場）" },
      ],
      related: [{ href: "/products/86", label: "同場次真商品" }],
      guides: [{ href: "/glo-guide/real-guide", label: "真配搭指南" }],
    });
    expect(out).toContain('id="redcode-product-links-seo"');
    expect(out).toContain('<a href="/products/86">同場次真商品</a>');
    expect(out).toContain('<a href="/glo-guide/real-guide">真配搭指南</a>');
    expect(out).toContain('href="/products?liveDate=20261111&amp;liveSession=2"');
    expect(out.indexOf('id="redcode-product-links-seo"')).toBeLessThan(out.indexOf('aria-label="購物相關頁面"'));
  });

  it("無真關係、非商品首口或重複注入都係 no-op；所有文字與 URL 有 escape", () => {
    const empty = { contexts: [], related: [], guides: [] };
    expect(injectProductInternalLinkBlock(PRODUCT_HTML, empty)).toBe(PRODUCT_HTML);
    expect(injectProductInternalLinkBlock("<html></html>", empty)).toBe("<html></html>");
    const once = injectProductInternalLinkBlock(PRODUCT_HTML, {
      contexts: [],
      related: [{ href: "/products/86?x=<bad>&y=1", label: 'A"B & <C>' }],
      guides: [],
    });
    expect(once).toContain('A&quot;B &amp; &lt;C&gt;');
    expect(once).toContain('/products/86?x=&lt;bad&gt;&amp;y=1');
    expect(injectProductInternalLinkBlock(once, empty)).toBe(once);
    expect(once.match(/id="redcode-product-links-seo"/g)).toHaveLength(1);
  });
});


beforeEach(() => {
  mockQueries = [];
  dbCalls = 0;
  seen = [];
  activeWhere = null;
});

describe("商品首口真關係內鏈 — DB 查詢與失效降級", () => {
  const current = {
    id: 42,
    category: "top",
    liveDate: "20261111",
    liveSession: "2",
  };

  it("只查公開商品；相關商品按同場次、同日、同類排序，指南必須 published", async () => {
    mockQueries = [
      { rows: [current] },
      {
        rows: [
          { id: 86, name: "同類商品", category: "top", liveDate: null, liveSession: null },
          { id: 85, name: "同日另一場", category: "dress", liveDate: "20261111", liveSession: "1" },
          { id: 84, name: "完全相同場次", category: "dress", liveDate: "20261111", liveSession: "2" },
          { id: 42, name: "自己唔應出現", category: "top", liveDate: "20261111", liveSession: "2" },
        ],
      },
      { rows: [{ slug: "real-guide", title: "真配搭指南" }] },
    ];

    const out = await injectProductInternalLinks(PRODUCT_HTML, 42);
    expect(out).toContain('href="/products?category=top"');
    expect(out).toContain('href="/products?liveDate=20261111&amp;liveSession=2"');
    expect(out).not.toContain("自己唔應出現");
    expect(out.indexOf("/products/84")).toBeLessThan(out.indexOf("/products/85"));
    expect(out.indexOf("/products/85")).toBeLessThan(out.indexOf("/products/86"));
    expect(out).toContain('<a href="/glo-guide/real-guide">真配搭指南</a>');
    expect(seen.map((entry) => entry.limit)).toEqual([1, 12, 4]);

    const currentSql = new PgDialect().sqlToQuery(seen[0].where as never);
    expect(currentSql.sql).toContain('"id" = $1');
    expect(currentSql.sql).toContain('"isActive" = $2');
    expect(currentSql.sql).toContain('"delistEnabled" = $3');
    expect(currentSql.sql).toContain('"delistAt" is null');
    expect(currentSql.sql).toContain('"delistAt" > $4');
    expect(currentSql.params[0]).toBe(42);
    expect(currentSql.params[1]).toBe(true);
    expect(currentSql.params[2]).toBe(false);
    expect(Number.isNaN(Date.parse(String(currentSql.params[3])))).toBe(false);

    const relatedSql = new PgDialect().sqlToQuery(seen[1].where as never);
    expect(relatedSql.sql).toContain('"id" <> $1');
    expect(relatedSql.sql).toContain('"isActive" = $2');
    expect(relatedSql.sql).toContain('"category" = $5');
    expect(relatedSql.sql).toContain('"liveDate" = $6');
    expect(relatedSql.params[0]).toBe(42);
    expect(relatedSql.params.slice(4)).toEqual(["top", "20261111"]);

    const guideSql = new PgDialect().sqlToQuery(seen[2].where as never);
    expect(guideSql.sql).toContain('"productId" = $1');
    expect(guideSql.sql).toContain('"status" = $2');
    expect(guideSql.params).toEqual([42, "published"]);
  });

  it("相關商品查詢失敗只省略嗰組，仍保留真場次及 published 指南", async () => {
    mockQueries = [
      { rows: [current] },
      { error: new Error("related unavailable") },
      { rows: [{ slug: "still-here", title: "指南仍在" }] },
    ];
    const out = await injectProductInternalLinks(PRODUCT_HTML, 42);
    expect(out).toContain("繼續揀款");
    expect(out).toContain("指南仍在");
    expect(out).not.toContain("同場次／同類商品");
    expect(seen).toHaveLength(3);
  });

  it("指南查詢失敗唔會拖垮商品首口；current 查詢失敗或商品唔公開就原樣返回", async () => {
    mockQueries = [
      { rows: [current] },
      { rows: [{ id: 84, name: "真商品", category: "top", liveDate: "20261111", liveSession: "2" }] },
      { error: new Error("guides unavailable") },
    ];
    const out = await injectProductInternalLinks(PRODUCT_HTML, 42);
    expect(out).toContain("真商品");
    expect(out).not.toContain("Glo Glo 指南");

    mockQueries = [{ error: new Error("database unavailable") }];
    await expect(injectProductInternalLinks(PRODUCT_HTML, 42)).resolves.toBe(PRODUCT_HTML);

    mockQueries = [{ rows: [] }];
    await expect(injectProductInternalLinks(PRODUCT_HTML, 42)).resolves.toBe(PRODUCT_HTML);
    expect(seen).toHaveLength(5);
  });

  it("非商品首口或已注入區塊唔會浪費 DB 查詢", async () => {
    await expect(injectProductInternalLinks("<html></html>", 42)).resolves.toBe("<html></html>");
    const already = injectProductInternalLinkBlock(PRODUCT_HTML, {
      contexts: [{ href: "/products?category=top", label: "全部上衣" }],
      related: [],
      guides: [],
    });
    await expect(injectProductInternalLinks(already, 42)).resolves.toBe(already);
    expect(dbCalls).toBe(0);
    expect(activeWhere).toBeNull();
  });
});
