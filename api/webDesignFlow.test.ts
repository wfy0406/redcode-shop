/**
 * 網站設計服務 endpoint 級 regression 測試（mock DB／mock 外部服務，唔掂真 DB／網絡／filesystem）。
 * 互補 api/webDesign.test.ts（純函數）——呢度行真 webDesignRouter.createCaller ＋
 * 真 webDesignWms shipment callback，mock 咗：DB（queries/connection）、訂單圖（sharp）、
 * Airwallex、email、audit、WMS forward；其餘（zod 輸入驗證、server 重新計價、
 * 狀態閘、冪等 callback 分支）全部係真代碼。
 *
 * 覆蓋：
 *  ① createOrder：姓名／電話必填、email optional、malformed email 拒收、front_only 揀
 *     full_stack 功能被 server 擋、server 重新計價唔信 client 金額（多餘欄位被 strip）、
 *     產圖失敗零 DB 寫入、非撞號 DB 錯誤唔 retry 兼清孤兒圖、撞號（23505）會 retry。
 *  ② attachProof：path 白名單、三欄核實統一 NOT_FOUND、cancelled／非 pending|rejected
 *     狀態閘、成功轉 review、條件更新鎖郁 0 行 → CONFLICT。
 *  ③ createPayment：未配置 → enabled:false；成功開單 amount=order.total／currency HKD／
 *     returnUrl＝/api/airwallex/return-web-design?orderNo=...／intentId 落 DB；
 *     非 pending／已取消擋；Airwallex 出錯 → INTERNAL_SERVER_ERROR。
 *  ④ WMS shipment callback（真 webDesignWms）：shipped → completed＋completedAt；
 *     重複 shipped → already 唔郁；unshipped → in_production＋清 completedAt；
 *     item_* action → ignored 唔掂 DB。
 *  ⑤ submitInquiry：email 寄失敗 → saved:true, emailSent:false（DB 照保存）；
 *     成功 → emailSent:true 兼 update 落 DB；壞電話零寫入。
 *
 * ⚠️ 界限：DB 係 mock thenable chain，真 PostgreSQL transaction／unique 語義冇驗到；
 * Airwallex／sharp／SMTP 全部 mock，真 API 合約要 integration 先驗到。
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

// ───────────────────────── mock 基礎設施（hoisted）─────────────────────────
const h = vi.hoisted(() => {
  const state = {
    // insert／update chain settle 用嘅結果 queue（Error 實例 → reject，模擬 DB 錯）
    queue: [] as any[],
    inserts: [] as { table: any; values: any; returning?: any }[],
    updates: [] as { table: any; set: any; where?: any; returning?: any }[],
    txCount: 0,
    // db.query.* 逐 test 配置
    siteSettingsRow: undefined as any, // undefined → 冇列 → 用預設 catalog
    orderRow: undefined as any, // webDesignOrders.findFirst
    orderRows: [] as any[], // webDesignOrders.findMany（lookup）
    proofRows: [] as any[], // webDesignPaymentProofs.findMany
  };
  const pop = () => (state.queue.length > 0 ? state.queue.shift() : []);
  const settle = () => {
    const v = pop();
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  };
  function makeChain(rec?: { values?: any; set?: any; where?: any; returning?: any }) {
    const chain: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (res: any, rej: any) => settle().then(res, rej);
          if (prop === "catch") return (fn: any) => settle().catch(fn);
          return (...args: any[]) => {
            if (rec && prop === "values") rec.values = args[0];
            if (rec && prop === "set") rec.set = args[0];
            if (rec && prop === "where") rec.where = args[0];
            if (rec && prop === "returning") rec.returning = args[0];
            return chain;
          };
        },
      },
    );
    return chain;
  }
  const db: any = {
    query: {
      siteSettings: { findFirst: vi.fn(async () => state.siteSettingsRow) },
      webDesignOrders: {
        findFirst: vi.fn(async () => state.orderRow),
        findMany: vi.fn(async () => state.orderRows),
      },
      webDesignPaymentProofs: {
        findFirst: vi.fn(async () => undefined),
        findMany: vi.fn(async () => state.proofRows),
      },
      webDesignInquiries: { findMany: vi.fn(async () => []) },
    },
    insert: (table: any) => {
      const rec = { table, values: undefined as any, returning: undefined as any };
      state.inserts.push(rec);
      return makeChain(rec);
    },
    update: (table: any) => {
      const rec = { table, set: undefined as any, where: undefined as any, returning: undefined as any };
      state.updates.push(rec);
      return makeChain(rec);
    },
    transaction: (cb: any) => {
      state.txCount += 1;
      return cb(db);
    },
  };
  return { state, db };
});

vi.mock("./queries/connection", () => ({ getDb: () => h.db }));
vi.mock("./auth", () => ({
  userFromAuthHeader: vi.fn(async () => null),
  verifyToken: vi.fn(async () => null),
}));
vi.mock("./audit", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("./email", () => ({
  sendWebDesignInquiryEmail: vi.fn(async () => ({ ok: true as const })),
}));
// 訂單圖：mock 走 sharp／filesystem；預設成功回合法路徑
vi.mock("./webDesignImage", () => ({
  generateWebDesignOrderImage: vi.fn(async (args: { orderNo: string }) => `/uploads/wdorder-${args.orderNo}.png`),
  deleteWebDesignOrderImage: vi.fn(async () => undefined),
}));
vi.mock("./airwallex", () => ({
  getAirwallexConfig: vi.fn(async () => null),
  createHostedPayment: vi.fn(),
  retrievePaymentIntent: vi.fn(),
}));
// WMS HTTP 層 mock；webDesignWms 本體保留真實（callback 分支要行真代碼），
// 淨係 forward（reviewProof 成功後背景轉單）換做 spy。
vi.mock("./wmsSync", () => ({
  wmsConfigured: vi.fn(() => true),
  callReceiveWebhook: vi.fn(async () => ({ error: null, webhookOrderId: 987 })),
}));
vi.mock("./webDesignWms", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./webDesignWms")>();
  return { ...mod, forwardWebDesignOrderToWms: vi.fn(async () => ({ status: "sent" as const, wmsWebhookOrderId: "987", error: null })) };
});

import { webDesignRouter } from "./webDesignRouter";
import { webDesignShipmentCallback } from "./webDesignWms";
import { webDesignOrders, webDesignOrderItems, webDesignPaymentProofs, webDesignInquiries } from "@db/schema";
import { generateWebDesignOrderImage, deleteWebDesignOrderImage } from "./webDesignImage";
import { getAirwallexConfig, createHostedPayment } from "./airwallex";
import { sendWebDesignInquiryEmail } from "./email";
import { forwardWebDesignOrderToWms } from "./webDesignWms";

const genImage = vi.mocked(generateWebDesignOrderImage);
const delImage = vi.mocked(deleteWebDesignOrderImage);
const getCfg = vi.mocked(getAirwallexConfig);
const hostedPay = vi.mocked(createHostedPayment);
const sendInquiry = vi.mocked(sendWebDesignInquiryEmail);

// ───────────────────────── helpers ─────────────────────────

/** 每個 caller 用獨立 IP，避免 module 級 RateLimiter 喺成個測試檔入面互相撞限 */
let ipSeq = 0;
function caller() {
  ipSeq += 1;
  return webDesignRouter.createCaller({
    req: new Request("http://test.local/api/trpc", { headers: { "x-forwarded-for": `10.9.9.${ipSeq}` } }),
    resHeaders: new Headers(),
  });
}

const WD_ORDER = {
  id: 5,
  orderNo: "WD202611090001",
  plan: "front_only",
  name: "陳大文",
  phone: "91234567",
  email: null,
  status: "received",
  paymentStatus: "pending",
  oneOffTotal: 1450,
  monthlyTotal: 0,
  total: 1450,
  orderImagePath: "/uploads/wdorder-WD202611090001.png",
  paymentChannel: null,
  airwallexIntentId: null,
  paidAt: null,
  wmsStatus: null,
  wmsError: null,
  wmsWebhookOrderId: null,
  completedAt: null,
  createdAt: new Date("2026-11-09T07:00:00Z"),
  updatedAt: new Date("2026-11-09T07:00:00Z"),
};

const IDENTITY = { orderNo: WD_ORDER.orderNo, name: "陳大文", phone: "91234567" };

/** 假 Hono Context：shipment callback 淨係用 c.json */
function fakeCtx() {
  const calls: { body: any; status?: number }[] = [];
  const c: any = {
    json: (body: any, status?: number) => {
      calls.push({ body, status });
      return { body, status };
    },
  };
  return { c, calls };
}

function reset() {
  h.state.queue = [];
  h.state.inserts = [];
  h.state.updates = [];
  h.state.txCount = 0;
  h.state.siteSettingsRow = undefined;
  h.state.orderRow = undefined;
  h.state.orderRows = [];
  h.state.proofRows = [];
}

beforeEach(() => {
  reset();
  vi.clearAllMocks();
  // clearAllMocks 會連 factory 入面嘅 implementation 一齊清（vi.fn(impl) 會保留，但保險起見重設關鍵 mock）
  genImage.mockImplementation(async (args: any) => `/uploads/wdorder-${args.orderNo}.png`);
  delImage.mockResolvedValue(undefined);
  getCfg.mockResolvedValue(null);
  sendInquiry.mockResolvedValue({ ok: true } as any);
  vi.mocked(forwardWebDesignOrderToWms).mockResolvedValue({ status: "sent", wmsWebhookOrderId: "987", error: null });
});

// ───────────────────────── ① createOrder ─────────────────────────

describe("createOrder 輸入驗證＋server 計價閘", () => {
  it("姓名必填：缺 name／空白 name → BAD_REQUEST，零 DB 寫入、零產圖", async () => {
    await expect(
      caller().createOrder({ plan: "front_only", phone: "91234567" } as any),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller().createOrder({ plan: "front_only", name: "   ", phone: "91234567" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.state.inserts).toHaveLength(0);
    expect(genImage).not.toHaveBeenCalled();
  });

  it("電話必填：缺 phone → BAD_REQUEST", async () => {
    await expect(
      caller().createOrder({ plan: "front_only", name: "陳大文" } as any),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.state.inserts).toHaveLength(0);
  });

  it("電話格式唔啱（非香港 8 位）→ BAD_REQUEST，唔會落到計價／產圖／DB", async () => {
    await expect(
      caller().createOrder({ plan: "front_only", name: "陳大文", phone: "123" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("電話格式唔啱") });
    expect(genImage).not.toHaveBeenCalled();
    expect(h.state.inserts).toHaveLength(0);
  });

  it("malformed email → BAD_REQUEST（電郵格式唔啱），零寫入", async () => {
    await expect(
      caller().createOrder({ plan: "front_only", name: "陳大文", phone: "91234567", email: "not-an-email" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("電郵格式唔啱") });
    expect(genImage).not.toHaveBeenCalled();
    expect(h.state.inserts).toHaveLength(0);
  });

  it("email optional：唔填 → 成功落單，DB 存 email null；電話 normalize 做純 8 位", async () => {
    h.state.queue = [
      [{ ...WD_ORDER, orderNo: "WD202611090002" }], // tx insert orders returning
      [], // tx insert items
    ];
    const r = await caller().createOrder({
      plan: "front_only",
      name: "陳大文",
      phone: "+852 9123 4567",
    });
    expect(r.orderNo).toBe("WD202611090002"); // 回傳跟 DB 寫入嘅正式單號
    // 訂單圖跟「實際抽中嘅單號」生（撞號 retry 會換號），路徑格式白名單內
    expect(r.orderImagePath).toMatch(/^\/uploads\/wdorder-WD\d+\.png$/);
    const orderIns = h.state.inserts.find((i) => i.table === webDesignOrders);
    expect(orderIns?.values).toMatchObject({
      name: "陳大文",
      phone: "91234567", // normalize 咗
      email: null, // optional 缺省 → null
      status: "received",
      paymentStatus: "pending",
    });
    expect(h.state.txCount).toBe(1); // 訂單＋items 同一 transaction
  });

  it("server 重新計價：client 夾帶 total:1 假金額被 strip，DB／回傳一律用 server 價", async () => {
    h.state.queue = [[{ ...WD_ORDER }], []];
    const r = await caller().createOrder({
      plan: "front_only",
      itemKeys: ["seo_meta"], // 180
      name: "陳大文",
      phone: "91234567",
      total: 1, // 惡意／錯誤金額——zod strip，server 重計
    } as any);
    expect(r.total).toBe(1450 + 180); // server 價，唔係 1
    expect(r.oneOffTotal).toBe(1630);
    const orderIns = h.state.inserts.find((i) => i.table === webDesignOrders);
    expect(orderIns?.values.total).toBe(1630);
    const itemIns = h.state.inserts.find((i) => i.table === webDesignOrderItems);
    expect(itemIns?.values).toHaveLength(2); // 方案行＋seo_meta
    expect(itemIns?.values.map((v: any) => v.itemKey)).toEqual(["plan_front_only", "seo_meta"]);
  });

  it("front_only 揀 full_stack-only 功能 → server 閘 BAD_REQUEST，零產圖零寫入", async () => {
    await expect(
      caller().createOrder({ plan: "front_only", itemKeys: ["catalog_admin"], name: "陳大文", phone: "91234567" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("前台＋後台") });
    expect(genImage).not.toHaveBeenCalled();
    expect(h.state.inserts).toHaveLength(0);
  });

  it("產圖失敗 → INTERNAL_SERVER_ERROR 兼零 DB 寫入（唔會有半張單）", async () => {
    genImage.mockRejectedValueOnce(new Error("sharp 爆咗"));
    await expect(
      caller().createOrder({ plan: "front_only", name: "陳大文", phone: "91234567" }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(h.state.inserts).toHaveLength(0);
    expect(h.state.txCount).toBe(0);
  });

  it("DB 非撞號錯誤 → 唔 retry：產圖一次、清孤兒圖、INTERNAL_SERVER_ERROR", async () => {
    h.state.queue = [new Error("connection terminated")];
    await expect(
      caller().createOrder({ plan: "front_only", name: "陳大文", phone: "91234567" }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(genImage).toHaveBeenCalledTimes(1); // 冇亂 retry
    expect(delImage).toHaveBeenCalledTimes(1); // 清咗張孤兒圖
  });

  it("orderNo 撞號（23505）→ 清舊圖、retry 第二個號成功", async () => {
    const dup = Object.assign(new Error("duplicate key value"), { code: "23505" });
    h.state.queue = [dup, [{ ...WD_ORDER, orderNo: "WD202611090777" }], []];
    const r = await caller().createOrder({ plan: "front_only", name: "陳大文", phone: "91234567" });
    expect(r.orderNo).toBe("WD202611090777");
    expect(genImage).toHaveBeenCalledTimes(2); // 每個號一張圖
    expect(delImage).toHaveBeenCalledTimes(1); // 舊號嗰張清咗
    expect(h.state.txCount).toBe(2);
  });
});

// ───────────────────────── ② attachProof ─────────────────────────

describe("attachProof 狀態閘＋path 白名單", () => {
  const PROOF_PATH = "/uploads/wdproof-abc123.png";

  it("非 wdproof 白名單路徑 → BAD_REQUEST，唔查 DB", async () => {
    await expect(
      caller().attachProof({ ...IDENTITY, imagePath: "/uploads/other-old.png" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller().attachProof({ ...IDENTITY, imagePath: "/uploads/../etc/passwd.png" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.db.query.webDesignOrders.findFirst).not.toHaveBeenCalled();
  });

  it("三欄唔中 → 統一 NOT_FOUND（防枚舉）", async () => {
    h.state.orderRow = undefined; // 搵唔到
    await expect(
      caller().attachProof({ ...IDENTITY, imagePath: PROOF_PATH }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("已取消訂單 → BAD_REQUEST", async () => {
    h.state.orderRow = { ...WD_ORDER, status: "cancelled" };
    await expect(
      caller().attachProof({ ...IDENTITY, imagePath: PROOF_PATH }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("已取消") });
  });

  it("非 pending／rejected 狀態（review／paid）→ BAD_REQUEST，唔准重複掛證明", async () => {
    for (const paymentStatus of ["review", "paid"]) {
      reset();
      h.state.orderRow = { ...WD_ORDER, paymentStatus };
      await expect(
        caller().attachProof({ ...IDENTITY, imagePath: PROOF_PATH }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("唔係待付款狀態") });
      expect(h.state.inserts).toHaveLength(0);
    }
  });

  it("成功：pending → 插 proof＋條件更新轉 review（同一 transaction）", async () => {
    h.state.orderRow = { ...WD_ORDER };
    h.state.queue = [
      [], // tx insert proof
      [{ id: 5 }], // tx 條件更新 returning（鎖到 1 行）
    ];
    const r = await caller().attachProof({ ...IDENTITY, imagePath: PROOF_PATH });
    expect(r).toEqual({ ok: true, orderNo: WD_ORDER.orderNo, paymentStatus: "review" });
    expect(h.state.txCount).toBe(1);
    const proofIns = h.state.inserts.find((i) => i.table === webDesignPaymentProofs);
    expect(proofIns?.values).toMatchObject({ orderId: 5, imagePath: PROOF_PATH, status: "pending" });
    const upd = h.state.updates.find((u) => u.table === webDesignOrders);
    expect(upd?.set).toMatchObject({ paymentStatus: "review" });
  });

  it("rejected（客人重傳）都掛得", async () => {
    h.state.orderRow = { ...WD_ORDER, paymentStatus: "rejected" };
    h.state.queue = [[], [{ id: 5 }]];
    const r = await caller().attachProof({ ...IDENTITY, imagePath: PROOF_PATH });
    expect(r.paymentStatus).toBe("review");
  });

  it("並發鎖：條件更新郁 0 行 → CONFLICT，唔會將 paid／cancelled 冚返做 review", async () => {
    h.state.orderRow = { ...WD_ORDER };
    h.state.queue = [
      [], // proof insert
      [], // update returning 0 行——webhook／WMS 啱啱先改咗態
    ];
    await expect(
      caller().attachProof({ ...IDENTITY, imagePath: PROOF_PATH }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

// ───────────────────────── ③ createPayment ─────────────────────────

describe("createPayment（Airwallex HPP）", () => {
  const CFG = {
    clientId: "cid",
    apiKey: "key",
    webhookSecret: "sec",
    baseUrl: "https://api-demo.airwallex.com",
    publicBaseUrl: "https://redcode.red",
  };

  it("未配置 Airwallex → enabled:false（唔查單、唔開單）", async () => {
    getCfg.mockResolvedValue(null);
    const r = await caller().createPayment(IDENTITY);
    expect(r).toMatchObject({ enabled: false });
    expect(hostedPay).not.toHaveBeenCalled();
    expect(h.db.query.webDesignOrders.findFirst).not.toHaveBeenCalled();
  });

  it("成功：amount＝訂單 total、currency HKD、returnUrl 帶 orderNo、intentId 落 DB", async () => {
    getCfg.mockResolvedValue(CFG as any);
    h.state.orderRow = { ...WD_ORDER, total: 4400 };
    hostedPay.mockImplementation(async (args: any) => ({
      intentId: "int_abc123",
      clientSecret: "secret_xyz",
      env: "demo" as const,
      currency: "HKD",
      returnUrl: args.returnUrl,
    }));
    h.state.queue = [[]]; // db.update orders set airwallexIntentId
    const r = await caller().createPayment(IDENTITY);
    expect(r).toMatchObject({
      enabled: true,
      intentId: "int_abc123",
      clientSecret: "secret_xyz",
      currency: "HKD",
      orderNo: WD_ORDER.orderNo,
      amount: 4400, // server 用訂單 total，唔信 client
    });
    // 開單參數：金額＝訂單總額、returnUrl＝web-design 專用中轉
    expect(hostedPay).toHaveBeenCalledTimes(1);
    const args = hostedPay.mock.calls[0][0] as any;
    expect(args.amount).toBe(4400);
    expect(args.orderNo).toBe(WD_ORDER.orderNo);
    expect(args.returnUrl).toBe(
      `https://redcode.red/api/airwallex/return-web-design?orderNo=${WD_ORDER.orderNo}`,
    );
    expect((r as any).returnUrl).toBe(args.returnUrl);
    // intentId 記落訂單（之後 webhook 綁定用）
    const upd = h.state.updates.find((u) => u.table === webDesignOrders);
    expect(upd?.set).toMatchObject({ airwallexIntentId: "int_abc123" });
  });

  it("非 pending 狀態（review＝已傳截圖待核）→ BAD_REQUEST，唔准再開付款單", async () => {
    getCfg.mockResolvedValue(CFG as any);
    h.state.orderRow = { ...WD_ORDER, paymentStatus: "review" };
    await expect(caller().createPayment(IDENTITY)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(hostedPay).not.toHaveBeenCalled();
  });

  it("已取消訂單 → BAD_REQUEST；三欄唔中 → NOT_FOUND", async () => {
    getCfg.mockResolvedValue(CFG as any);
    h.state.orderRow = { ...WD_ORDER, status: "cancelled" };
    await expect(caller().createPayment(IDENTITY)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    h.state.orderRow = undefined;
    await expect(caller().createPayment(IDENTITY)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(hostedPay).not.toHaveBeenCalled();
  });

  it("Airwallex 開單失敗 → INTERNAL_SERVER_ERROR，唔會記低 intentId", async () => {
    getCfg.mockResolvedValue(CFG as any);
    h.state.orderRow = { ...WD_ORDER };
    hostedPay.mockRejectedValue(new Error("Airwallex 500"));
    await expect(caller().createPayment(IDENTITY)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(h.state.updates).toHaveLength(0);
  });
});

// ───────────────────────── ④ WMS shipment callback（真 webDesignWms）─────────────────────────

describe("WMS shipment callback（服務單交付）", () => {
  it("shipped → completed＋completedAt 落 DB", async () => {
    h.state.orderRow = { ...WD_ORDER, status: "in_production", paymentStatus: "paid" };
    h.state.queue = [[]]; // db.update orders
    const { c, calls } = fakeCtx();
    const r: any = await webDesignShipmentCallback(c, {
      orderNo: WD_ORDER.orderNo,
      action: "shipped",
      actorName: "WMS同事",
    });
    expect(r.body).toMatchObject({ ok: true, orderNo: WD_ORDER.orderNo, status: "completed" });
    const upd = h.state.updates.find((u) => u.table === webDesignOrders);
    expect(upd?.set.status).toBe("completed");
    expect(upd?.set.completedAt).toBeInstanceOf(Date); // 交付時間有寫
    expect(calls).toHaveLength(1);
  });

  it("重複 shipped（已 completed）→ already:true，零 DB 寫入（冪等）", async () => {
    h.state.orderRow = { ...WD_ORDER, status: "completed", paymentStatus: "paid", completedAt: new Date() };
    const { c } = fakeCtx();
    const r: any = await webDesignShipmentCallback(c, {
      orderNo: WD_ORDER.orderNo,
      action: "shipped",
      actorName: "WMS同事",
    });
    expect(r.body).toMatchObject({ ok: true, already: true, status: "completed" });
    expect(h.state.updates).toHaveLength(0); // 唔會再郁
  });

  it("unshipped（撤回交付）→ in_production＋清 completedAt", async () => {
    h.state.orderRow = { ...WD_ORDER, status: "completed", paymentStatus: "paid", completedAt: new Date() };
    h.state.queue = [[]];
    const { c } = fakeCtx();
    const r: any = await webDesignShipmentCallback(c, {
      orderNo: WD_ORDER.orderNo,
      action: "unshipped",
      actorName: "WMS同事",
    });
    expect(r.body).toMatchObject({ ok: true, status: "in_production" });
    const upd = h.state.updates.find((u) => u.table === webDesignOrders);
    expect(upd?.set.status).toBe("in_production");
    expect(upd?.set.completedAt).toBeNull(); // 交付時間清走
  });

  it("item_* 等唔適用 action → ignored:true，完全唔掂 DB（唔畀 WMS 無限 retry）", async () => {
    const { c } = fakeCtx();
    const r: any = await webDesignShipmentCallback(c, {
      orderNo: WD_ORDER.orderNo,
      action: "item_cancelled",
      actorName: "WMS同事",
    });
    expect(r.body).toMatchObject({ ok: true, ignored: true });
    expect(h.db.query.webDesignOrders.findFirst).not.toHaveBeenCalled();
    expect(h.state.updates).toHaveLength(0);
  });

  it("已取消訂單嘅 shipped → already:true 唔郁（終態保護）", async () => {
    h.state.orderRow = { ...WD_ORDER, status: "cancelled" };
    const { c } = fakeCtx();
    const r: any = await webDesignShipmentCallback(c, {
      orderNo: WD_ORDER.orderNo,
      action: "shipped",
      actorName: "WMS同事",
    });
    expect(r.body).toMatchObject({ ok: true, already: true, status: "cancelled" });
    expect(h.state.updates).toHaveLength(0);
  });

  it("搵唔到訂單 → 404", async () => {
    h.state.orderRow = undefined;
    const { c } = fakeCtx();
    const r: any = await webDesignShipmentCallback(c, {
      orderNo: "WD202611099999",
      action: "shipped",
      actorName: "WMS同事",
    });
    expect(r.status).toBe(404);
    expect(r.body.ok).toBe(false);
  });
});

// ───────────────────────── ⑤ submitInquiry ─────────────────────────

describe("submitInquiry（留言保存優先，email 失敗唔丟留言）", () => {
  const INPUT = { name: "陳大文", phone: "91234567", email: "chan@example.com", message: "想問幾耐整好？" };

  it("email 寄失敗 → saved:true, emailSent:false（DB 已保存），唔 update emailSent", async () => {
    sendInquiry.mockResolvedValue({ ok: false, error: "Resend 500" } as any);
    h.state.queue = [[{ id: 7 }]]; // insert inquiry returning
    const r = await caller().submitInquiry(INPUT);
    expect(r).toMatchObject({ ok: true, saved: true, inquiryId: 7, emailSent: false });
    expect((r as any).note).toContain("已保存");
    const ins = h.state.inserts.find((i) => i.table === webDesignInquiries);
    expect(ins?.values).toMatchObject({ name: "陳大文", phone: "91234567", email: "chan@example.com" });
    expect(h.state.updates).toHaveLength(0); // 失敗唔會寫 emailSent:true
  });

  it("email 成功 → emailSent:true 兼 update 落 DB", async () => {
    sendInquiry.mockResolvedValue({ ok: true } as any);
    h.state.queue = [[{ id: 8 }], []]; // insert returning → update emailSent
    const r = await caller().submitInquiry(INPUT);
    expect(r).toMatchObject({ ok: true, saved: true, inquiryId: 8, emailSent: true });
    expect((r as any).note).toBeUndefined();
    const upd = h.state.updates.find((u) => u.table === webDesignInquiries);
    expect(upd?.set).toMatchObject({ emailSent: true });
  });

  it("壞電話 → BAD_REQUEST，零寫入、唔寄信", async () => {
    await expect(
      caller().submitInquiry({ ...INPUT, phone: "abc" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.state.inserts).toHaveLength(0);
    expect(sendInquiry).not.toHaveBeenCalled();
  });

  it("留言必填：空 message → BAD_REQUEST", async () => {
    await expect(
      caller().submitInquiry({ ...INPUT, message: "   " }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.state.inserts).toHaveLength(0);
  });
});

// ───────────────────────── lookup（私隱查單補充）─────────────────────────

describe("lookup 私隱查單", () => {
  it("壞電話 → found:false，完全唔查 DB（唔洩露邊欄錯）", async () => {
    const r1 = await caller().lookup({ name: "陳大文", phone: "123" });
    expect(r1).toEqual({ found: false, orders: [] });
    expect(h.db.query.webDesignOrders.findMany).not.toHaveBeenCalled();
  });

  it("空白姓名 → zod 層 BAD_REQUEST（nameSchema min 1），同樣唔查 DB", async () => {
    await expect(caller().lookup({ name: " ", phone: "91234567" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(h.db.query.webDesignOrders.findMany).not.toHaveBeenCalled();
  });

  it("三欄啱 → 回訂單（電話 normalize 後先查）", async () => {
    h.state.orderRows = [
      {
        ...WD_ORDER,
        items: [
          {
            itemKey: "plan_front_only",
            name: "網站設計服務（前台）",
            plan: "front_only",
            billing: "one_off",
            price: 1450,
            marketPrice: 6800,
            sortOrder: 0,
          },
        ],
      },
    ];
    const r = await caller().lookup({ name: " 陳大文 ", phone: "+852 9123 4567" });
    expect(r.found).toBe(true);
    expect(r.orders[0]).toMatchObject({ orderNo: WD_ORDER.orderNo, total: 1450 });
    expect(r.orders[0].items).toHaveLength(1);
  });
});
