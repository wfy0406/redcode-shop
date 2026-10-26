import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    queue: [] as any[],
    txCount: 0,
    lockCount: 0,
    existingFindManyCount: 0,
    updates: [] as { table: any; set: any }[],
    inserts: [] as { table: any; values: any }[],
  };
  const settle = () => {
    const value = state.queue.length > 0 ? state.queue.shift() : [];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };
  function chain(rec?: { table?: any; set?: any; values?: any }) {
    const proxy: any = new Proxy({}, {
      get(_target, prop) {
        if (prop === "then") return (resolve: any, reject: any) => settle().then(resolve, reject);
        if (prop === "catch") return (fn: any) => settle().catch(fn);
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
    select: () => chain(),
    execute: async () => {
      state.lockCount += 1;
      return { rows: [] };
    },
    update: (table: any) => {
      const rec = { table, set: undefined as any };
      state.updates.push(rec);
      return chain(rec);
    },
    insert: (table: any) => {
      const rec = { table, values: undefined as any };
      state.inserts.push(rec);
      return chain(rec);
    },
    query: {
      products: { findFirst: async () => settle() },
      cartItems: {
        findMany: async () => {
          state.existingFindManyCount += 1;
          return settle();
        },
        findFirst: async () => settle(),
      },
    },
    transaction: (callback: (tx: any) => unknown) => {
      state.txCount += 1;
      return callback(db);
    },
  };
  return { state, db };
});

vi.mock("./queries/connection", () => ({ getDb: () => h.db }));
vi.mock("./middleware", () => {
  const proc = {
    query: (fn: unknown) => fn,
    mutation: (fn: unknown) => fn,
    input: () => ({ query: (fn: unknown) => fn, mutation: (fn: unknown) => fn }),
  };
  return {
    createRouter: (routes: unknown) => routes,
    publicQuery: proc,
    publicProcedure: proc,
    authedProcedure: proc,
    staffProcedure: proc,
    supervisorProcedure: proc,
    adminProcedure: proc,
  };
});

import { cartRouter } from "./cartRouter";
import { cartItems } from "@db/schema";

type AddManyHandler = (args: {
  ctx: { user: { userId: number; role: "member" } };
  input: { items: Array<{ productId: number; size?: string; quantity: 1 }> };
}) => Promise<any>;
const addMany = cartRouter.addMany as unknown as AddManyHandler;
type AddHandler = (args: {
  ctx: { user: { userId: number; role: "member" } };
  input: { productId: number; size?: string; quantity: number };
}) => Promise<any>;
const add = cartRouter.add as unknown as AddHandler;

function product(id: number, stock: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sku: `SKU-${id}`,
    name: `商品 ${id}`,
    price: 100,
    discountPrice: null,
    sizes: "S,M,L",
    sizeEnabled: true,
    stock,
    isActive: true,
    delistEnabled: false,
    delistAt: null,
    ...overrides,
  } as any;
}

function callAddMany(items: Array<{ productId: number; size?: string; quantity: 1 }>) {
  return addMany({ ctx: { user: { userId: 7, role: "member" } }, input: { items } });
}

beforeEach(() => {
  h.state.queue = [];
  h.state.txCount = 0;
  h.state.lockCount = 0;
  h.state.existingFindManyCount = 0;
  h.state.updates = [];
  h.state.inserts = [];
});

describe("cart.addMany 試穿整批加車", () => {
  it("兩件同一 transaction：現有行加一、新商品插一，回傳兩行", async () => {
    const products = [
      product(101, 5),
      product(202, 3, { sizes: null, sizeEnabled: false }),
    ];
    const existing = [{ id: 9, userId: 7, productId: 101, size: "M", quantity: 2 }];
    const line1 = { id: 9, productId: 101, size: "M", quantity: 3, product: products[0] };
    const line2 = { id: 10, productId: 202, size: null, quantity: 1, product: products[1] };
    h.state.queue = [products, existing, [], line1, [{ id: 10 }], line2];

    const result = await callAddMany([
      { productId: 101, size: "M", quantity: 1 },
      { productId: 202, quantity: 1 },
    ]);

    expect(result).toEqual([line1, line2]);
    expect(h.state.txCount).toBe(1);
    expect(h.state.lockCount).toBe(1);
    expect(h.state.updates).toHaveLength(1);
    expect(h.state.updates[0]?.set.quantity).toBe(3);
    expect(h.state.inserts).toHaveLength(1);
    expect(h.state.inserts[0]?.table).toBe(cartItems);
    expect(h.state.inserts[0]?.values).toMatchObject({ productId: 202, size: null, quantity: 1 });
  });

  it("第二件售罄會整批 throw；所有工作只經同一 transaction callback", async () => {
    const products = [product(101, 5), product(202, 0, { sizes: null, sizeEnabled: false })];
    const existing = [{ id: 11, userId: 7, productId: 101, size: "M", quantity: 1 }];
    const line1 = { id: 11, productId: 101, size: "M", quantity: 2, product: products[0] };
    h.state.queue = [products, existing, [], line1];

    await expect(callAddMany([
      { productId: 101, size: "M", quantity: 1 },
      { productId: 202, quantity: 1 },
    ])).rejects.toThrow("暫時售罄");

    expect(h.state.txCount).toBe(1);
    // Mock 只證明同一 transaction 及錯誤向外throw；真 PostgreSQL rollback 仍屬部署後 integration 驗收。
    expect(h.state.updates).toHaveLength(1);
    expect(h.state.inserts).toHaveLength(0);
  });

  it("同一商品唔同尺寸會合計購物車數量，唔准繞過產品庫存", async () => {
    const products = [product(101, 4)];
    const existing = [
      { id: 9, userId: 7, productId: 101, size: "M", quantity: 2 },
      { id: 10, userId: 7, productId: 101, size: "L", quantity: 2 },
    ];
    h.state.queue = [products, existing];

    await expect(callAddMany([{ productId: 101, size: "S", quantity: 1 }]))
      .rejects.toThrow("購物車已有 4 件");
    expect(h.state.updates).toHaveLength(0);
    expect(h.state.inserts).toHaveLength(0);
  });

  it("尺寸失效時未寫購物車", async () => {
    h.state.queue = [[product(101, 5)]];
    await expect(callAddMany([{ productId: 101, size: "XXL", quantity: 1 }]))
      .rejects.toThrow("有效尺寸");
    expect(h.state.existingFindManyCount).toBe(0);
    expect(h.state.updates).toHaveLength(0);
    expect(h.state.inserts).toHaveLength(0);
    expect(h.state.lockCount).toBe(1);
  });
});

describe("cart.add 與 addMany 共用會員鎖", () => {
  it("無尺寸現有行會更新數量，唔會因 NULL unique 語義再插一行", async () => {
    const itemProduct = product(202, 3, { sizes: null, sizeEnabled: false });
    const existing = { id: 10, userId: 7, productId: 202, size: null, quantity: 2 };
    const line = { ...existing, quantity: 3, product: itemProduct };
    h.state.queue = [itemProduct, existing, [], line];

    const result = await add({
      ctx: { user: { userId: 7, role: "member" } },
      input: { productId: 202, quantity: 1 },
    });

    expect(result).toBe(line);
    expect(h.state.txCount).toBe(1);
    expect(h.state.lockCount).toBe(1);
    expect(h.state.updates).toHaveLength(1);
    expect(h.state.updates[0]?.set.quantity).toBe(3);
    expect(h.state.inserts).toHaveLength(0);
  });

  it("無尺寸新商品都喺同一把鎖內插入", async () => {
    const itemProduct = product(202, 3, { sizes: null, sizeEnabled: false });
    const line = { id: 10, userId: 7, productId: 202, size: null, quantity: 1, product: itemProduct };
    h.state.queue = [itemProduct, null, [{ id: 10 }], line];

    const result = await add({
      ctx: { user: { userId: 7, role: "member" } },
      input: { productId: 202, quantity: 1 },
    });

    expect(result).toBe(line);
    expect(h.state.lockCount).toBe(1);
    expect(h.state.inserts).toHaveLength(1);
    expect(h.state.inserts[0]?.values).toMatchObject({ productId: 202, size: null, quantity: 1 });
  });
});
