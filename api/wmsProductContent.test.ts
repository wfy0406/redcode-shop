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
    txInsert: [] as unknown[],
    inserts: [] as Array<{ table: unknown; values?: unknown }>,
    updates: [] as Array<{ table: unknown; set?: Record<string, unknown> }>,
    txUpdates: [] as Array<{ table: unknown; set?: Record<string, unknown> }>,
    txInserts: [] as Array<{ table: unknown; values?: unknown }>,
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
    insert: (table: unknown) => {
      const rec: { table: unknown; values?: unknown } = { table };
      state.txInserts.push(rec);
      return chain(state.txInsert, rec);
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
const APPLIED_TIME = "2026-11-19T10:00:00.000Z";
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
const makeClaimRow = () => ({ status: "processing", updatedAt: new Date(APPLIED_TIME) });
const makeStoredItem = (overrides: Record<string, unknown> = {}) => ({
  id: 501,
  sku: "SKU-A",
  name: "測試商品",
  aiDescription: "圖片見到嘅真描述。襯淨色長褲就得。",
  aiTags: '["圖案","長袖"]',
  productId: 88,
  status: "updated",
  error: null,
  previousDescription: null,
  previousAiTags: null,
  previousContentUpdatedAt: new Date(SOURCE_TIME),
  contentAppliedAt: new Date(APPLIED_TIME),
  contentRestoredAt: null,
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
    "batchFind", "productFind", "select", "insert", "update", "del", "txSelect", "txUpdate", "txInsert",
    "inserts", "updates", "txUpdates", "txInserts",
  ] as const) h.state[key].length = 0;
  h.state.transactions = 0;
  h.logAudit.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(APPLIED_TIME));
  vi.stubEnv("WMS_CALLBACK_SECRET", "test-secret");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

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
    h.state.insert.push([{ id: 11, updatedAt: new Date(APPLIED_TIME) }], []);
    h.state.txSelect.push(
      [makeClaimRow()],
      [current],
      [{
        description: "圖片見到嘅真描述。襯淨色長褲就得。",
        aiTags: '["圖案","長袖"]',
        contentUpdatedAt: new Date(APPLIED_TIME),
      }],
    );
    h.state.txUpdate.push([]);
    h.state.update.push([{ updatedAt: new Date(APPLIED_TIME) }], [{ id: 11 }]);
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
    const itemLog = h.state.txInserts.find((row) => row.table === listingBatchItems);
    expect(h.state.inserts.some((row) => row.table === listingBatchItems)).toBe(false);
    expect(itemLog?.values).toMatchObject({
      batchId: 11,
      sku: "SKU-A",
      productId: 88,
      status: "updated",
      aiDescription: "圖片見到嘅真描述。襯淨色長褲就得。",
      aiTags: '["圖案","長袖"]',
      previousDescription: null,
      previousAiTags: null,
      previousContentUpdatedAt: new Date(SOURCE_TIME),
      contentAppliedAt: new Date(APPLIED_TIME),
    });
    expect(h.logAudit).toHaveBeenCalledOnce();
  });

  it("舊快照會 failed，唔寫商品；同批修正後可重試", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11, updatedAt: new Date(APPLIED_TIME) }], []);
    h.state.txSelect.push([makeClaimRow()], [makeProduct({ contentUpdatedAt: new Date("2026-11-11T00:00:00.000Z") })]);
    h.state.update.push([{ updatedAt: new Date(APPLIED_TIME) }], [{ id: 11 }]);
    const res = await invoke(payload());
    expect(res.data.ok).toBe(false);
    expect(res.data.results[0]).toMatchObject({ status: "failed", error: "商品內容快照已過期，請重新檢視" });
    expect(h.state.txUpdates).toHaveLength(0);
    const itemLog = h.state.txInserts.find((row) => row.table === listingBatchItems);
    expect(itemLog?.values).toMatchObject({ status: "failed" });
    expect(h.state.inserts.some((row) => row.table === listingBatchItems)).toBe(false);
  });

  it("內容已一樣就 unchanged，唔再寫商品；aiTagsEnabled 開關唔會復活", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11, updatedAt: new Date(APPLIED_TIME) }], []);
    h.state.txSelect.push([makeClaimRow()], [makeProduct({
      description: "圖片見到嘅真描述。襯淨色長褲就得。",
      aiTags: '["圖案","長袖"]',
      aiTagsEnabled: false,
      contentUpdatedAt: new Date("2026-11-18T00:00:00.000Z"),
    })]);
    h.state.update.push([{ updatedAt: new Date(APPLIED_TIME) }], [{ id: 11 }]);
    const res = await invoke(payload());
    expect(res.data.results).toEqual([{ sku: "SKU-A", status: "unchanged" }]);
    expect(h.state.txUpdates).toHaveLength(0);
    expect(h.state.txInserts.find((row) => row.table === listingBatchItems)?.values).toMatchObject({ status: "unchanged" });
    expect(h.state.inserts.some((row) => row.table === listingBatchItems)).toBe(false);
  });

  it("寫後讀回唔一致會報 failed；唔會假裝成功", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11, updatedAt: new Date(APPLIED_TIME) }], []);
    h.state.txSelect.push(
      [makeClaimRow()],
      [makeProduct()],
      [{ description: "唔同內容", aiTags: null }],
      [makeClaimRow()],
      [],
    );
    h.state.txUpdate.push([]);
    h.state.update.push([{ updatedAt: new Date(APPLIED_TIME) }], [{ id: 11 }]);
    const res = await invoke(payload());
    expect(res.data.ok).toBe(false);
    expect(res.data.results[0].status).toBe("failed");
    expect(res.data.results[0].error).toContain("讀回不一致");
    expect(h.state.txInserts.filter((row) => row.table === listingBatchItems)).toHaveLength(1);
    expect(h.state.txInserts[0]?.values).toMatchObject({ status: "failed", contentAppliedAt: null });
    expect(h.state.inserts.some((row) => row.table === listingBatchItems)).toBe(false);
  });

  it("原交易失敗後補記日誌前失去 claim，會 409 而且唔留過時 item log", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11, updatedAt: new Date(APPLIED_TIME) }]);
    h.state.txSelect.push(
      [makeClaimRow()],
      [makeProduct()],
      [{ ...makeClaimRow(), updatedAt: new Date("2026-11-19T10:01:00.000Z") }],
    );
    h.state.txUpdate.push(new Error("product update failed"));
    const res = await invoke(payload());
    expect(res.status).toBe(409);
    expect(res.data.error).toContain("控制權已轉移");
    expect(h.state.txInserts.some((row) => row.table === listingBatchItems)).toBe(false);
    expect(h.state.inserts.some((row) => row.table === listingBatchItems)).toBe(false);
    expect(h.state.updates).toHaveLength(0);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("原交易可能已 commit 而且已有逐件紀錄，會停手對賬，唔加矛盾 failed log", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11, updatedAt: new Date(APPLIED_TIME) }]);
    h.state.txSelect.push(
      [makeClaimRow()],
      [makeProduct()],
      [makeClaimRow()],
      [{ id: 501 }],
    );
    h.state.txUpdate.push(new Error("connection lost after commit"));
    const res = await invoke(payload());
    expect(res.status).toBe(409);
    expect(res.data.error).toContain("原交易結果不明");
    expect(h.state.txInserts.some((row) => row.table === listingBatchItems)).toBe(false);
    expect(h.state.inserts.some((row) => row.table === listingBatchItems)).toBe(false);
    expect(h.state.updates).toHaveLength(0);
    expect(h.logAudit).not.toHaveBeenCalled();
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

  it("部分失敗批唔准刪紀錄重跑，避免抹去已更新商品嘅還原快照", async () => {
    h.state.batchFind.push(makeBatch());
    h.state.select.push([makeStoredItem({ status: "failed", contentAppliedAt: null })]);
    const res = await invoke(payload());
    expect(res.status).toBe(409);
    expect(res.data.error).toContain("保留還原快照");
    expect(h.state.del).toHaveLength(0);
    expect(h.state.txUpdates).toHaveLength(0);
  });

  it("原值快照 log 寫入失敗會令 updated 變 failed，唔會隔離交易假裝成功", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11, updatedAt: new Date(APPLIED_TIME) }], []);
    h.state.txSelect.push(
      [makeClaimRow()],
      [makeProduct()],
      [{ description: "圖片見到嘅真描述。襯淨色長褲就得。", aiTags: '["圖案","長袖"]', contentUpdatedAt: new Date(APPLIED_TIME) }],
      [makeClaimRow()],
      [],
    );
    h.state.txUpdate.push([]);
    h.state.txInsert.push(new Error("snapshot log insert failed"));
    h.state.update.push([{ updatedAt: new Date(APPLIED_TIME) }], [{ id: 11 }]);
    const res = await invoke(payload());
    expect(res.data.ok).toBe(false);
    expect(res.data.results[0]).toMatchObject({ status: "failed", error: "snapshot log insert failed" });
    expect(h.state.txUpdates.filter((row) => row.table === products)).toHaveLength(1);
    expect(h.state.txInserts.filter((row) => row.table === listingBatchItems)).toHaveLength(2);
    expect(h.state.txInserts[1]?.values).toMatchObject({ status: "failed", contentAppliedAt: null });
    expect(h.state.inserts.some((row) => row.table === listingBatchItems)).toBe(false);
  });

  it("stale processing 保留已 commit 前綴，只補跑未留 log 嘅下一件", async () => {
    const body = payload();
    body.batch.items = [makeItem(), makeItem({ sku: "SKU-B" })];
    h.state.batchFind.push(makeBatch({ status: "processing", itemCount: 2, updatedAt: new Date("2026-11-19T00:00:00.000Z") }));
    h.state.select.push([makeStoredItem()]);
    h.state.update.push(
      [{ id: 5, updatedAt: new Date(APPLIED_TIME) }],
      [{ updatedAt: new Date(APPLIED_TIME) }],
      [{ id: 5 }],
    );
    h.state.txSelect.push(
      [makeClaimRow()],
      [makeProduct({ id: 89, sku: "SKU-B" })],
      [{ description: "圖片見到嘅真描述。襯淨色長褲就得。", aiTags: '["圖案","長袖"]', contentUpdatedAt: new Date(APPLIED_TIME) }],
    );
    h.state.txUpdate.push([]);
    const res = await invoke(body);
    expect(res.data).toEqual({ ok: true, results: [{ sku: "SKU-A", status: "updated" }, { sku: "SKU-B", status: "updated" }] });
    expect(h.state.del).toHaveLength(0);
    expect(h.state.txUpdates.filter((row) => row.table === products)).toHaveLength(1);
    expect(h.state.txInserts).toHaveLength(1);
    expect(h.state.txInserts[0]?.values).toMatchObject({ sku: "SKU-B", productId: 89, status: "updated" });
  });

  it("stale resume 商品內容已相同但缺快照，會 failed 要求人工對賬", async () => {
    h.state.batchFind.push(makeBatch({ status: "processing", updatedAt: new Date("2026-11-19T00:00:00.000Z") }));
    h.state.select.push([]);
    h.state.update.push(
      [{ id: 5, updatedAt: new Date(APPLIED_TIME) }],
      [{ updatedAt: new Date(APPLIED_TIME) }],
      [{ id: 5 }],
    );
    h.state.txSelect.push([makeClaimRow()], [makeProduct({
      description: "圖片見到嘅真描述。襯淨色長褲就得。",
      aiTags: '["圖案","長袖"]',
      contentUpdatedAt: new Date(APPLIED_TIME),
    })]);
    const res = await invoke(payload());
    expect(res.data.ok).toBe(false);
    expect(res.data.results[0]).toMatchObject({ status: "failed" });
    expect(res.data.results[0].error).toContain("人工對賬");
    expect(h.state.txUpdates.filter((row) => row.table === products)).toHaveLength(0);
    expect(h.state.txInserts.find((row) => row.table === listingBatchItems)?.values).toMatchObject({ status: "failed" });
    expect(h.state.inserts.some((row) => row.table === listingBatchItems)).toBe(false);
  });

  it("兩個 stale resume 爭批次時，CAS 唔成功嗰個即停，唔掂商品", async () => {
    h.state.batchFind.push(makeBatch({ status: "processing", updatedAt: new Date("2026-11-19T00:00:00.000Z") }));
    h.state.select.push([]);
    h.state.update.push([]);
    const res = await invoke(payload());
    expect(res.status).toBe(409);
    expect(res.data.error).toContain("狀態啱啱更新");
    expect(h.state.transactions).toBe(0);
    expect(h.state.txUpdates).toHaveLength(0);
  });

  it("原批有未知逐件狀態會拒絕，唔會 cast 當成功", async () => {
    h.state.batchFind.push(makeBatch({ status: "processing", updatedAt: new Date("2026-11-19T00:00:00.000Z") }));
    h.state.select.push([makeStoredItem({ status: "mystery" })]);
    const res = await invoke(payload());
    expect(res.status).toBe(409);
    expect(res.data.error).toContain("無法辨認");
    expect(h.state.updates).toHaveLength(0);
    expect(h.state.txUpdates).toHaveLength(0);
  });
  it("approved 批零逐件快照會明確 409，唔准無快照重跑", async () => {
    h.state.batchFind.push(makeBatch());
    h.state.select.push([]);
    const res = await invoke(payload());
    expect(res.status).toBe(409);
    expect(res.data.error).toContain("冇逐件快照");
    expect(h.state.updates).toHaveLength(0);
    expect(h.state.inserts).toHaveLength(0);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("zombie worker 失去 claim token 後即停，零商品寫入、零新 item log、零 audit", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11, updatedAt: new Date(APPLIED_TIME) }]);
    h.state.txSelect.push([{ ...makeClaimRow(), updatedAt: new Date("2026-11-19T10:01:00.000Z") }]);
    const res = await invoke(payload());
    expect(res.status).toBe(409);
    expect(res.data.error).toContain("控制權已轉移");
    expect(h.state.txUpdates).toHaveLength(0);
    expect(h.state.inserts.some((row) => row.table === listingBatchItems)).toBe(false);
    expect(h.state.updates).toHaveLength(0);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("heartbeat CAS 失敗會中止，唔會繼續下一件或寫完成審計", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11, updatedAt: new Date(APPLIED_TIME) }], []);
    h.state.txSelect.push([makeClaimRow()], [makeProduct({ contentUpdatedAt: new Date("2026-11-11T00:00:00.000Z") })]);
    h.state.update.push([]);
    const res = await invoke(payload());
    expect(res.status).toBe(409);
    expect(res.data.error).toContain("控制權已轉移");
    expect(h.state.updates).toHaveLength(1);
    expect(h.state.txInserts.filter((row) => row.table === listingBatchItems)).toHaveLength(1);
    expect(h.state.inserts.some((row) => row.table === listingBatchItems)).toBe(false);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("final approved CAS 失敗唔會寫成功審計", async () => {
    h.state.batchFind.push(null);
    h.state.insert.push([{ id: 11, updatedAt: new Date(APPLIED_TIME) }], []);
    h.state.txSelect.push([makeClaimRow()], [makeProduct({ contentUpdatedAt: new Date("2026-11-11T00:00:00.000Z") })]);
    h.state.update.push([{ updatedAt: new Date(APPLIED_TIME) }], []);
    const res = await invoke(payload());
    expect(res.status).toBe(409);
    expect(res.data.error).toContain("唔會標記完成或寫審計");
    expect(h.state.updates).toHaveLength(2);
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});

describe("商品內容批安全還原", () => {
  const appliedProduct = (overrides: Record<string, unknown> = {}) => makeProduct({
    description: "圖片見到嘅真描述。襯淨色長褲就得。",
    aiTags: '["圖案","長袖"]',
    contentUpdatedAt: new Date(APPLIED_TIME),
    ...overrides,
  });

  it("restore-dry-run 唯讀：仍係本批新內容先話可還原", async () => {
    h.state.batchFind.push(makeBatch());
    h.state.select.push([makeStoredItem()]);
    h.state.productFind.push(appliedProduct());
    const res = await invoke(payload("restore-dry-run"));
    expect(res.data).toEqual({
      ok: true,
      dryRun: true,
      restore: true,
      results: [{ sku: "SKU-A", status: "updated" }],
    });
    expect(h.state.txUpdates).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("未認證、內容同原批唔同、一般上架批，全部唔可以還原", async () => {
    const badSecret = payload("restore");
    badSecret.secret = "wrong";
    expect((await invoke(badSecret)).status).toBe(401);

    h.state.batchFind.push(makeBatch());
    h.state.select.push([makeStoredItem({ aiDescription: "另一段" })]);
    expect((await invoke(payload("restore"))).status).toBe(409);

    h.state.batchFind.push(makeBatch({ liveDate: "20261119", liveSession: "1" }));
    expect((await invoke(payload("restore"))).status).toBe(409);
    expect(h.state.txUpdates).toHaveLength(0);
  });

  it("只還原 updated；unchanged／failed 完全唔郁商品", async () => {
    const items = ["SKU-A", "SKU-B", "SKU-C"].map((sku) => makeItem({ sku }));
    const body = payload("restore");
    body.batch.items = items;
    h.state.batchFind.push(makeBatch({ itemCount: 3 }));
    h.state.select.push([
      makeStoredItem({ status: "unchanged", contentAppliedAt: null }),
      makeStoredItem({ id: 502, sku: "SKU-B", status: "failed", contentAppliedAt: null }),
      makeStoredItem({ id: 503, sku: "SKU-C", productId: 89 }),
    ]);
    h.state.txSelect.push(
      [appliedProduct({ id: 89, sku: "SKU-C" })],
      [{ description: null, aiTags: null, contentUpdatedAt: new Date(SOURCE_TIME) }],
    );
    h.state.txUpdate.push([], [{ id: 501 }]);
    const res = await invoke(body);
    expect(res.data.ok).toBe(true);
    expect(res.data.results.map((r: any) => r.status)).toEqual(["unchanged", "unchanged", "updated"]);
    expect(h.state.transactions).toBe(1);
    expect(h.state.txUpdates.filter((row) => row.table === products)).toHaveLength(1);
  });

  it("本批執行後曾再改內容或時間，會 failed 且零寫入", async () => {
    for (const current of [
      appliedProduct({ description: "後來人工描述" }),
      appliedProduct({ contentUpdatedAt: new Date("2026-11-19T11:00:00.000Z") }),
    ]) {
      h.state.batchFind.push(makeBatch());
      h.state.select.push([makeStoredItem()]);
      h.state.txSelect.push([current]);
      const res = await invoke(payload("restore"));
      expect(res.data.ok).toBe(false);
      expect(res.data.results[0]).toMatchObject({ status: "failed", error: "商品喺本批寫入後曾有改動，拒絕覆蓋" });
    }
    expect(h.state.txUpdates).toHaveLength(0);
  });

  it("舊批冇原值快照會拒絕，唔會估 null 就直接清內容", async () => {
    h.state.batchFind.push(makeBatch());
    h.state.select.push([makeStoredItem({ contentAppliedAt: null })]);
    h.state.txSelect.push([appliedProduct()]);
    const res = await invoke(payload("restore"));
    expect(res.data.results[0]).toMatchObject({ status: "failed", error: "原批冇完整寫入前快照，拒絕估計還原" });
    expect(h.state.txUpdates).toHaveLength(0);
  });

  it("正式還原只改三欄，精確還原舊描述／舊標籤／原時間並讀回", async () => {
    h.state.batchFind.push(makeBatch());
    h.state.select.push([makeStoredItem({
      previousDescription: "原本已有描述",
      previousAiTags: '["舊標籤"]',
    })]);
    h.state.txSelect.push(
      [appliedProduct()],
      [{
        description: "原本已有描述",
        aiTags: '["舊標籤"]',
        contentUpdatedAt: new Date(SOURCE_TIME),
      }],
    );
    h.state.txUpdate.push([], [{ id: 501 }]);
    const res = await invoke(payload("restore"));
    expect(res.data).toEqual({ ok: true, restore: true, results: [{ sku: "SKU-A", status: "updated" }] });
    const productUpdate = h.state.txUpdates.find((row) => row.table === products);
    expect(productUpdate?.set).toEqual({
      description: "原本已有描述",
      aiTags: '["舊標籤"]',
      contentUpdatedAt: new Date(SOURCE_TIME),
    });
    const logUpdate = h.state.txUpdates.find((row) => row.table === listingBatchItems);
    expect(logUpdate?.set).toMatchObject({
      contentRestoredAt: new Date(APPLIED_TIME),
      contentRestoredBy: "主管",
      error: null,
    });
    expect(h.logAudit).toHaveBeenCalledOnce();
  });

  it("還原後讀回唔一致會 failed，唔寫成功還原標記", async () => {
    h.state.batchFind.push(makeBatch());
    h.state.select.push([makeStoredItem()]);
    h.state.txSelect.push(
      [appliedProduct()],
      [{ description: "未還原", aiTags: null, contentUpdatedAt: new Date(SOURCE_TIME) }],
    );
    h.state.txUpdate.push([]);
    const res = await invoke(payload("restore"));
    expect(res.data.ok).toBe(false);
    expect(res.data.results[0].error).toContain("還原後讀回不一致");
    expect(h.state.txUpdates.some((row) => row.table === listingBatchItems)).toBe(false);
  });

  it("restore 遇到未知逐件狀態會 409，唔可以當 unchanged 略過", async () => {
    for (const action of ["restore-dry-run", "restore"]) {
      h.state.batchFind.push(makeBatch());
      h.state.select.push([makeStoredItem({ status: "mystery" })]);
      const res = await invoke(payload(action));
      expect(res.status).toBe(409);
      expect(res.data.error).toContain("無法辨認");
    }
    expect(h.state.productFind).toHaveLength(0);
    expect(h.state.txUpdates).toHaveLength(0);
  });

  it("concurrent restore 已落標記而商品曾由我哋更新，會報回滾而非假成功", async () => {
    h.state.batchFind.push(makeBatch());
    h.state.select.push([makeStoredItem()]);
    h.state.txSelect.push(
      [appliedProduct()],
      [{ description: null, aiTags: null, contentUpdatedAt: new Date(SOURCE_TIME) }],
    );
    h.state.txUpdate.push([], []);
    const res = await invoke(payload("restore"));
    expect(res.data.ok).toBe(false);
    expect(res.data.results[0]).toMatchObject({ status: "failed" });
    expect(res.data.results[0].error).toContain("已回滾");
    expect(h.state.txUpdates.filter((row) => row.table === listingBatchItems)).toHaveLength(1);
  });

  it("concurrent restore 已落標記而商品本來已係原值，保持幂等 unchanged", async () => {
    h.state.batchFind.push(makeBatch());
    h.state.select.push([makeStoredItem()]);
    h.state.txSelect.push([makeProduct()]);
    h.state.txUpdate.push([]);
    const res = await invoke(payload("restore"));
    expect(res.data).toEqual({ ok: true, restore: true, results: [{ sku: "SKU-A", status: "unchanged" }] });
    expect(h.state.txUpdates.filter((row) => row.table === products)).toHaveLength(0);
  });

  it("成功還原重送係幂等；其後再改就拒絕，唔會重寫", async () => {
    h.state.batchFind.push(makeBatch());
    h.state.select.push([makeStoredItem({ contentRestoredAt: new Date(APPLIED_TIME) })]);
    h.state.txSelect.push([makeProduct()]);
    const again = await invoke(payload("restore"));
    expect(again.data.results).toEqual([{ sku: "SKU-A", status: "unchanged" }]);
    expect(h.state.txUpdates).toHaveLength(0);

    h.state.batchFind.push(makeBatch());
    h.state.select.push([makeStoredItem({ contentRestoredAt: new Date(APPLIED_TIME) })]);
    h.state.txSelect.push([makeProduct({ description: "還原後再人工改" })]);
    const changed = await invoke(payload("restore"));
    expect(changed.data.results[0]).toMatchObject({ status: "failed", error: "呢件已還原，但其後再有改動；唔會再次覆寫" });
    expect(h.state.txUpdates).toHaveLength(0);
  });
});
