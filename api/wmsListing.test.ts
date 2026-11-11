import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Context } from "hono";

const h = vi.hoisted(() => {
  const state = {
    batchFind: [] as unknown[],
    productFind: [] as unknown[],
    select: [] as unknown[],
    insert: [] as unknown[],
    update: [] as unknown[],
    del: [] as unknown[],
    inserts: [] as Array<{ table: unknown; values?: unknown }>,
    updates: [] as Array<{ table: unknown; set?: Record<string, unknown> }>,
  };
  const settle = (queue: unknown[]) => {
    const value = queue.length > 0 ? queue.shift() : [];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };
  function chain(queue: unknown[], rec?: { set?: Record<string, unknown>; values?: unknown }) {
    const proxy: any = new Proxy({}, {
      get(_target, prop) {
        if (prop === "then") return (resolve: any, reject: any) => settle(queue).then(resolve, reject);
        if (prop === "catch") return (fn: any) => settle(queue).catch(fn);
        return (...args: any[]) => {
          if (rec && prop === "set") rec.set = args[0];
          if (rec && prop === "values") rec.values = args[0];
          return proxy;
        };
      },
    });
    return proxy;
  }
  const db: any = {
    query: {
      listingBatches: { findFirst: () => state.batchFind.length > 0 ? settle(state.batchFind) : Promise.resolve(null) },
      products: { findFirst: () => state.productFind.length > 0 ? settle(state.productFind) : Promise.resolve(null) },
    },
    select: () => chain(state.select),
    insert: (table: unknown) => {
      const rec: { table: unknown; values?: unknown } = { table };
      state.inserts.push(rec);
      return chain(state.insert, rec);
    },
    update: (table: unknown) => {
      const rec: { table: unknown; set?: Record<string, unknown> } = { table };
      state.updates.push(rec);
      return chain(state.update, rec);
    },
    delete: () => chain(state.del),
  };
  return {
    state,
    db,
    logAudit: vi.fn(async () => undefined),
    archiveProductImages: vi.fn(async () => undefined),
  };
});

vi.mock("./queries/connection", () => ({ getDb: () => h.db }));
vi.mock("./audit", () => ({ logAudit: h.logAudit }));
vi.mock("./productsRouter", () => ({ archiveProductImages: h.archiveProductImages }));

import { listingBatchItems, listingBatches, products } from "@db/schema";
import { wmsListingBatch } from "./wmsListing";

const makeBatch = (overrides: Record<string, unknown> = {}) => ({
  id: 5,
  batchNo: "LB20261026-501",
  liveDate: "20261026",
  liveSession: "1",
  status: "approved",
  itemCount: 1,
  requestedBy: "員工A",
  reviewedBy: "主管",
  reviewNote: null,
  createdAt: new Date("2026-10-26T10:00:00Z"),
  updatedAt: new Date("2026-10-26T10:00:00Z"),
  ...overrides,
});

const makeProduct = (overrides: Record<string, unknown> = {}) => ({
  id: 88,
  sku: "SKU-A",
  name: "原有品名",
  image: "/uploads/old-a.jpg",
  photos: ["/uploads/old-a.jpg", "/uploads/old-b.jpg"],
  category: "top",
  ...overrides,
});

const makeItem = (sku = "SKU-A", overrides: Record<string, unknown> = {}) => ({
  sku,
  name: "測試品名",
  price: 100,
  stock: 20,
  category: "top",
  imageUrl: "/uploads/new.jpg",
  ...overrides,
});

const payload = (items: unknown[] = [makeItem()], batchNo = "LB20261026-501") => ({
  secret: "test-secret",
  action: "execute",
  batch: {
    batchNo,
    liveDate: "20261026",
    liveSession: "1",
    requestedBy: "員工A",
    reviewedBy: "主管",
    items,
  },
});

async function invoke(body: unknown) {
  const c = {
    req: { json: async () => body },
    json: (data: unknown, status = 200) => ({ data, status }),
  } as unknown as Context;
  return await wmsListingBatch(c) as unknown as { data: any; status: number };
}

beforeEach(() => {
  for (const key of ["batchFind", "productFind", "select", "insert", "update", "del", "inserts", "updates"] as const) {
    h.state[key].length = 0;
  }
  h.logAudit.mockClear();
  h.archiveProductImages.mockClear();
  vi.stubEnv("WMS_CALLBACK_SECRET", "test-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("wmsListingBatch — 同批重複、冪等結果及同時送入", () => {
  it("同批重複 SKU：400 拒絕，唔會由後項冚前項", async () => {
    const res = await invoke(payload([makeItem("SKU-D"), makeItem("sku-d")]));
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("重複");
    expect(h.state.inserts).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it("已完成批次重送：already:true 同時回返原本逐件 results", async () => {
    h.state.batchFind.push(makeBatch());
    h.state.select.push([{ sku: "SKU-A", status: "created", error: null }]);
    const res = await invoke(payload());
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ ok: true, already: true });
    expect(res.data.results).toEqual([{ sku: "SKU-A", status: "created" }]);
    expect(h.state.inserts).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it("同 batchNo 同時 insert 撞 unique：若先手已完成，回同一組結果而唔係 500", async () => {
    h.state.batchFind.push(null, makeBatch({ id: 6, status: "approved" }));
    h.state.insert.push([]); // onConflictDoNothing + returning：第二個請求冇新列
    h.state.select.push([{ sku: "SKU-A", status: "updated", error: null }]);
    const res = await invoke(payload());
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ ok: true, already: true });
    expect(res.data.results[0]).toMatchObject({ sku: "SKU-A", status: "updated" });
  });
});

describe("wmsListingBatch — 同 SKU 更新、失敗重試及商品 upsert 競態", () => {
  it("第二批同一 SKU：更新原有商品場次，唔會新增第二件", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11 }], []); // 新批次、listingBatchItems
    h.state.productFind.push(makeProduct());
    h.state.update.push([], [], []); // 商品 update、心跳、批次完成
    const body = payload();
    (body.batch as any).liveSession = "2";
    const res = await invoke(body);
    expect(res.data.results).toEqual([{ sku: "SKU-A", status: "updated" }]);
    expect(h.state.inserts.some((row) => row.table === products)).toBe(false);
    const productUpdate = h.state.updates.find((row) => row.table === products);
    expect(productUpdate?.set).toMatchObject({ liveDate: "20261026", liveSession: "2", isActive: true });
  });

  it("舊批有失敗件可同批重試；保留相簿並清走舊定時下架", async () => {
    h.state.batchFind.push(makeBatch());
    h.state.select.push([{ sku: "SKU-A", status: "failed", error: "上次失敗" }]);
    h.state.update.push(
      [{ id: 5 }], // approved -> processing claim
      [], // 商品 update
      [], // 心跳
      [], // 最終 approved
    );
    h.state.del.push([]);
    h.state.productFind.push(makeProduct());
    h.state.insert.push([]); // 重試明細
    const res = await invoke(payload());
    expect(res.data.results).toEqual([{ sku: "SKU-A", status: "updated" }]);
    const productUpdate = h.state.updates.find((row) => row.table === products);
    expect(productUpdate?.set).toMatchObject({
      delistEnabled: false,
      delistAt: null,
      photos: ["/uploads/new.jpg", "/uploads/old-a.jpg", "/uploads/old-b.jpg"],
    });
    expect(h.archiveProductImages).toHaveBeenCalledWith(
      "SKU-A",
      "測試品名",
      "/uploads/new.jpg",
      ["/uploads/new.jpg", "/uploads/old-a.jpg", "/uploads/old-b.jpg"],
    );
    const batchUpdates = h.state.updates.filter((row) => row.table === listingBatches);
    expect(batchUpdates[0].set?.status).toBe("processing");
    expect(batchUpdates.at(-1)?.set?.status).toBe("approved");
    expect(h.state.inserts.some((row) => row.table === listingBatchItems)).toBe(true);
  });

  it("兩批同時上架同一新 SKU：insert unique 後重查並 update，唔會誤記 failed", async () => {
    h.state.batchFind.push(null);
    const unique = Object.assign(new Error("duplicate key"), { code: "23505" });
    h.state.insert.push([{ id: 12 }], unique, []); // 批次、商品 insert 撞 unique、明細
    h.state.productFind.push(null, makeProduct({ id: 89 }));
    h.state.update.push([], [], []); // 商品 update、心跳、批次完成
    const res = await invoke(payload());
    expect(res.data.results).toEqual([{ sku: "SKU-A", status: "updated" }]);
    expect(res.data.results[0].error).toBeUndefined();
    const productUpdate = h.state.updates.find((row) => row.table === products);
    expect(productUpdate?.set?.liveSession).toBe("1");
  });
});


describe("wmsListingBatch — AI 內容合約（approved 閘＋寫入）", () => {
  const aiItem = (overrides: Record<string, unknown> = {}) =>
    makeItem("SKU-A", {
      description: "AI 寫嘅靚衫描述",
      aiTags: ["直播熱賣", "新品"],
      aiContentApproved: true,
      ...overrides,
    });

  it("帶 description／aiTags 但冇 aiContentApproved → 400，唔郁 DB", async () => {
    const res = await invoke(payload([makeItem("SKU-A", { description: "未批" })]));
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("aiContentApproved");
    expect(h.state.inserts).toHaveLength(0);
    const res2 = await invoke(payload([makeItem("SKU-A", { aiTags: ["x"], aiContentApproved: false })]));
    expect(res2.status).toBe(400);
  });

  it("approved=true 但批次冇 reviewedBy → 400", async () => {
    const body = payload([aiItem()]);
    delete (body.batch as Record<string, unknown>).reviewedBy;
    const res = await invoke(body);
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("reviewedBy");
    expect(h.state.inserts).toHaveLength(0);
  });

  it("超長描述／超標 tags 就算批准咗都拒絕", async () => {
    const long = await invoke(payload([aiItem({ description: "字".repeat(501) })]));
    expect(long.status).toBe(400);
    expect(long.data.error).toContain("最長");
    const many = await invoke(payload([aiItem({ aiTags: ["a", "b", "c", "d", "e", "f"] })]));
    expect(many.status).toBe(400);
    const longTag = await invoke(payload([aiItem({ aiTags: ["標".repeat(13)] })]));
    expect(longTag.status).toBe(400);
  });

  it("舊批冇 AI 三欄完全向後相容（照樣過閘、照樣冪等）", async () => {
    h.state.batchFind.push(makeBatch());
    h.state.select.push([{ sku: "SKU-A", status: "created", error: null }]);
    const res = await invoke(payload()); // 冇 description／aiTags／aiContentApproved
    expect(res.status).toBe(200);
    expect(res.data.already).toBe(true);
    expect(res.data.results).toEqual([{ sku: "SKU-A", status: "created" }]);
  });

  it("更新現有商品：approved 描述＋tags 寫入，控制字元清走，aiTagsEnabled 絕對唔郁", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11 }], []); // 新批次、listingBatchItems
    h.state.productFind.push(makeProduct({ aiTagsEnabled: false })); // 後台停用咗
    h.state.update.push([], [], []); // 商品 update、心跳、批次完成
    const res = await invoke(payload([aiItem({ description: "AI 描述" })]));
    expect(res.data.results).toEqual([{ sku: "SKU-A", status: "updated" }]);
    const productUpdate = h.state.updates.find((row) => row.table === products);
    expect(productUpdate?.set?.description).toBe("AI 描述");
    expect(productUpdate?.set?.aiTags).toBe('["直播熱賣","新品"]');
    // 後台停用唔會被重推復活
    expect(productUpdate?.set).not.toHaveProperty("aiTagsEnabled");
    // 明細快照對齊
    const detail = h.state.inserts.find((row) => row.table === listingBatchItems);
    expect(detail?.values).toMatchObject({ aiDescription: "AI 描述", aiTags: '["直播熱賣","新品"]' });
  });

  it("空字串 description＝清 AI 描述（products 存 NULL）；空 aiTags array 寫 []", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11 }], []);
    h.state.productFind.push(makeProduct({ description: "舊 AI 描述" }));
    h.state.update.push([], [], []);
    const res = await invoke(payload([aiItem({ description: "", aiTags: [] })]));
    expect(res.data.results).toEqual([{ sku: "SKU-A", status: "updated" }]);
    const productUpdate = h.state.updates.find((row) => row.table === products);
    expect(productUpdate?.set?.description).toBeNull();
    expect(productUpdate?.set?.aiTags).toBe("[]");
  });

  it("新商品：approved payload 寫入 description／aiTags；唔帶 AI 欄就唔寫", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11 }], [{ id: 55 }], []); // 批次、商品、明細
    h.state.productFind.push(null); // 新貨號
    h.state.update.push([], []); // 心跳、批次完成
    const res = await invoke(payload([aiItem()]));
    expect(res.data.results).toEqual([{ sku: "SKU-A", status: "created" }]);
    const productInsert = h.state.inserts.find((row) => row.table === products);
    expect(productInsert?.values).toMatchObject({
      description: "AI 寫嘅靚衫描述",
      aiTags: '["直播熱賣","新品"]',
    });
    // enabled 跟 schema default true，insert 唔會指定
    expect(productInsert?.values).not.toHaveProperty("aiTagsEnabled");
  });

  it("reject：有 approved 內容照記快照；冇帶內容就 null", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 7 }], []); // rejected 批次、明細
    const res = await invoke({
      secret: "test-secret",
      action: "reject",
      batch: {
        batchNo: "LB20261026-777",
        liveDate: "20261026",
        liveSession: "1",
        requestedBy: "員工A",
        reviewedBy: "主管",
        items: [aiItem(), makeItem("SKU-B")],
      },
    });
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    const detail = h.state.inserts.find((row) => row.table === listingBatchItems);
    const values = detail?.values as Array<Record<string, unknown>>;
    expect(values[0]).toMatchObject({ aiDescription: "AI 寫嘅靚衫描述", aiTags: '["直播熱賣","新品"]' });
    expect(values[1]).toMatchObject({ aiDescription: null, aiTags: null });
  });
});


describe("wmsListingBatch — processing 鎖及 timestamp 精度安全恢復", () => {
  it("新鮮 processing：409，唔會刪明細或重複上架", async () => {
    h.state.batchFind.push(makeBatch({ status: "processing", updatedAt: new Date() }));
    const res = await invoke(payload());
    expect(res.status).toBe(409);
    expect(res.data.error).toContain("正在官網處理");
    expect(h.state.inserts).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it.each([
    { status: "rejected", updatedAt: new Date("2026-10-26T10:00:00Z"), label: "拒絕後改批准" },
    { status: "processing", updatedAt: new Date(Date.now() - 180_000), label: "stale processing 恢復" },
  ])("$label：可原子認領，唔會被 DB 微秒／JS 毫秒差異卡死", async ({ status, updatedAt }) => {
    const source = readFileSync(new URL("./wmsListing.ts", import.meta.url), "utf8");
    expect(source).not.toContain("eq(listingBatches.updatedAt, existingBatch.updatedAt)");
    expect(source).toContain("lt(listingBatches.updatedAt, staleBefore)");

    h.state.batchFind.push(makeBatch({ status, updatedAt }));
    h.state.update.push(
      [{ id: 5 }], // claim
      [], // 商品 update
      [], // 心跳
      [], // 最終 approved
    );
    h.state.del.push([]);
    h.state.productFind.push(makeProduct());
    h.state.insert.push([]); // 重試明細
    const res = await invoke(payload());
    expect(res.status).toBe(200);
    expect(res.data.results).toEqual([{ sku: "SKU-A", status: "updated" }]);
    expect(h.state.updates[0].set?.status).toBe("processing");
    expect(h.state.updates.filter((row) => row.table === listingBatches).at(-1)?.set?.status).toBe("approved");
  });
});
