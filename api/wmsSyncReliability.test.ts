import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const dialect = new PgDialect();

const h = vi.hoisted(() => {
  const state = {
    sync: null as any,
    order: null as any,
    productRows: [] as any[],
    retryRows: [] as any[],
    inserts: [] as any[],
    updates: [] as any[],
  };
  const cloneSync = () => state.sync ? { ...state.sync } : undefined;
  const matches = (where: any): boolean => {
    if (!state.sync) return false;
    const params = dialect.sqlToQuery(where).params;
    if (params[0] !== state.sync.id) return false;
    if (params.length > 1) {
      const expected = params[1];
      if (expected instanceof Date) return state.sync.updatedAt.getTime() === expected.getTime();
      return state.sync.lastError === expected;
    }
    return true;
  };
  const db: any = {
    query: {
      orders: {
        findFirst: async (opts?: any) => opts?.columns?.status
          ? { status: state.order?.status }
          : state.order ? { ...state.order } : undefined,
      },
      wmsSyncLog: { findFirst: async () => cloneSync() },
    },
    insert: (table: any) => ({
      values: (values: any) => {
        state.inserts.push({ table, values });
        return {
          onConflictDoNothing: async () => {
            if (!state.sync) {
              state.sync = {
                id: 1,
                createdAt: new Date(),
                updatedAt: new Date(),
                webhookOrderIds: null,
                ...values,
              };
            }
            return [];
          },
          onConflictDoUpdate: async ({ set }: any) => {
            if (!state.sync) {
              state.sync = { id: 1, createdAt: new Date(), updatedAt: new Date(), ...values, ...set };
            } else {
              state.sync = { ...state.sync, ...set };
            }
            return [];
          },
        };
      },
    }),
    update: (table: any) => ({
      set: (patch: any) => ({
        where: (where: any) => {
          const commit = () => {
            const changed = matches(where);
            state.updates.push({ table, patch, where, changed });
            if (changed) state.sync = { ...state.sync, ...patch };
            return changed;
          };
          const chain: any = {
            returning: async () => commit() ? [{ id: state.sync.id }] : [],
            then: (resolve: any, reject: any) => {
              const changed = commit();
              return Promise.resolve(changed ? [{ id: state.sync.id }] : []).then(resolve, reject);
            },
            catch: (fn: any) => {
              try {
                const changed = commit();
                return Promise.resolve(changed ? [{ id: state.sync.id }] : []);
              } catch (e) {
                return Promise.resolve(fn(e));
              }
            },
          };
          return chain;
        },
      }),
    }),
    select: (fields?: any) => {
      const retryQuery = fields && Object.prototype.hasOwnProperty.call(fields, "orderId");
      const chain: any = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: async (n: number) => state.retryRows.slice(0, n),
        then: (resolve: any, reject: any) => Promise.resolve(retryQuery ? state.retryRows : state.productRows).then(resolve, reject),
      };
      return chain;
    },
  };
  return { state, db };
});

vi.mock("./queries/connection", () => ({ getDb: () => h.db }));
vi.mock("./audit", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("./email", () => ({ sendOrderApprovedEmail: vi.fn(), orderVipEmailInfo: vi.fn() }));
vi.mock("./vip", () => ({ recomputeVipTierInBackground: vi.fn() }));

import {
  forwardOrderToWms,
  isWmsAutoRetryDue,
  resetWmsSyncLogForReupload,
  retryPendingWmsSync,
  wmsRetryDelayMs,
  WMS_AUTO_QUEUE_MESSAGE,
} from "./wmsSync";
import { wmsSyncLog } from "@db/schema";
import { logAudit } from "./audit";

const ORDER = {
  id: 101,
  orderNo: "RC202611110101",
  userId: 900,
  status: "payment_review",
  total: 0,
  discountAmount: 0,
  promoCode: null,
  address: null,
  deliveryMethod: "address",
  pickupPoint: null,
  stationId: null,
  region: "HK",
  note: "直播抽獎中獎・包郵",
  remark: "官網訂單・包郵・直播抽獎中獎商品",
  shippingFree: true,
  vipTierAtPurchase: null,
  vipDiscountCents: 0,
  paymentChannel: "manual",
  airwallexIntentId: null,
  guestName: null,
  guestPhone: null,
  guestEmail: null,
  createdAt: new Date("2026-11-11T13:18:00Z"),
  user: { name: "測試中獎者", phone: "", email: null, age: null, createdAt: new Date("2026-01-01T00:00:00Z") },
  proofs: [],
  items: [{ id: 1001, productId: 30, productName: "$111 購物金", sku: "LUCKY-111", size: null, price: 0, quantity: 1 }],
};

function okResponse(id: number | null) {
  return new Response(JSON.stringify({ result: { data: { json: { success: true, ...(id == null ? {} : { webhookOrderId: id }) } } } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  h.state.order = { ...ORDER, items: ORDER.items.map((item) => ({ ...item })) };
  h.state.sync = null;
  h.state.productRows = [{ id: 30, listedDate: new Date("2026-11-01T00:00:00Z"), image: "/p.png", photos: [] }];
  h.state.retryRows = [];
  h.state.inserts = [];
  h.state.updates = [];
  process.env.WMS_API_KEY = "test-only-key";
  delete process.env.WMS_SYNC_DISABLED;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WMS_API_KEY;
});

describe("forwardOrderToWms 可靠投遞", () => {
  it("零元中獎單成功：持久排隊→認領→送 0 元 payload→sent", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => okResponse(777));
    vi.stubGlobal("fetch", fetchMock);
    const result = await forwardOrderToWms(101);
    expect(result).toEqual({ status: "sent", lineCount: 1, okCount: 1, lastError: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).json;
    expect(request).toMatchObject({ sourceRef: "RC202611110101", productCode: "LUCKY-111", actualPrice: "0", amount: "1" });
    expect(h.state.sync).toMatchObject({ orderId: 101, status: "sent", okCount: 1, attempts: 1, webhookOrderIds: "[777]", lastError: null });
  });

  it("HTTP 500：failed＋保留自動重試標記", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const result = await forwardOrderToWms(101);
    expect(result.status).toBe("failed");
    expect(result.lastError).toContain("HTTP 500");
    expect(h.state.sync.status).toBe("failed");
    expect(h.state.sync.lastError).toContain("[wms-auto:v1]");
  });

  it("timeout：唔 throw，寫 failed 等下輪 retry", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(async () => { throw abort; }));
    const result = await forwardOrderToWms(101);
    expect(result.status).toBe("failed");
    expect(result.lastError).toContain("timeout 90s");
    expect(h.state.sync.status).toBe("failed");
  });

  it("success:true 但欠 webhookOrderId：絕唔當 sent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(null)));
    const result = await forwardOrderToWms(101);
    expect(result.status).toBe("failed");
    expect(result.lastError).toContain("欠 webhookOrderId");
    expect(h.state.sync.status).toBe("failed");
    expect(h.state.sync.webhookOrderIds).toBe("[null]");
  });

  it("舊版 sent 但冇 ID：主管批准後會真正補送；有齊 ID 就直接返回唔重送", async () => {
    h.state.sync = {
      id: 1, orderId: 101, proofId: null, lineCount: 1, okCount: 0, status: "sent",
      webhookOrderIds: null, lastError: "舊版成功但欠 ID", attempts: 1,
      createdAt: new Date("2026-11-11T00:00:00Z"), updatedAt: new Date("2026-11-11T00:00:00Z"),
    };
    const fetchMock = vi.fn(async () => okResponse(779));
    vi.stubGlobal("fetch", fetchMock);
    const recovered = await forwardOrderToWms(101, { autoRetry: true });
    expect(recovered.status).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.state.sync.webhookOrderIds).toBe("[779]");

    const again = await forwardOrderToWms(101, { autoRetry: true });
    expect(again).toEqual({ status: "sent", lineCount: 1, okCount: 1, lastError: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("兩個並發 forward：同一毫秒舊快照都只有一個認領成功、一次 HTTP", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
    h.state.sync = {
      id: 1, orderId: 101, proofId: null, lineCount: 1, okCount: 0, status: "pending",
      webhookOrderIds: null, lastError: WMS_AUTO_QUEUE_MESSAGE, attempts: 0,
      createdAt: new Date(), updatedAt: new Date(),
    };
    try {
      const fetchMock = vi.fn(async () => okResponse(778));
      vi.stubGlobal("fetch", fetchMock);
      // 兩個工作者都持有相同舊快照，updatedAt 亦同一毫秒；只有 lastError CAS 可以擋第二個。
      const results = await Promise.all([forwardOrderToWms(101), forwardOrderToWms(101)]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(results.filter((r) => r.status === "sent")).toHaveLength(1);
      expect(results.filter((r) => r.status === "pending")).toHaveLength(1);
      expect(h.state.sync.status).toBe("sent");
      expect(h.state.updates.filter((u) => u.changed && u.patch.lastError?.includes("[wms-syncing:v1:"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("逐件進度續送：已有 ID 嘅行 skip，只送缺失嗰行", async () => {
    h.state.order.items = [
      { ...ORDER.items[0], id: 1001 },
      { ...ORDER.items[0], id: 1002, productName: "一次性免運券", sku: "LUCKY-FREE-SHIP" },
    ];
    h.state.sync = {
      id: 1, orderId: 101, proofId: null, lineCount: 2, okCount: 1, status: "partial",
      webhookOrderIds: "[777,null]", lastError: "[wms-auto:v1] HTTP 500", attempts: 1,
      createdAt: new Date("2026-11-11T00:00:00Z"), updatedAt: new Date("2026-11-11T00:00:00Z"),
    };
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => okResponse(888));
    vi.stubGlobal("fetch", fetchMock);
    const result = await forwardOrderToWms(101);
    expect(result).toMatchObject({ status: "sent", lineCount: 2, okCount: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).json;
    expect(request.productCode).toBe("LUCKY-FREE-SHIP");
    expect(h.state.sync.webhookOrderIds).toBe("[777,888]");
  });

  it("訂單已離開 payment_review：唔再推送", async () => {
    h.state.order.status = "rejected";
    const fetchMock = vi.fn(async () => okResponse(999));
    vi.stubGlobal("fetch", fetchMock);
    const result = await forwardOrderToWms(101);
    expect(result.status).toBe("failed");
    expect(result.lastError).toContain("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("自動重試退避／stale 規則", () => {
  it("新排隊即時合資格；失敗按 5m/15m/1h/6h/24h 退避", () => {
    expect(wmsRetryDelayMs(0)).toBe(0);
    expect(wmsRetryDelayMs(1)).toBe(5 * 60_000);
    expect(wmsRetryDelayMs(2)).toBe(15 * 60_000);
    expect(wmsRetryDelayMs(3)).toBe(60 * 60_000);
    expect(wmsRetryDelayMs(4)).toBe(6 * 60 * 60_000);
    expect(wmsRetryDelayMs(99)).toBe(24 * 60 * 60_000);
    const now = new Date("2026-11-11T12:00:00Z");
    expect(isWmsAutoRetryDue({ status: "pending", attempts: 0, updatedAt: now, lastError: WMS_AUTO_QUEUE_MESSAGE }, now)).toBe(true);
    expect(isWmsAutoRetryDue({ status: "failed", attempts: 1, updatedAt: now, lastError: "[wms-auto:v1] HTTP 500" }, new Date(now.getTime() + 4 * 60_000))).toBe(false);
    expect(isWmsAutoRetryDue({ status: "failed", attempts: 1, updatedAt: now, lastError: "[wms-auto:v1] HTTP 500" }, new Date(now.getTime() + 5 * 60_000))).toBe(true);
  });

  it("sent、非 auto、到上限唔 retry；stale 認領 4 分鐘後先接手", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    const base = { status: "failed", attempts: 1, updatedAt: now, lastError: "[wms-auto:v1] HTTP 500" };
    expect(isWmsAutoRetryDue({ ...base, status: "sent" }, new Date(now.getTime() + 86400_000))).toBe(false);
    expect(isWmsAutoRetryDue({ ...base, lastError: "HTTP 500" }, new Date(now.getTime() + 86400_000))).toBe(false);
    expect(isWmsAutoRetryDue({ ...base, attempts: 6 }, new Date(now.getTime() + 86400_000))).toBe(false);
    const syncing = "[wms-auto:v1][wms-syncing:v1:token]";
    expect(isWmsAutoRetryDue({ ...base, status: "pending", lastError: syncing }, new Date(now.getTime() + 3 * 60_000))).toBe(false);
    expect(isWmsAutoRetryDue({ ...base, status: "pending", lastError: syncing }, new Date(now.getTime() + 4 * 60_000))).toBe(true);
  });
});

describe("開機／定時自動續送", () => {
  it("到期失敗列會重新投遞，成功後寫系統 audit", async () => {
    const updatedAt = new Date("2026-11-11T11:54:59Z");
    h.state.sync = {
      id: 1, orderId: 101, proofId: null, lineCount: 1, okCount: 0, status: "failed",
      webhookOrderIds: "[null]", lastError: "[wms-auto:v1] HTTP 500", attempts: 1,
      createdAt: updatedAt, updatedAt,
    };
    h.state.retryRows = [{
      orderId: 101, status: "failed", attempts: 1, updatedAt, lastError: "[wms-auto:v1] HTTP 500",
    }];
    const fetchMock = vi.fn(async () => okResponse(880));
    vi.stubGlobal("fetch", fetchMock);

    const result = await retryPendingWmsSync(new Date("2026-11-11T12:00:00Z"));

    expect(result).toEqual({ scanned: 1, attempted: 1, sent: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.state.sync).toMatchObject({ status: "sent", attempts: 2, webhookOrderIds: "[880]" });
    expect(vi.mocked(logAudit)).toHaveBeenCalledWith(expect.objectContaining({
      actorRole: "system", action: "order.wmsAutoResync", targetId: 101,
    }));
  });
});

describe("付款重傳重置", () => {
  it("保留同一列但清舊 ID／次數，舊 owner token 即失效", async () => {
    h.state.sync = {
      id: 1, orderId: 101, status: "failed", lineCount: 1, okCount: 1, attempts: 4,
      webhookOrderIds: "[777]", lastError: "[wms-syncing:v1:old]", createdAt: new Date(), updatedAt: new Date(),
    };
    await resetWmsSyncLogForReupload(101);
    expect(h.state.sync).toMatchObject({
      id: 1,
      orderId: 101,
      status: "pending",
      lineCount: 0,
      okCount: 0,
      attempts: 0,
      webhookOrderIds: null,
      lastError: WMS_AUTO_QUEUE_MESSAGE,
    });
    expect(h.state.inserts.some((r) => r.table === wmsSyncLog)).toBe(true);
  });
});
