/**
 * gloGuidePublic 分頁測試（cursor offset＋nextCursor 新合同）——DB／DTO 全部 mock，唔掂真 DB。
 *
 * 覆蓋重點：
 * ─ listPublishedGuides 直達 DB 嘅查詢合同：status='published'、publishedAt desc、
 *   bounded limit（clamp 1–50）同非負整數 offset；
 * ─ gloGuide.list caller：{limit:2,cursor:0} → 第一頁＋nextCursor=2；cursor=2 續頁
 *   唔重複；最後 partial page → nextCursor=null；
 * ─ 唔帶 cursor ＝ offset 0；舊 caller 嘅 {items} shape 不變，nextCursor 純 additive；
 * ─ full page 之後 empty page：nextCursor 照指下一頁，要多 fetch 一次先見 null
 *   （已知簡化行為，呢度 test 文件化）；
 * ─ zod 輸入閘：limit/cursor 越界或非整數 → BAD_REQUEST，DB 完全冇被調用。
 *
 * Mock 策略：
 * ─ ./queries/connection getDb → Proxy chain（記錄 where/limit/offset/orderBy，
 *   結果由 queue 順序出隊；articles list 之後每篇 loadPublicAssets 行 links＋images
 *   兩個 select，links 空 → products 查詢 skip）；
 * ─ ./gloGuideDto toGuideListItem/toGuideDetail → 直通 {id, slug}，fixture 只需
 *   {id, slug, title}，唔使砌 full article row；
 * ─ ./productAiContent、./auth（auth.ts 會 import dotenv/config）→ mock 走。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// ───────────────────────── mock 基礎設施（hoisted）─────────────────────────
const h = vi.hoisted(() => {
  type Rec = {
    where?: unknown;
    limit?: number;
    offset?: number;
    orderBy?: unknown[];
  };
  const state = {
    /** 每次 await select chain 嘅結果（順序出隊；空 queue 當 []） */
    queue: [] as unknown[][],
    selects: [] as Rec[],
  };
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
            if (prop === "offset") rec.offset = args[0] as number;
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
// DTO mapper mock：list fixture 只需 {id, slug, title}，唔使砌 full article/product/image row
vi.mock("./gloGuideDto", () => ({
  toGuideListItem: vi.fn((article: { id: number; slug: string }) => ({
    id: article.id,
    slug: article.slug,
  })),
  toGuideDetail: vi.fn((article: { id: number; slug: string }) => ({
    id: article.id,
    slug: article.slug,
  })),
}));

import { gloGuidePublicRouter, listPublishedGuides } from "./gloGuidePublic";
import type { GuideListItem } from "@contracts/gloGuide";

const dialect = new PgDialect();
const sqlText = (value: unknown) => dialect.sqlToQuery(value as never);

function caller() {
  return gloGuidePublicRouter.createCaller({
    req: new Request("http://test.local/api/trpc"),
    resHeaders: new Headers(),
  });
}

function article(id: number) {
  return { id, slug: `guide-${id}`, title: `第 ${id} 期` };
}

/**
 * 排一頁文章入 queue：articles list select ＋ 每篇 loadPublicAssets 嘅
 * links／images 兩個 select（links 回空 → products 查詢被 skip，所以唔使再排）。
 */
function pushPage(rows: { id: number; slug: string; title: string }[]) {
  h.state.queue.push(rows);
  for (const _ of rows) h.state.queue.push([], []);
}

/** 净係 articles list 嘅 select 會 call .limit()；靠呢點抽返佢（攞最近一次，支援連續多頁斷言） */
const articlesSelect = () =>
  [...h.state.selects].reverse().find((s) => s.limit !== undefined);

beforeEach(() => {
  h.state.queue = [];
  h.state.selects = [];
  vi.clearAllMocks();
});

describe("listPublishedGuides：DB 查詢合同", () => {
  it("status='published'＋publishedAt desc＋limit/offset 原樣直達 DB", async () => {
    pushPage([]);
    const items = await listPublishedGuides(2, 4);
    expect(items).toEqual([]);

    const q = articlesSelect();
    expect(q).toBeDefined();
    expect(q!.limit).toBe(2);
    expect(q!.offset).toBe(4);

    const where = sqlText(q!.where);
    expect(where.sql).toContain("status");
    expect(where.params).toContain("published");

    expect(q!.orderBy).toHaveLength(1);
    const order = sqlText(q!.orderBy![0]);
    expect(order.sql).toContain("publishedAt");
    expect(order.sql.toLowerCase()).toContain("desc");
  });

  it("預設 limit=12/offset=0；limit clamp 1–50；負數／小數 offset 歸 0／floor", async () => {
    pushPage([]);
    await listPublishedGuides();
    expect(articlesSelect()!.limit).toBe(12);
    expect(articlesSelect()!.offset).toBe(0);

    pushPage([]);
    await listPublishedGuides(9999, -5);
    expect(articlesSelect()!.limit).toBe(50);
    expect(articlesSelect()!.offset).toBe(0);

    pushPage([]);
    await listPublishedGuides(0, 7.9);
    expect(articlesSelect()!.limit).toBe(1);
    expect(articlesSelect()!.offset).toBe(7);
  });

  it("每篇文章各加載 links＋images（links 空 skip products），DTO mapper 逐篇調用", async () => {
    pushPage([article(1), article(2)]);
    const items = await listPublishedGuides(2, 0);
    expect(items).toEqual([
      { id: 1, slug: "guide-1" },
      { id: 2, slug: "guide-2" },
    ]);
    // 1 個 articles list select ＋ 2 篇 × 2 個（links／images）＝ 5
    expect(h.state.selects).toHaveLength(5);
    const { toGuideListItem } = await import("./gloGuideDto");
    expect(toGuideListItem).toHaveBeenCalledTimes(2);
  });
});

describe("gloGuide.list caller：cursor 分頁", () => {
  it("{limit:2,cursor:0} → 第一頁＋nextCursor=2；cursor=2 續頁唔重複；partial page → nextCursor=null", async () => {
    // 5 篇：2 ＋ 2 ＋ 1（最後 partial）
    pushPage([article(1), article(2)]);
    const page1 = await caller().list({ limit: 2, cursor: 0 });
    expect(page1.items).toEqual([
      { id: 1, slug: "guide-1" },
      { id: 2, slug: "guide-2" },
    ]);
    expect(page1.nextCursor).toBe(2);
    // cursor 以 offset 形式直達 DB
    expect(articlesSelect()!.offset).toBe(0);

    pushPage([article(3), article(4)]);
    const page2 = await caller().list({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toEqual([
      { id: 3, slug: "guide-3" },
      { id: 4, slug: "guide-4" },
    ]);
    expect(page2.nextCursor).toBe(4);
    expect(articlesSelect()!.offset).toBe(2);
    // 兩頁冇重複
    const slugs1 = page1.items.map((i: GuideListItem) => i.slug);
    expect(
      page2.items.map((i: GuideListItem) => i.slug).some((s: string) => slugs1.includes(s)),
    ).toBe(false);

    pushPage([article(5)]);
    const page3 = await caller().list({ limit: 2, cursor: page2.nextCursor! });
    expect(page3.items).toEqual([{ id: 5, slug: "guide-5" }]);
    expect(page3.nextCursor).toBeNull();
    expect(articlesSelect()!.offset).toBe(4);
  });

  it("唔帶 cursor ＝ offset 0；舊 caller {items} shape 不變，nextCursor 係 additive 新欄", async () => {
    pushPage([article(1), article(2)]);
    const res = await caller().list({ limit: 2 });
    expect(res.items).toHaveLength(2);
    expect(res.nextCursor).toBe(2);
    expect(articlesSelect()!.offset).toBe(0);
    // 舊解構方式 const { items } = await ...list(...) 仍然成立
    const { items } = res;
    expect(items.map((i: GuideListItem) => i.slug)).toEqual(["guide-1", "guide-2"]);
  });

  it("完全唔帶 input：預設 limit=12／offset=0，不足一頁 → nextCursor=null", async () => {
    pushPage([article(1)]);
    const res = await caller().list();
    expect(res).toEqual({ items: [{ id: 1, slug: "guide-1" }], nextCursor: null });
    expect(articlesSelect()!.limit).toBe(12);
    expect(articlesSelect()!.offset).toBe(0);
  });

  it("full page 之後 empty page：nextCursor 照指下一頁，多 fetch 一次先見 null（已知簡化行為）", async () => {
    // 啱啱好 4 篇：cursor=2 回滿 2 篇時已經係尾，但 nextCursor 仍然 = 4；
    // 要再 fetch cursor=4 攞到空頁先回 nextCursor=null。
    // ⚠️ 呢個係「items.length===limit 就當有下一頁」嘅簡化換嚟嘅多一次請求，test 文件化。
    pushPage([article(3), article(4)]);
    const page = await caller().list({ limit: 2, cursor: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe(4);

    pushPage([]);
    const empty = await caller().list({ limit: 2, cursor: page.nextCursor! });
    expect(empty.items).toEqual([]);
    expect(empty.nextCursor).toBeNull();
  });

  it("非法輸入（limit 0／51／小數；cursor 負數／小數／超上限）→ BAD_REQUEST，DB 冇被調用", async () => {
    for (const input of [
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { cursor: -1 },
      { cursor: 0.5 },
      { cursor: 100_001 },
    ]) {
      await expect(caller().list(input)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(h.state.selects).toHaveLength(0);
  });
});
