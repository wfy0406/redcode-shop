/**
 * productsRouter 重點標籤 SKU tombstone（L2）——人手 create 路徑 focused tests，**唔掂真 DB**。
 * （disableAiTags 嘅 tombstone 寫入／權限／input 閘由 productAiTagsDisable.test.ts 覆蓋。）
 *
 * 覆蓋：
 * 1) create：SKU 有 tombstone → 新行 aiTagsEnabled:false（唔跟 schema default true 復活）；
 *    冇 tombstone → insert 唔帶 aiTagsEnabled。
 * 2) tombstone 口徑同 products.sku unique 身份一致（exact、區分大小寫、唔 trim）：
 *    停用 "SKU-A" 唔會誤傷 "sku-a"（佢哋喺現有 unique 行為下係兩件貨）。
 * 3) dup SKU 照舊 CONFLICT，零寫入。
 *
 * ⚠️ 界限：mock 咗 DB，真 PostgreSQL unique／onConflict 語義未驗（要 integration）。
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

// ───────────────────────── mock 基礎設施（hoisted）─────────────────────────
const h = vi.hoisted(() => {
  const state = {
    user: null as null | { userId: number; role: string },
    dbRole: null as string | null,
    userTable: null as unknown,
    productFind: [] as unknown[],
    tombstoneFind: [] as unknown[],
    update: [] as unknown[],
    insert: [] as unknown[],
    updates: [] as Array<{ table: unknown; set?: Record<string, unknown>; ops: string[] }>,
    inserts: [] as Array<{ table: unknown; values?: unknown; ops: string[] }>,
  };
  const pop = (queue: unknown[]) => (queue.length > 0 ? queue.shift() : []);
  const settle = (queue: unknown[]) => {
    const v = pop(queue);
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  };
  function chain(rec: { ops: string[]; table?: unknown; set?: unknown; values?: unknown; from?: unknown }, queue: unknown[]) {
    const proxy: any = new Proxy({}, {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: any, reject: any) => {
            // middleware 每 request 以 users PK 覆核角色：唔食業務 queue
            if (rec.from === state.userTable) {
              return Promise.resolve(state.dbRole ? [{ role: state.dbRole }] : []).then(resolve, reject);
            }
            return settle(queue).then(resolve, reject);
          };
        }
        return (...args: any[]) => {
          rec.ops.push(String(prop));
          if (prop === "from") rec.from = args[0];
          if (prop === "set") rec.set = args[0];
          if (prop === "values") rec.values = args[0];
          return proxy;
        };
      },
    });
    return proxy;
  }
  const db: any = {
    query: {
      products: {
        findFirst: () =>
          state.productFind.length > 0 ? settle(state.productFind) : Promise.resolve(null),
      },
      productAiTagsTombstones: {
        findFirst: () =>
          state.tombstoneFind.length > 0 ? settle(state.tombstoneFind) : Promise.resolve(null),
      },
    },
    select: () => chain({ ops: [] }, []),
    update: (table: unknown) => {
      const rec = { table, ops: [] as string[] };
      state.updates.push(rec as never);
      return chain(rec, state.update);
    },
    insert: (table: unknown) => {
      const rec = { table, ops: [] as string[] };
      state.inserts.push(rec as never);
      return chain(rec, state.insert);
    },
    delete: () => chain({ ops: [] }, []),
  };
  return {
    state,
    db,
    logAudit: vi.fn(async () => undefined),
    requestApprovalIfStaff: vi.fn(async () => null),
  };
});

vi.mock("./queries/connection", () => ({ getDb: () => h.db }));
vi.mock("./audit", () => ({ logAudit: h.logAudit }));
vi.mock("./approvalGuard", () => ({ requestApprovalIfStaff: h.requestApprovalIfStaff }));
vi.mock("./auth", () => ({
  userFromAuthHeader: async () => h.state.user,
}));

import { users, productAiTagsTombstones, products } from "@db/schema";
import { productsRouter } from "./productsRouter";

// 模組載入後登記 users table identity（middleware 角色覆核辨認用）
h.state.userTable = users;

function caller() {
  return productsRouter.createCaller({
    req: new Request("http://test.local/api/trpc", { headers: { authorization: "Bearer x" } }),
    resHeaders: new Headers(),
  });
}

beforeEach(() => {
  h.state.user = { userId: 1, role: "supervisor" };
  h.state.dbRole = "supervisor";
  h.state.productFind = [];
  h.state.tombstoneFind = [];
  h.state.update = [];
  h.state.insert = [];
  h.state.updates = [];
  h.state.inserts = [];
  h.logAudit.mockClear();
  h.requestApprovalIfStaff.mockClear();
});

describe("create — tombstoned SKU 重建保持停用", () => {
  const createInput = {
    sku: "SKU-A",
    name: "重建商品",
    image: "/uploads/new.jpg",
    price: 100,
  };

  it("SKU 有 tombstone → 新行 aiTagsEnabled:false（唔跟 default true 復活）", async () => {
    h.state.productFind.push(null, { id: 55, sku: "SKU-A" }); // dup 檢查、最終回讀
    h.state.tombstoneFind.push({ sku: "SKU-A" });
    h.state.insert.push([{ id: 55 }], []); // products insert returning、productImageArchive 歸檔
    const res = await caller().create(createInput);
    expect(res).toMatchObject({ id: 55 });
    const productInsert = h.state.inserts.find((r) => r.table === products);
    expect(productInsert?.values).toMatchObject({ sku: "SKU-A", aiTagsEnabled: false });
  });

  it("SKU 冇 tombstone → insert 唔帶 aiTagsEnabled（跟 schema default true）", async () => {
    h.state.productFind.push(null, { id: 56, sku: "SKU-A" });
    h.state.tombstoneFind.push(null);
    h.state.insert.push([{ id: 56 }], []);
    await caller().create(createInput);
    const productInsert = h.state.inserts.find((r) => r.table === products);
    expect(productInsert?.values).not.toHaveProperty("aiTagsEnabled");
  });

  it("tombstone 口徑同 products.sku 一致（exact）：大小寫唔同嘅 SKU 係另一件貨，唔會誤傷", async () => {
    // 停用咗 "SKU-A"；重建 "sku-a" 喺現有 unique 行為下係另一個 SKU → tombstone 查唔中
    h.state.productFind.push(null, { id: 57, sku: "sku-a" });
    h.state.tombstoneFind.push(null); // DB exact match："sku-a" ≠ "SKU-A"
    h.state.insert.push([{ id: 57 }], []);
    await caller().create({ ...createInput, sku: "sku-a" });
    const productInsert = h.state.inserts.find((r) => r.table === products);
    expect(productInsert?.values).not.toHaveProperty("aiTagsEnabled");
  });

  it("dup SKU 照舊 CONFLICT，唔會 insert", async () => {
    h.state.productFind.push({ id: 9, sku: "SKU-A" });
    await expect(caller().create(createInput)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.state.inserts).toHaveLength(0);
  });
});
