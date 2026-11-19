/**
 * gloGuide.byProduct（v2.5.13 商品詳情頁反向導航）測試——DB mock，唔掂真 DB。
 *
 * 覆蓋重點：
 * ─ listPublishedGuidesForProduct 直達 DB 嘅查詢合同：join gloGuideArticleProducts.productId
 *   ＋ gloGuideArticles.status='published'，publishedAt desc，limit clamp 1–4；
 * ─ 精簡 DTO：只回 slug/title/excerpt/theme/publishedAt/coverImage；
 *   body／status／modelImage／updatedAt 等內部欄絕對唔洩漏；
 * ─ 封面過 toGuideImage 公開閘：未 approved／CDN path 嘅圖唔出；
 * ─ zod 輸入閘：非正整數 productId → BAD_REQUEST，DB 完全冇被調用；
 * ─ 無關聯 → {items: []}；無效 productId（函數層）→ 空 array 唔炸。
 *
 * Mock 策略同 gloGuidePublicPagination.test.ts 一致：getDb → Proxy chain
 * （記錄 where/limit/orderBy，結果 queue 順序出隊）；唔 mock gloGuideDto，
 * 用真 mapper 驗證 DTO 閘真係有行。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => {
  type Rec = { where?: unknown; limit?: number; orderBy?: unknown[] };
  const state = { queue: [] as unknown[][], selects: [] as Rec[] };
  const pop = () => (state.queue.length ? state.queue.shift()! : []);
  function chain(rec: Rec): unknown {
    return new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            const value = pop();
            return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)).then(
                resolve,
                reject,
              );
          }
          return (...args: unknown[]) => {
            if (prop === "where") rec.where = args[0];
            if (prop === "limit") rec.limit = args[0] as number;
            if (prop === "orderBy") rec.orderBy = args;
            return chain(rec);
          };
        },
      },
    );
  }
  const db = {
    select: () => {
      const rec: Rec = {};
      state.selects.push(rec);
      return chain(rec);
    },
  };
  return { state, db };
});

vi.mock("./queries/connection", () => ({ getDb: () => h.db }));
// auth.ts 頂部 import "dotenv/config"；公開 procedure 唔需要 auth，成個 mock 走
vi.mock("./auth", () => ({
  userFromAuthHeader: vi.fn(async () => null),
  verifyToken: vi.fn(async () => null),
}));
vi.mock("./productAiContent", () => ({
  publicAiTags: vi.fn(() => []),
}));

import { gloGuidePublicRouter, listPublishedGuidesForProduct } from "./gloGuidePublic";

const dialect = new PgDialect();
const sqlText = (value: unknown) => dialect.sqlToQuery(value as never);

function caller() {
  return gloGuidePublicRouter.createCaller({
    req: new Request("http://test.local/api/trpc"),
    resHeaders: new Headers(),
  });
}

function articleRow(id: number) {
  return {
    id,
    slug: `glo-guide-2026111${id}-ab${id}${id}`,
    title: `第 ${id} 期配搭`,
    body: `第 ${id} 期正文內容。`,
    theme: "轉季上班",
    status: "published",
    publishedAt: new Date(`2026-11-1${id}T01:00:00Z`),
    updatedAt: new Date(`2026-11-1${id}T02:00:00Z`),
  };
}

function imageRow(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    articleId: 5,
    productId: 42,
    path: "/uploads/glo-guide/a.png",
    width: 1024,
    height: 1536,
    position: 0,
    status: "completed",
    reviewStatus: "approved",
    deletedAt: null,
    ...over,
  };
}

beforeEach(() => {
  h.state.queue = [];
  h.state.selects = [];
  vi.clearAllMocks();
});

describe("listPublishedGuidesForProduct：DB 查詢合同", () => {
  it("join productId＋status='published'＋publishedAt desc＋預設 limit 4", async () => {
    h.state.queue.push([]); // join 結果：空
    const items = await listPublishedGuidesForProduct(42);
    expect(items).toEqual([]);

    expect(h.state.selects).toHaveLength(1);
    const q = h.state.selects[0];
    expect(q.limit).toBe(4);
    const where = sqlText(q.where);
    expect(where.sql).toContain("productId");
    expect(where.sql).toContain("status");
    expect(where.params).toContain(42);
    expect(where.params).toContain("published");
    const order = sqlText(q.orderBy![0]);
    expect(order.sql).toContain("publishedAt");
    expect(order.sql.toLowerCase()).toContain("desc");
  });

  it("limit clamp 1–4（0 → 1；99 → 4）", async () => {
    h.state.queue.push([]);
    await listPublishedGuidesForProduct(42, 0);
    expect(h.state.selects[0].limit).toBe(1);
    h.state.queue.push([]);
    await listPublishedGuidesForProduct(42, 99);
    expect(h.state.selects[1].limit).toBe(4);
  });

  it("無效 productId（0／負數／小數）→ 空 array，DB 完全冇被調用", async () => {
    for (const bad of [0, -3, 1.5, Number.NaN]) {
      expect(await listPublishedGuidesForProduct(bad)).toEqual([]);
    }
    expect(h.state.selects).toHaveLength(0);
  });
});

describe("gloGuide.byProduct：精簡 DTO 同圖閘", () => {
  it("只回公開精簡欄；body／status／modelImage 等內部欄唔洩漏；封面過 approved 閘", async () => {
    h.state.queue.push(
      [{ article: articleRow(5) }],
      // 第一篇圖：一張 approved 合法圖＋一張 pending（唔准出）
      [imageRow({ id: 7 }), imageRow({ id: 8, position: 1, reviewStatus: "pending" })],
    );
    const res = await caller().byProduct({ productId: 42 });
    expect(res.items).toHaveLength(1);
    const item = res.items[0];
    expect(item.slug).toBe(articleRow(5).slug);
    expect(item.title).toBe("第 5 期配搭");
    expect(item.theme).toBe("轉季上班");
    expect(item.excerpt).toContain("第 5 期正文內容");
    expect(item.publishedAt).toBe("2026-11-15T01:00:00.000Z");
    expect(item.coverImage?.id).toBe(7);
    expect(item.coverImage?.path).toBe("/uploads/glo-guide/a.png");
    expect(Object.keys(item).sort()).toEqual(
      ["coverImage", "excerpt", "publishedAt", "slug", "theme", "title"],
    );
  });

  it("封面全部唔過閘（CDN path）→ coverImage null，文章本身照出", async () => {
    h.state.queue.push(
      [{ article: articleRow(6) }],
      [imageRow({ path: "https://cdn.fashn.ai/x.png" })],
    );
    const res = await caller().byProduct({ productId: 42 });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].coverImage).toBeNull();
  });

  it("每篇只加載圖行（唔取商品行）：join 1 select＋N 篇各 1 images select", async () => {
    h.state.queue.push(
      [{ article: articleRow(1) }, { article: articleRow(2) }],
      [],
      [],
    );
    const res = await caller().byProduct({ productId: 42 });
    expect(res.items).toHaveLength(2);
    expect(h.state.selects).toHaveLength(3);
  });

  it("無關聯商品 → {items: []}", async () => {
    h.state.queue.push([]);
    const res = await caller().byProduct({ productId: 999 });
    expect(res).toEqual({ items: [] });
  });

  it("非法輸入（0／負數／小數／字串）→ BAD_REQUEST，DB 冇被調用", async () => {
    for (const input of [
      { productId: 0 },
      { productId: -1 },
      { productId: 1.5 },
      { productId: "42" },
    ]) {
      await expect(caller().byProduct(input as never)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(h.state.selects).toHaveLength(0);
  });
});
