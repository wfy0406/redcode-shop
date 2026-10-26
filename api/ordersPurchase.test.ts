import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const h = vi.hoisted(() => {
  const state = {
    queue: [] as any[],
    txCount: 0,
    cartFindManyCount: 0,
    postCommitError: null as Error | null,
    inserts: [] as { table: any; values: any }[],
    updates: [] as { table: any; values: any }[],
    deletes: [] as { table: any }[],
  };
  const settle = () => {
    const value = state.queue.length > 0 ? state.queue.shift() : [];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };
  function chain(rec?: { table?: any; values?: any }) {
    const proxy: any = new Proxy({}, {
      get(_target, prop) {
        if (prop === "then") return (resolve: any, reject: any) => settle().then(resolve, reject);
        if (prop === "catch") return (fn: any) => settle().catch(fn);
        return (...args: any[]) => {
          if (rec && (prop === "values" || prop === "set")) rec.values = args[0];
          return proxy;
        };
      },
    });
    return proxy;
  }
  const queryFind = (kind: "cart" | "other") => () => {
    if (kind === "cart") state.cartFindManyCount += 1;
    return settle();
  };
  const db: any = {
    select: () => chain(),
    query: {
      cartItems: { findMany: queryFind("cart") },
      users: { findFirst: queryFind("other") },
      orders: { findFirst: queryFind("other") },
    },
    update: (table: any) => {
      const rec = { table, values: undefined as any };
      state.updates.push(rec);
      return chain(rec);
    },
    insert: (table: any) => {
      const rec = { table, values: undefined as any };
      state.inserts.push(rec);
      return chain(rec);
    },
    delete: (table: any) => {
      state.deletes.push({ table });
      return chain({ table });
    },
    transaction: async (callback: (tx: any) => unknown) => {
      state.txCount += 1;
      const result = await callback(db);
      // 模擬 DB 已 commit，但 server 未收到成功回應；catch 必須用 requestId 找回原單。
      if (state.postCommitError) throw state.postCommitError;
      return result;
    },
  };
  return { state, db };
});

const mocks = vi.hoisted(() => ({
  loadDirect: vi.fn(),
  quote: vi.fn(),
}));

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
vi.mock("./purchase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./purchase")>();
  return { ...actual, loadTryOnPurchaseItems: mocks.loadDirect };
});
vi.mock("./vip", () => ({
  computeCheckoutQuote: mocks.quote,
  getShippingRules: vi.fn(),
  normalizeDeliveryMethod: (value?: string | null) => value === "sf_station" || value === "sf_locker" ? value : "address",
  normalizeRegion: (value?: string | null) => value === "MO" || value === "OVERSEAS" ? value : "HK",
  recomputeVipTierInBackground: vi.fn(),
}));
vi.mock("./promoRouter", () => ({ resolvePromoDiscount: vi.fn() }));
vi.mock("./wallet", () => ({
  computeWalletSplit: vi.fn(),
  returnWalletForOrder: vi.fn(),
  getOrderWalletSpend: vi.fn(),
}));
vi.mock("./wmsSync", () => ({
  forwardOrderToWms: vi.fn(),
  forwardOrderDeleteToWms: vi.fn(),
  resetWmsSyncLogForReupload: vi.fn(),
}));
vi.mock("./orderDelete", () => ({ hardDeleteOrder: vi.fn() }));
vi.mock("./approvalGuard", () => ({ requestApprovalIfStaff: vi.fn() }));
vi.mock("./audit", () => ({ logAudit: vi.fn() }));
vi.mock("./email", () => ({
  sendOrderReviewAlertEmail: vi.fn(async () => ({ ok: true })),
  sendOrderApprovedEmail: vi.fn(async () => ({ ok: true })),
  sendOrderPendingEmail: vi.fn(async () => ({ ok: true })),
  orderVipEmailInfo: vi.fn(() => null),
  sendGuestOrderEmail: vi.fn(async () => ({ ok: true })),
  siteUrl: vi.fn(() => "https://test.local"),
  sendOrderPaidOnlineEmail: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./airwallex", () => ({ getAirwallexConfig: vi.fn(async () => null) }));
vi.mock("./wmsMemberSync", () => ({ notifyWmsGuestClaimed: vi.fn() }));

import { ordersRouter } from "./ordersRouter";
import { cartItems, orderItems, orders } from "@db/schema";
import { computeWalletSplit } from "./wallet";
import { forwardOrderToWms } from "./wmsSync";
import {
  sendOrderPaidOnlineEmail,
  sendOrderPendingEmail,
  sendOrderReviewAlertEmail,
} from "./email";

interface CreateArgs {
  input?: Record<string, unknown>;
}
type CreateHandler = (args: CreateArgs & {
  ctx: { user: { userId: number; role: "member" } };
}) => Promise<any>;
const createOrder = ordersRouter.create as unknown as CreateHandler;
const REQUEST_ID = "6f3940f2-25b0-4f6c-94b1-a7a17c639c01";
const DIRECT_ITEMS = [
  { productId: 101, size: "M", quantity: 1 },
  { productId: 202, quantity: 1 },
];

function product(
  id: number,
  price: number,
  discountPrice: number | null,
  sku: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    sku,
    name: `目前商品 ${sku}`,
    price,
    discountPrice,
    stock: 8,
    sizes: null,
    sizeEnabled: false,
    isActive: true,
    delistEnabled: false,
    delistAt: null,
    ...overrides,
  } as any;
}

function directFixture() {
  const direct = [
    {
      productId: 101,
      size: "M",
      quantity: 1,
      product: product(101, 599, 499, "TOP-NOW", { sizeEnabled: true, sizes: "S,M,L" }),
    },
    { productId: 202, size: null, quantity: 1, product: product(202, 399, null, "RING-NOW") },
  ];
  return { direct, lockedProducts: direct.map((item) => item.product) };
}

function quoteShape() {
  return {
    subtotalCents: 0,
    vipDiscountCents: 0,
    couponDiscountCents: 0,
    totalCents: 0,
    shippingFree: false,
    shippingLabel: "順豐到付",
    remarks: [],
    region: "HK",
    deliveryMethod: "address",
    stationId: null,
    stationName: null,
    vipTier: "NONE",
    subtotalDollars: 0,
  };
}

function createdOrder(total: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    orderNo: "RC-TEST-501",
    userId: 7,
    status: "pending_payment",
    total,
    walletUsed: 0,
    items: [],
    proofs: [],
    ...overrides,
  };
}

function existingDirectOrder(overrides: Record<string, unknown> = {}) {
  return createdOrder(898, {
    walletUsed: 898,
    deliveryMethod: "address",
    items: [
      {
        productId: 101,
        size: "M",
        quantity: 1,
        productName: "目前商品 TOP-NOW",
        price: 499,
        originalPrice: 599,
      },
      {
        productId: 202,
        size: null,
        quantity: 1,
        productName: "目前商品 RING-NOW",
        price: 399,
        originalPrice: 399,
      },
    ],
    ...overrides,
  });
}

function fullWalletClaimCount() {
  return h.state.updates.filter((entry) =>
    entry.table === orders && entry.values?.status === "payment_review"
  ).length;
}

function callCreate(input?: Record<string, unknown>) {
  return createOrder({
    ctx: { user: { userId: 7, role: "member" } },
    input,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.queue = [];
  h.state.txCount = 0;
  h.state.cartFindManyCount = 0;
  h.state.postCommitError = null;
  h.state.inserts = [];
  h.state.updates = [];
  h.state.deletes = [];
  mocks.quote.mockImplementation(async () => quoteShape());
  vi.mocked(computeWalletSplit).mockReturnValue({ walletApplied: 0, cashDue: 0 });
  vi.mocked(forwardOrderToWms).mockResolvedValue({
    status: "disabled",
    lineCount: 0,
    okCount: 0,
    lastError: null,
  });
});

describe("AI 試穿即買 orders.create 分流", () => {
  it("兩件即買只用 direct lines：不讀原 cart、不清車，quote 與訂單項共用目前商品", async () => {
    const { direct, lockedProducts } = directFixture();
    mocks.loadDirect.mockResolvedValue(direct);
    h.state.queue = [
      null,
      { defaultRegion: "HK" },
      lockedProducts,
      [{ id: 101 }],
      [{ id: 202 }],
      [{ id: 501 }],
      [],
      createdOrder(898),
      { name: "Member", email: null },
    ];

    const result = await callCreate({
      address: "香港測試地址",
      items: DIRECT_ITEMS,
      requestId: REQUEST_ID,
    });

    expect(result.total).toBe(898);
    expect(h.state.cartFindManyCount).toBe(0);
    expect(h.state.deletes).toHaveLength(0);
    expect(mocks.quote).toHaveBeenCalledTimes(1);
    expect(mocks.quote.mock.calls[0]?.[2]).toBe(direct);
    expect(h.state.txCount).toBe(1);

    const orderInsert = h.state.inserts.find((entry) => entry.table === orders);
    const itemsInsert = h.state.inserts.find((entry) => entry.table === orderItems);
    expect(orderInsert?.values.total).toBe(898);
    expect(orderInsert?.values.orderNo).toMatch(/^RC[0-9A-F]{30}$/);
    expect(itemsInsert?.values).toHaveLength(2);
    expect(itemsInsert?.values.map((item: any) => [item.productName, item.sku, item.price, item.quantity])).toEqual([
      ["目前商品 TOP-NOW", "TOP-NOW", 499, 1],
      ["目前商品 RING-NOW", "RING-NOW", 399, 1],
    ]);
  });

  it("普通購物車流程保持原行為：quote 不帶 direct lines，成功後清車", async () => {
    const cartLine = {
      id: 9,
      productId: 303,
      size: null,
      quantity: 2,
      product: product(303, 50, null, "CART-KEEP"),
    };
    h.state.queue = [
      [cartLine],
      { defaultRegion: "HK" },
      null,
      [{ id: 303 }],
      [{ id: 501 }],
      [],
      [],
      createdOrder(100),
      { name: "Member", email: null },
    ];

    const result = await callCreate({ address: "香港測試地址" });

    expect(result.total).toBe(100);
    expect(mocks.loadDirect).not.toHaveBeenCalled();
    expect(h.state.cartFindManyCount).toBe(1);
    expect(mocks.quote.mock.calls[0]?.[2]).toBeUndefined();
    expect(h.state.deletes).toEqual([{ table: cartItems }]);
  });

  it("direct 商品核實失敗即停：不讀 cart、不報價、不開 transaction", async () => {
    h.state.queue = [null];
    mocks.loadDirect.mockRejectedValue(new TRPCError({ code: "BAD_REQUEST", message: "尺寸已失效" }));
    await expect(callCreate({ items: DIRECT_ITEMS, requestId: REQUEST_ID }))
      .rejects.toThrow("尺寸已失效");
    expect(h.state.cartFindManyCount).toBe(0);
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(h.state.txCount).toBe(0);
    expect(h.state.inserts).toHaveLength(0);
  });

  it("direct 必帶 requestId；普通購物車唔可以帶", async () => {
    await expect(callCreate({ items: DIRECT_ITEMS })).rejects.toThrow("即買請求編號缺失");
    await expect(callCreate({ requestId: REQUEST_ID })).rejects.toThrow("普通購物車落單唔可以帶");
    expect(h.state.txCount).toBe(0);
    expect(mocks.loadDirect).not.toHaveBeenCalled();
  });

  it("同一 requestId 重試直接返原單：不再讀商品、報價、扣庫存或開新單", async () => {
    const existing = createdOrder(898, {
      items: [
        { productId: 101, size: "M", quantity: 1 },
        { productId: 202, size: null, quantity: 1 },
      ],
    });
    h.state.queue = [existing];

    const result = await callCreate({ items: DIRECT_ITEMS, requestId: REQUEST_ID });

    expect(result).toBe(existing);
    expect(result).toMatchObject({ recovered: true });
    expect(mocks.loadDirect).not.toHaveBeenCalled();
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(h.state.txCount).toBe(0);
    expect(h.state.inserts).toHaveLength(0);
  });

  it("同一 requestId 對應不同商品或另一會員會 CONFLICT，唔會錯返原單", async () => {
    const wrongLines = createdOrder(898, {
      items: [{ productId: 999, size: null, quantity: 1 }],
    });
    h.state.queue = [wrongLines];
    await expect(callCreate({ items: DIRECT_ITEMS, requestId: REQUEST_ID }))
      .rejects.toMatchObject({ code: "CONFLICT" });

    h.state.queue = [createdOrder(898, {
      userId: 8,
      items: [
        { productId: 101, size: "M", quantity: 1 },
        { productId: 202, size: null, quantity: 1 },
      ],
    })];
    await expect(callCreate({ items: DIRECT_ITEMS, requestId: REQUEST_ID }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.state.txCount).toBe(0);
  });

  it("commit 成功但 DB 回應遺失時，catch 會恢復同一張單而唔係再開一張", async () => {
    const { direct, lockedProducts } = directFixture();
    const existing = createdOrder(898, {
      items: [
        { productId: 101, size: "M", quantity: 1 },
        { productId: 202, size: null, quantity: 1 },
      ],
    });
    mocks.loadDirect.mockResolvedValue(direct);
    h.state.postCommitError = new Error("simulated response loss after commit");
    h.state.queue = [
      null,
      { defaultRegion: "HK" },
      lockedProducts,
      [{ id: 101 }],
      [{ id: 202 }],
      [{ id: 501 }],
      [],
      existing,
    ];

    const result = await callCreate({ items: DIRECT_ITEMS, requestId: REQUEST_ID });

    expect(result).toBe(existing);
    expect(result).toMatchObject({ recovered: true });
    expect(h.state.txCount).toBe(1);
    expect(h.state.inserts.filter((entry) => entry.table === orders)).toHaveLength(1);
    expect(mocks.loadDirect).toHaveBeenCalledTimes(1);
  });

  it("transaction 內鎖行後發現品名、貨號或價錢有變：整批停止，唔用舊快照成交", async () => {
    const { direct, lockedProducts } = directFixture();
    const changedProducts = lockedProducts.map((item, index) => index === 0
      ? { ...item, price: 699, discountPrice: 549 }
      : item);
    mocks.loadDirect.mockResolvedValue(direct);
    h.state.queue = [
      null,
      { defaultRegion: "HK" },
      changedProducts,
      null,
    ];

    await expect(callCreate({ items: DIRECT_ITEMS, requestId: REQUEST_ID }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.state.txCount).toBe(1);
    expect(h.state.inserts).toHaveLength(0);
    expect(h.state.deletes).toHaveLength(0);
  });

  it("全購物金原單重試：pending_payment 會補 claim 做 payment_review，通知只由贏家寄", async () => {
    const existing = existingDirectOrder();
    h.state.queue = [
      existing,
      [{ id: 501 }],
      { name: "Member", email: "member@example.test", phone: "12345678" },
    ];

    const result = await callCreate({ items: DIRECT_ITEMS, requestId: REQUEST_ID });

    expect(result).toBe(existing);
    expect(result.status).toBe("payment_review");
    expect(result.paymentChannel).toBe("wallet");
    expect(result.paidAt).toBeInstanceOf(Date);
    expect(fullWalletClaimCount()).toBe(1);
    expect(h.state.txCount).toBe(0);
    expect(mocks.loadDirect).not.toHaveBeenCalled();
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(forwardOrderToWms).toHaveBeenCalledTimes(1);
    expect(sendOrderPendingEmail).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(sendOrderPaidOnlineEmail).toHaveBeenCalledTimes(1);
      expect(sendOrderReviewAlertEmail).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(sendOrderPaidOnlineEmail).mock.calls[0]?.[0]).toMatchObject({
      walletUsed: 898,
      walletBalance: undefined,
    });
  });

  it("全購物金原單已係 payment_review：重試唔再 claim、轉 WMS 或寄通知", async () => {
    const existing = existingDirectOrder({
      status: "payment_review",
      paymentChannel: "wallet",
      paidAt: new Date("2026-10-26T00:00:00.000Z"),
    });
    h.state.queue = [existing];

    const result = await callCreate({ items: DIRECT_ITEMS, requestId: REQUEST_ID });

    expect(result).toBe(existing);
    expect(fullWalletClaimCount()).toBe(0);
    expect(forwardOrderToWms).not.toHaveBeenCalled();
    expect(sendOrderPaidOnlineEmail).not.toHaveBeenCalled();
    expect(sendOrderReviewAlertEmail).not.toHaveBeenCalled();
    expect(sendOrderPendingEmail).not.toHaveBeenCalled();
  });

  it("fresh 全購物金單：共用補償轉待審批，保留真實扣款後餘額且唔寄待付款信", async () => {
    const { direct, lockedProducts } = directFixture();
    const created = existingDirectOrder();
    mocks.loadDirect.mockResolvedValue(direct);
    vi.mocked(computeWalletSplit).mockReturnValue({ walletApplied: 898, cashDue: 0 });
    h.state.queue = [
      null,
      { defaultRegion: "HK" },
      lockedProducts,
      [{ id: 101 }],
      [{ id: 202 }],
      { storeCredit: 1000 },
      [{ storeCredit: 102 }],
      [{ id: 501 }],
      [],
      [],
      created,
      [{ id: 501 }],
      { name: "Member", email: "member@example.test", phone: "12345678" },
    ];

    const result = await callCreate({
      items: DIRECT_ITEMS,
      requestId: REQUEST_ID,
      useWallet: true,
    });

    expect(result).toBe(created);
    expect(result).not.toHaveProperty("recovered");
    expect(result.status).toBe("payment_review");
    expect(result.paymentChannel).toBe("wallet");
    expect(fullWalletClaimCount()).toBe(1);
    expect(sendOrderPendingEmail).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(sendOrderPaidOnlineEmail).toHaveBeenCalledTimes(1);
      expect(sendOrderReviewAlertEmail).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(sendOrderPaidOnlineEmail).mock.calls[0]?.[0]).toMatchObject({
      walletUsed: 898,
      walletBalance: { balanceAfter: 102, at: expect.any(Date) },
    });
  });

  it("全購物金 commit 後回應遺失：recovery 會補 claim，唔會重開單或再扣庫存", async () => {
    const { direct, lockedProducts } = directFixture();
    const existing = existingDirectOrder();
    mocks.loadDirect.mockResolvedValue(direct);
    vi.mocked(computeWalletSplit).mockReturnValue({ walletApplied: 898, cashDue: 0 });
    h.state.postCommitError = new Error("simulated response loss after full-wallet commit");
    h.state.queue = [
      null,
      { defaultRegion: "HK" },
      lockedProducts,
      [{ id: 101 }],
      [{ id: 202 }],
      { storeCredit: 1000 },
      [{ storeCredit: 102 }],
      [{ id: 501 }],
      [],
      [],
      existing,
      [{ id: 501 }],
      { name: "Member", email: "member@example.test", phone: "12345678" },
    ];

    const result = await callCreate({
      items: DIRECT_ITEMS,
      requestId: REQUEST_ID,
      useWallet: true,
    });

    expect(result).toBe(existing);
    expect(result.status).toBe("payment_review");
    expect(h.state.txCount).toBe(1);
    expect(h.state.inserts.filter((entry) => entry.table === orders)).toHaveLength(1);
    expect(fullWalletClaimCount()).toBe(1);
    expect(mocks.loadDirect).toHaveBeenCalledTimes(1);
    expect(forwardOrderToWms).toHaveBeenCalledTimes(1);
    expect(sendOrderPendingEmail).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(sendOrderPaidOnlineEmail).toHaveBeenCalledTimes(1);
      expect(sendOrderReviewAlertEmail).toHaveBeenCalledTimes(1);
    });
  });

  it("transaction 原本報錯而 recovery 查詢又失敗：保留原始商品錯誤，唔好 mask", async () => {
    const { direct, lockedProducts } = directFixture();
    const changedProducts = lockedProducts.map((item, index) => index === 0
      ? { ...item, price: 699, discountPrice: 549 }
      : item);
    mocks.loadDirect.mockResolvedValue(direct);
    h.state.queue = [
      null,
      { defaultRegion: "HK" },
      changedProducts,
      new Error("simulated recovery database outage"),
    ];

    await expect(callCreate({ items: DIRECT_ITEMS, requestId: REQUEST_ID }))
      .rejects.toMatchObject({
        code: "CONFLICT",
        message: "商品品名、貨號或價錢啱啱更新，請刷新結帳頁再確認",
      });
    expect(h.state.txCount).toBe(1);
    expect(h.state.inserts).toHaveLength(0);
  });
});
