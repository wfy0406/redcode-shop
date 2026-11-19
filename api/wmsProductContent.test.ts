import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

const h = vi.hoisted(() => {
  const state = {
    batchFind: [] as unknown[],
    productFind: [] as unknown[],
    select: [] as unknown[],
    insert: [] as unknown[],
    update: [] as unknown[],
    del: [] as unknown[],
    txSelect: [] as unknown[],
    txUpdate: [] as unknown[],
    inserts: [] as Array<{ table: unknown; values?: unknown }>,
    updates: [] as Array<{ table: unknown; set?: Record<string, unknown> }>,
    txUpdates: [] as Array<{ table: unknown; set?: Record<string, unknown> }>,
    transactions: 0,
  };
  const settle = (queue: unknown[]) => {
    const value = queue.length ? queue.shift() : [];
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
  const tx: any = {
    select: () => chain(state.txSelect),
    update: (table: unknown) => {
      const rec: { table: unknown; set?: Record<string, unknown> } = { table };
      state.txUpdates.push(rec);
      return chain(state.txUpdate, rec);
    },
  };
  const db: any = {
    query: {
      listingBatches: { findFirst: () => settle(state.batchFind) },
      products: { findFirst: () => settle(state.productFind) },
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
    transaction: async (fn: (tx: unknown) => unknown) => {
      state.transactions += 1;
      return fn(tx);
    },
  };
  return { state, db, logAudit: vi.fn(async () => undefined) };
});

vi.mock("./queries/connection", () => ({ getDb: () => h.db }));
vi.mock("./audit", () => ({ logAudit: h.logAudit }));

import { listingBatchItems, listingBatches, products } from "@db/schema";
import { wmsProductContentBatch } from "./wmsProductContent";

const SOURCE_TIME = "2026-11-10T11:06:55.659Z";
const makeItem = (overrides: Record<string, unknown> = {}) => ({
  sku: "SKU-A",
  name: "測試商品",
  sourceContentUpdatedAt: SOURCE_TIME,
  description: "圖片見到嘅真描述。襯淨色長褲就得。",
  aiTags: ["圖案", "長袖"],
  aiContentApproved: true,
  ...overrides,
});
const makeProduct = (overrides: Record<string, unknown> = {}) => ({
  id: 88,
  sku: "SKU-A",
  name: "測試商品",
  description: null,
  aiTags: null,
  contentUpdatedAt: new Date(SOURCE_TIME),
  image: "/uploads/original.jpg",
  price: 123,
  stock: 20,
  category: "top",
  liveDate: "20261110",
  liveSession: "2",
  ...overrides,
});
const makeBatch = (overrides: Record<string, unknown> = {}) => ({
  id: 5,
  batchNo: "LC20261119-001",
  liveDate: null,
  liveSession: null,
  status: "approved",
  itemCount: 1,
  requestedBy: "員工A",
  reviewedBy: "主管",
  reviewNote: null,
  createdAt: new Date(SOURCE_TIME),
  updatedAt: new Date(SOURCE_TIME),
  ...overrides,
});
const payload = (action = "execute", item = makeItem()) => ({
  secret: "test-secret",
  action,
  batch: {
    batchNo: "LC20261119-001",
    requestedBy: "員工A",
    reviewedBy: "主管",
    items: [item],
  },
});

async function invoke(body: unknown) {
  const c = {
    req: { json: async () => body },
    json: (data: unknown, status = 200) => ({ data, status }),
  } as unknown as Context;
  return await wmsProductContentBatch(c) as unknown as { data: any; status: number };
}

beforeEach(() => {
  for (const key of [
    "batchFind", "productFind", "select", "insert", "update", "del", "txSelect", "txUpdate",
    "inserts", "updates", "txUpdates",
  ] as const) h.state[key].length = 0;
  h.state.transactions = 0;
  h.logAudit.mockClear();
  vi.stubEnv("WMS_CALLBACK_SECRET", "test-secret");
});

afterEach(() => vi.unstubAllEnvs());

describe("商品內容專用批：批准閘同白名單", () => {
  it("未批准／冒寫其他商品欄位／非內容批格式，一律 400 唔掂 DB", async () => {
    const unapproved = await invoke(payload("execute", makeItem({ aiContentApproved: false })));
    expect(unapproved.status).toBe(400);
    const extra = await invoke(payload("execute", makeItem({ price: 1, imageUrl: "/x.jpg" })));
    expect(extra.status).toBe(400);
    expect(extra.data.error).toContain("非內容欄位");
    const body = payload();
    body.batch.batchNo = "LB20261119-001";
    expect((await invoke(body)).status).toBe(400);
    expect(h.state.inserts).toHaveLength(0);
    expect(h.state.txUpdates).toHaveLength(0);
  });

  it("秘密唔啱 401；描述空白、tags 重複或快照時間唔精確都拒絕", async () => {
    const badSecret = payload();
    badSecret.secret = "wrong";
    expect((await invoke(badSecret)).status).toBe(401);
    expect((await invoke(payload("execute", makeItem({ description: "  " })))).status).toBe(400);
    expect((await invoke(payload("execute", makeItem({ aiTags: ["a", " a "] })))).status).toBe(400);
    expect((await invoke(payload("execute", makeItem({ sourceContentUpdatedAt: "2026-11-10" })))).status).toBe(400);
  });
});

describe("dry-run：唯讀預檢", () => {
  it("合資格 null 描述顯示將更新，唔寫批次、商品或 audit", async () => {
    h.state.productFind.push(makeProduct());
    const res = await invoke(payload("dry-run"));
    expect(res.data).toMatchObject({ ok: true, dryRun: true });
    expect(res.data.results).toEqual([{ sku: "SKU-A", status: "updated" }]);
    expect(h.state.inserts).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
    expect(h.state.txUpdates).toHaveLength(0);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("已有描述、品名唔同、舊快照、商品唔存在，逐件如實報失敗", async () => {
    h.state.productFind.push(
      makeProduct({ description: "後來人工描述" }),
      makeProduct({ name: "另一件" }),
      makeProduct({ contentUpdatedAt: new Date("2026-11-11T00:00:00.000Z") }),
      null,
    );
    const body = payload("dry-run");
    body.batch.items = [makeItem(), makeItem({ sku: "SKU-B" }), makeItem({ sku: "SKU-C" }), makeItem({ sku: "SKU-D" })];
    const res = await invoke(body);
    expect(res.data.ok).toBe(false);
    expect(res.data.results.map((r: any) => r.status)).toEqual(["failed", "failed", "failed", "failed"]);
    expect(res.data.results.map((r: any) => r.error)).toEqual([
      "商品已有描述，拒絕覆寫", "品名同快照唔一致", "商品內容快照已過期，請重新檢視", "搵唔到商品；內容批唔會新建商品",
    ]);
  });
});

describe("execute：只改三欄、讀回、冪等", () => {
  it("正式寫入只含 description／aiTags／contentUpdatedAt，其他商品欄逐項唔准出現", async () => {
    const current = makeProduct();
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11 }], []);
    h.state.txSelect.push(
      [current],
      [{ description: "圖片見到嘅真描述。襯淨色長褲就得。", aiTags: '["圖案","長袖"]' }],
    );
    h.state.txUpdate.push([]);
    h.state.update.push([], []);
    const res = await invoke(payload());
    expect(res.data).toEqual({ ok: true, results: [{ sku: "SKU-A", status: "updated" }] });
    expect(h.state.transactions).toBe(1);
    const productUpdate = h.state.txUpdates.find((row) => row.table === products);
    expect(Object.keys(productUpdate?.set ?? {}).sort()).toEqual(["aiTags", "contentUpdatedAt", "description"]);
    for (const forbidden of [
      "image", "photos", "price", "discountPrice", "stock", "sizes", "sizeEnabled", "category",
      "liveDate", "liveSession", "listedDate", "isActive", "delistEnabled", "delistAt", "aiTagsEnabled",
    ]) expect(productUpdate?.set).not.toHaveProperty(forbidden);
    expect(h.state.inserts.some((row) => row.table === products)).toBe(false);
    const itemLog = h.state.inserts.find((row) => row.table === listingBatchItems);
    expect(itemLog?.values).toMatchObject({
      batchId: 11,
      sku: "SKU-A",
      productId: 88,
      status: "updated",
      aiDescription: "圖片見到嘅真描述。襯淨色長褲就得。",
      aiTags: '["圖案","長袖"]',
    });
    expect(h.logAudit).toHaveBeenCalledOnce();
  });

  it("舊快照會 failed，唔寫商品；同批修正後可重試", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11 }], []);
    h.state.txSelect.push([makeProduct({ contentUpdatedAt: new Date("2026-11-11T00:00:00.000Z") })]);
    h.state.update.push([], []);
    const res = await invoke(payload());
    expect(res.data.ok).toBe(false);
    expect(res.data.results[0]).toMatchObject({ status: "failed", error: "商品內容快照已過期，請重新檢視" });
    expect(h.state.txUpdates).toHaveLength(0);
    const itemLog = h.state.inserts.find((row) => row.table === listingBatchItems);
    expect(itemLog?.values).toMatchObject({ status: "failed" });
  });

  it("內容已一樣就 unchanged，唔再寫商品；aiTagsEnabled 開關唔會復活", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11 }], []);
    h.state.txSelect.push([makeProduct({
      description: "圖片見到嘅真描述。襯淨色長褲就得。",
      aiTags: '["圖案","長袖"]',
      aiTagsEnabled: false,
      contentUpdatedAt: new Date("2026-11-18T00:00:00.000Z"),
    })]);
    h.state.update.push([], []);
    const res = await invoke(payload());
    expect(res.data.results).toEqual([{ sku: "SKU-A", status: "unchanged" }]);
    expect(h.state.txUpdates).toHaveLength(0);
  });

  it("寫後讀回唔一致會報 failed；唔會假裝成功", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11 }], []);
    h.state.txSelect.push(
      [makeProduct()],
      [{ description: "唔同內容", aiTags: null }],
    );
    h.state.txUpdate.push([]);
    h.state.update.push([], []);
    const res = await invoke(payload());
    expect(res.data.ok).toBe(false);
    expect(res.data.results[0].status).toBe("failed");
    expect(res.data.results[0].error).toContain("讀回不一致");
  });

  it("成功批重送回 already 同原結果；同 batchNo 換內容就 409", async () => {
    h.state.batchFind.push(makeBatch());
    h.state.select.push([{
      sku: "SKU-A",
      name: "測試商品",
      aiDescription: "圖片見到嘅真描述。襯淨色長褲就得。",
      aiTags: '["圖案","長袖"]',
      status: "updated",
      error: null,
    }]);
    const res = await invoke(payload());
    expect(res.data).toEqual({ ok: true, already: true, results: [{ sku: "SKU-A", status: "updated" }] });
    expect(h.state.txUpdates).toHaveLength(0);

    h.state.batchFind.push(makeBatch());
    h.state.select.push([{
      sku: "SKU-A",
      name: "測試商品",
      aiDescription: "舊批內容",
      aiTags: '["舊"]',
      status: "updated",
      error: null,
    }]);
    const conflict = await invoke(payload());
    expect(conflict.status).toBe(409);
    expect(conflict.data.error).toContain("內容唔一致");
  });

  it("唔可以重用一般上架批 batchNo，亦唔可以越過進行中批", async () => {
    h.state.batchFind.push(makeBatch({ liveDate: "20261119", liveSession: "1" }));
    expect((await invoke(payload())).status).toBe(409);
    h.state.batchFind.push(makeBatch({ status: "processing", updatedAt: new Date() }));
    expect((await invoke(payload())).status).toBe(409);
    expect(h.state.txUpdates).toHaveLength(0);
  });
});
