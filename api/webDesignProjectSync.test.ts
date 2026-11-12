/**
 * v2026.11.12（網頁設計獨立專案管理 SPEC）隔離測試：
 * 新網頁設計服務單由 `order.receiveWebhook` 改為 `webDesignProject.receiveWebsite`。
 *
 * 全 mock／隔離：DB（queries/connection）係 thenable chain mock，外部服務零連線；
 * transport 測試用 vi.stubGlobal('fetch') 截住 HTTP 層，行真 wmsSync 代碼。
 *
 * 覆蓋：
 *  ① 已付款服務單走新路：callReceiveWebDesignProject 被呼叫、payload 傳齊
 *     orderNo／客戶／方案／功能(serviceItems)／款項／要求／風格／orderDate／paidAt／
 *     orderImageUrl／paymentNote／sourcePayload；舊 callReceiveWebhook **零呼叫**；
 *     projectNo 存入現有 varchar wmsWebhookOrderId（唔改 schema）。
 *  ② 未付款／已取消唔送（付款閘不變）；已成功（sent＋projectNo）重複唔再呼叫；
 *     未配置 WMS → disabled 落痕。
 *  ③ WMS 失敗如實：error 原文落 wmsError＋wmsStatus='failed'，唔會寫假 sent；
 *     WMS deduped 重複回照樣當成功（冪等）。
 *     安全閘（forward 層）：WMS 回 success 但缺 projectNo（null／空白）→
 *     failed「WMS 回應缺少專案編號」，絕不寫 sent+null；projectNo 頭尾空白會 trim。
 *  ④ transport（真 callReceiveWebDesignProject）：URL＝/api/trpc/webDesignProject.receiveWebsite、
 *     apiKey 擺 body、success/deduped 解析、error.json.message 解析、never-throw（network／timeout 90s）。
 *     安全閘（transport 層）：success:true 必須帶 trim 後非空 projectNo 先算成功，
 *     否則 error「WMS 回應缺少專案編號」。
 *  ⑤ 舊路不變：真 callReceiveWebhook 仍然打 /api/trpc/order.receiveWebhook（普通商品路徑 regression guard）。
 *  ⑥ 舊 WD callbacks 兼容：webDesignReviewCallback approved→in_production＋paid（補 paidAt）、
 *     rejected+reupload→payment rejected、終態冪等、搵唔到 404；shipment shipped→completed。
 *
 * ⚠️ 界限：DB transaction／unique 語義冇驗到；真 WMS 合約要 integration 先驗到。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// ───────────────────────── mock 基礎設施（hoisted）─────────────────────────
const h = vi.hoisted(() => {
  const state = {
    queue: [] as any[],
    updates: [] as { table: any; set: any; where?: any }[],
    orderRow: undefined as any, // webDesignOrders.findFirst（連 items）
    proofRows: [] as any[], // webDesignPaymentProofs.findMany
  };
  const pop = () => (state.queue.length > 0 ? state.queue.shift() : []);
  const settle = () => {
    const v = pop();
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  };
  function makeChain(rec?: { set?: any; where?: any }) {
    const chain: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (res: any, rej: any) => settle().then(res, rej);
          if (prop === "catch") return (fn: any) => settle().catch(fn);
          return (...args: any[]) => {
            if (rec && prop === "set") rec.set = args[0];
            if (rec && prop === "where") rec.where = args[0];
            return chain;
          };
        },
      },
    );
    return chain;
  }
  const db: any = {
    query: {
      webDesignOrders: { findFirst: vi.fn(async () => state.orderRow) },
      webDesignPaymentProofs: { findMany: vi.fn(async () => state.proofRows) },
    },
    update: (table: any) => {
      const rec = { table, set: undefined as any, where: undefined as any };
      state.updates.push(rec);
      return makeChain(rec);
    },
  };
  // 真 transport 引用（喺 ./wmsSync mock factory 入面 capture），transport 測試用
  const real = {} as {
    callReceiveWebDesignProject: (body: Record<string, unknown>) => Promise<any>;
    callReceiveWebhook: (body: Record<string, unknown>) => Promise<any>;
  };
  return { state, db, real };
});

vi.mock("./queries/connection", () => ({ getDb: () => h.db }));
vi.mock("./audit", () => ({ logAudit: vi.fn(async () => undefined) }));
// wmsSync importOriginal 會拉 ./email／./vip——mock 走，避免外部服務模組入測試
vi.mock("./email", () => ({
  sendOrderApprovedEmail: vi.fn(async () => ({ ok: true as const })),
  orderVipEmailInfo: vi.fn(() => null),
}));
vi.mock("./vip", () => ({ recomputeVipTierInBackground: vi.fn() }));
vi.mock("./wmsSync", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./wmsSync")>();
  h.real.callReceiveWebDesignProject = mod.callReceiveWebDesignProject;
  h.real.callReceiveWebhook = mod.callReceiveWebhook;
  return {
    ...mod,
    wmsConfigured: vi.fn(() => true),
    callReceiveWebhook: vi.fn(),
    callReceiveWebDesignProject: vi.fn(),
  };
});

import {
  forwardWebDesignOrderToWms,
  webDesignReviewCallback,
  webDesignShipmentCallback,
} from "./webDesignWms";
import { callReceiveWebhook, callReceiveWebDesignProject, wmsConfigured } from "./wmsSync";
import { webDesignOrders, webDesignPaymentProofs } from "@db/schema";

const recvProject = vi.mocked(callReceiveWebDesignProject);
const recvWebhook = vi.mocked(callReceiveWebhook);
const configured = vi.mocked(wmsConfigured);

// ───────────────────────── fixtures ─────────────────────────

const PAID_AT = new Date("2026-11-12T03:00:00Z");
const CREATED_AT = new Date("2026-11-12T02:00:00Z"); // HKT 10:00 → orderDate 2026-11-12

const WD_ORDER: any = {
  id: 5,
  orderNo: "WD202611120001",
  plan: "front_only",
  name: "陳大文",
  phone: "91234567",
  email: "chan@example.com",
  requirements: "要公司簡介頁＋聯絡表格",
  styleNotes: "黑白簡約",
  status: "received",
  paymentStatus: "paid",
  oneOffTotal: 2908,
  monthlyTotal: 633,
  total: 3541,
  orderImagePath: "/uploads/wdorder-WD202611120001.png",
  paymentChannel: "manual",
  airwallexIntentId: null,
  paidAt: PAID_AT,
  wmsStatus: null,
  wmsError: null,
  wmsWebhookOrderId: null,
  completedAt: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  items: [
    { itemKey: "plan_front_only", name: "網站設計服務（前台）", billing: "one_off", price: 1668 },
    { itemKey: "seo_package", name: "SEO 搜尋引擎優化套票", billing: "one_off", price: 1240 },
    { itemKey: "hosting_monthly", name: "網站寄存及維護", billing: "monthly", price: 633 },
  ],
};

/** 假 Hono Context：callbacks 淨係用 c.json */
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
  h.state.updates = [];
  h.state.orderRow = undefined;
  h.state.proofRows = [];
}

beforeEach(() => {
  reset();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  configured.mockReturnValue(true);
  recvProject.mockResolvedValue({ projectNo: WD_ORDER.orderNo, deduped: false, error: null });
  recvWebhook.mockResolvedValue({ webhookOrderId: 987, error: null });
  process.env.WMS_API_KEY = "test-wms-key";
  process.env.WMS_BASE_URL = "https://wms.test";
  delete process.env.PUBLIC_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WMS_API_KEY;
  delete process.env.WMS_BASE_URL;
});

// ───────────────────────── ① 新路 forward ─────────────────────────

describe("forwardWebDesignOrderToWms → webDesignProject.receiveWebsite", () => {
  it("已付款服務單走新路：payload 傳齊 SPEC 欄位，projectNo 存 wmsWebhookOrderId；舊路零呼叫", async () => {
    h.state.orderRow = WD_ORDER;
    h.state.queue = [[]]; // save sent
    const r = await forwardWebDesignOrderToWms(5);
    expect(r).toEqual({ status: "sent", wmsWebhookOrderId: "WD202611120001", error: null });

    expect(recvProject).toHaveBeenCalledTimes(1);
    expect(recvWebhook).not.toHaveBeenCalled(); // 唔再走 order.receiveWebhook

    const body = recvProject.mock.calls[0][0] as any;
    expect(body).toMatchObject({
      orderNo: "WD202611120001",
      clientName: "陳大文",
      phone: "91234567",
      email: "chan@example.com",
      plan: "front_only",
      planLabel: "只要前台",
      oneOffTotal: 2908,
      monthlyTotal: 633,
      total: 3541,
      requirements: "要公司簡介頁＋聯絡表格",
      styleNotes: "黑白簡約",
      orderDate: "2026-11-12", // HKT date of createdAt
      paidAt: PAID_AT.toISOString(),
      orderImageUrl: "https://redcode.red/uploads/wdorder-WD202611120001.png",
    });
    expect(body.paymentNote).toContain("手動過數");
    // 功能行：方案行＋一次性功能＋月費項，billing 逐行正確
    expect(body.serviceItems).toEqual([
      { name: "網站設計服務（前台）", billing: "one_off", price: 1668 },
      { name: "SEO 搜尋引擎優化套票", billing: "one_off", price: 1240 },
      { name: "網站寄存及維護", billing: "monthly", price: 633 },
    ]);
    // sourcePayload：完整落單快照 JSON 字串
    const snap = JSON.parse(body.sourcePayload);
    expect(snap).toMatchObject({
      orderNo: "WD202611120001",
      kind: "web_design",
      plan: "front_only",
      oneOffTotal: 2908,
      monthlyTotal: 633,
      total: 3541,
      requirements: "要公司簡介頁＋聯絡表格",
      styleNotes: "黑白簡約",
      customer: { name: "陳大文", phone: "91234567", email: "chan@example.com" },
      orderImageUrl: "https://redcode.red/uploads/wdorder-WD202611120001.png",
    });
    expect(snap.items[0]).toMatchObject({ sku: "WD202611120001", price: 3541 });

    // 結果落 DB：sent＋projectNo 存入現有 wmsWebhookOrderId varchar
    const upd = h.state.updates.find((u) => u.table === webDesignOrders);
    expect(upd?.set).toMatchObject({
      wmsStatus: "sent",
      wmsError: null,
      wmsWebhookOrderId: "WD202611120001",
    });
  });

  it("WMS deduped 重複回：照樣記 sent＋存 projectNo（冪等，唔當失敗）", async () => {
    h.state.orderRow = WD_ORDER;
    h.state.queue = [[]];
    recvProject.mockResolvedValue({ projectNo: "WD202611120001", deduped: true, error: null });
    const r = await forwardWebDesignOrderToWms(5);
    expect(r.status).toBe("sent");
    expect(r.wmsWebhookOrderId).toBe("WD202611120001");
    const upd = h.state.updates.find((u) => u.table === webDesignOrders);
    expect(upd?.set.wmsStatus).toBe("sent");
  });

  it("Airwallex 單：paymentNote 寫明收款已確認＋intent 單號", async () => {
    h.state.orderRow = {
      ...WD_ORDER,
      paymentChannel: "airwallex",
      airwallexIntentId: "int_abc123",
    };
    h.state.queue = [[]];
    await forwardWebDesignOrderToWms(5);
    const body = recvProject.mock.calls[0][0] as any;
    expect(body.paymentNote).toContain("Airwallex 網上收款已確認");
    expect(body.paymentNote).toContain("int_abc123");
  });

  it("冇訂單圖／冇 email：orderImageUrl null、email null 照送（唔會爆）", async () => {
    h.state.orderRow = { ...WD_ORDER, orderImagePath: null, email: null };
    h.state.queue = [[]];
    const r = await forwardWebDesignOrderToWms(5);
    expect(r.status).toBe("sent");
    const body = recvProject.mock.calls[0][0] as any;
    expect(body.orderImageUrl).toBeNull();
    expect(body.email).toBeNull();
  });
});

// ───────────────────────── ② 付款閘／冪等／未配置 ─────────────────────────

describe("付款閘／冪等／未配置", () => {
  it("未付款（pending）唔送：如實 failed，零 transport 呼叫、零 DB 寫入", async () => {
    h.state.orderRow = { ...WD_ORDER, paymentStatus: "pending", paidAt: null };
    const r = await forwardWebDesignOrderToWms(5);
    expect(r.status).toBe("failed");
    expect(r.error).toContain("未確認付款");
    expect(recvProject).not.toHaveBeenCalled();
    expect(recvWebhook).not.toHaveBeenCalled();
    expect(h.state.updates).toHaveLength(0);
  });

  it("review（截圖待核實）都唔送：付款閘唔俾繞過", async () => {
    h.state.orderRow = { ...WD_ORDER, paymentStatus: "review", paidAt: null };
    const r = await forwardWebDesignOrderToWms(5);
    expect(r.status).toBe("failed");
    expect(recvProject).not.toHaveBeenCalled();
  });

  it("已取消唔送", async () => {
    h.state.orderRow = { ...WD_ORDER, status: "cancelled" };
    const r = await forwardWebDesignOrderToWms(5);
    expect(r.status).toBe("failed");
    expect(recvProject).not.toHaveBeenCalled();
  });

  it("已 sent＋有 projectNo：直接回成功，唔再呼叫 WMS（官網端冪等）", async () => {
    h.state.orderRow = { ...WD_ORDER, wmsStatus: "sent", wmsWebhookOrderId: "WD202611120001" };
    const r = await forwardWebDesignOrderToWms(5);
    expect(r).toEqual({ status: "sent", wmsWebhookOrderId: "WD202611120001", error: null });
    expect(recvProject).not.toHaveBeenCalled();
    expect(recvWebhook).not.toHaveBeenCalled();
    expect(h.state.updates).toHaveLength(0);
  });

  it("未設定 WMS_API_KEY → disabled 落痕，唔會靜默", async () => {
    configured.mockReturnValue(false);
    h.state.orderRow = WD_ORDER;
    h.state.queue = [[]];
    const r = await forwardWebDesignOrderToWms(5);
    expect(r.status).toBe("disabled");
    expect(r.error).toContain("WMS_API_KEY");
    expect(recvProject).not.toHaveBeenCalled();
    const upd = h.state.updates.find((u) => u.table === webDesignOrders);
    expect(upd?.set.wmsStatus).toBe("disabled");
    expect(upd?.set.wmsError).toContain("WMS_API_KEY");
  });
});

// ───────────────────────── ③ 失敗如實 ─────────────────────────

describe("失敗如實留痕", () => {
  it("WMS CONFLICT（舊 webhookOrders 撞單）：error 原文落 wmsError＋failed，唔寫假 sent", async () => {
    h.state.orderRow = WD_ORDER;
    h.state.queue = [[]];
    const conflict = "同一 orderNo 已存在舊 webhookOrders，唔可以建立新專案";
    recvProject.mockResolvedValue({ projectNo: null, deduped: false, error: conflict });
    const r = await forwardWebDesignOrderToWms(5);
    expect(r).toEqual({ status: "failed", wmsWebhookOrderId: null, error: conflict });
    const upd = h.state.updates.find((u) => u.table === webDesignOrders);
    expect(upd?.set).toMatchObject({ wmsStatus: "failed", wmsError: conflict });
    expect(upd?.set.wmsWebhookOrderId).toBeUndefined(); // 唔會寫假 projectNo
  });

  it("WMS timeout：timeout 字樣落痕，可 retryWms 補送", async () => {
    h.state.orderRow = WD_ORDER;
    h.state.queue = [[]];
    recvProject.mockResolvedValue({ projectNo: null, deduped: false, error: "timeout 90s" });
    const r = await forwardWebDesignOrderToWms(5);
    expect(r.status).toBe("failed");
    expect(r.error).toBe("timeout 90s");
    const upd = h.state.updates.find((u) => u.table === webDesignOrders);
    expect(upd?.set.wmsError).toBe("timeout 90s");
  });

  it("安全閘：WMS 回 success 但缺 projectNo（null）→ failed「WMS 回應缺少專案編號」，絕不寫 sent+null", async () => {
    h.state.orderRow = WD_ORDER;
    h.state.queue = [[]];
    // 假設 transport 層漏咗（防禦式回歸）：error:null 但 projectNo:null
    recvProject.mockResolvedValue({ projectNo: null, deduped: false, error: null });
    const r = await forwardWebDesignOrderToWms(5);
    expect(r).toEqual({ status: "failed", wmsWebhookOrderId: null, error: "WMS 回應缺少專案編號" });
    const upd = h.state.updates.find((u) => u.table === webDesignOrders);
    expect(upd?.set).toMatchObject({ wmsStatus: "failed", wmsError: "WMS 回應缺少專案編號" });
    expect(upd?.set.wmsStatus).not.toBe("sent");
    expect(upd?.set.wmsWebhookOrderId).toBeUndefined(); // 絕唔准 sent+null
  });

  it("安全閘：WMS 回 success 但 projectNo 係空白字串 → 同樣 failed，唔當成功", async () => {
    h.state.orderRow = WD_ORDER;
    h.state.queue = [[]];
    recvProject.mockResolvedValue({ projectNo: "   ", deduped: false, error: null });
    const r = await forwardWebDesignOrderToWms(5);
    expect(r).toEqual({ status: "failed", wmsWebhookOrderId: null, error: "WMS 回應缺少專案編號" });
    const upd = h.state.updates.find((u) => u.table === webDesignOrders);
    expect(upd?.set.wmsStatus).toBe("failed");
    expect(upd?.set.wmsWebhookOrderId).toBeUndefined();
  });

  it("projectNo 頭尾有空白：trim 後照樣記 sent（正常成功路徑唔受安全閘影響）", async () => {
    h.state.orderRow = WD_ORDER;
    h.state.queue = [[]];
    recvProject.mockResolvedValue({ projectNo: "  WD202611120001  ", deduped: false, error: null });
    const r = await forwardWebDesignOrderToWms(5);
    expect(r).toEqual({ status: "sent", wmsWebhookOrderId: "WD202611120001", error: null });
    const upd = h.state.updates.find((u) => u.table === webDesignOrders);
    expect(upd?.set).toMatchObject({ wmsStatus: "sent", wmsWebhookOrderId: "WD202611120001" });
  });

  it("訂單唔存在 → failed，唔掂 transport", async () => {
    h.state.orderRow = undefined;
    const r = await forwardWebDesignOrderToWms(999);
    expect(r.status).toBe("failed");
    expect(r.error).toContain("訂單不存在");
    expect(recvProject).not.toHaveBeenCalled();
  });
});

// ───────────────────────── ④ 真 transport（fetch stub）─────────────────────────

describe("callReceiveWebDesignProject transport（真代碼＋fetch stub）", () => {
  function stubFetch(payload: unknown, status = 200) {
    const fetchMock = vi.fn(async () => ({
      status,
      json: async () => payload,
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("POST 去 /api/trpc/webDesignProject.receiveWebsite，apiKey 擺 body {json:...}", async () => {
    const fetchMock = stubFetch({
      result: { data: { json: { success: true, deduped: false, projectNo: "WD202611120001" } } },
    });
    const r = await h.real.callReceiveWebDesignProject({ orderNo: "WD202611120001" });
    expect(r).toEqual({ projectNo: "WD202611120001", deduped: false, error: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toBe("https://wms.test/api/trpc/webDesignProject.receiveWebsite");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body);
    expect(sent.json.apiKey).toBe("test-wms-key");
    expect(sent.json.orderNo).toBe("WD202611120001");
  });

  it("deduped 回應解析：{success:true,deduped:true,projectNo}", async () => {
    stubFetch({ result: { data: { json: { success: true, deduped: true, projectNo: "WD202611120001" } } } });
    const r = await h.real.callReceiveWebDesignProject({ orderNo: "WD202611120001" });
    expect(r).toEqual({ projectNo: "WD202611120001", deduped: true, error: null });
  });

  it("安全閘：success:true 但冇 projectNo 欄位 → error「WMS 回應缺少專案編號」，唔當成功", async () => {
    stubFetch({ result: { data: { json: { success: true, deduped: false } } } });
    const r = await h.real.callReceiveWebDesignProject({ orderNo: "WD202611120001" });
    expect(r).toEqual({ projectNo: null, deduped: false, error: "WMS 回應缺少專案編號" });
  });

  it("安全閘：success:true 但 projectNo 係 null → 同樣「WMS 回應缺少專案編號」", async () => {
    stubFetch({ result: { data: { json: { success: true, projectNo: null } } } });
    const r = await h.real.callReceiveWebDesignProject({ orderNo: "WD202611120001" });
    expect(r.error).toBe("WMS 回應缺少專案編號");
    expect(r.projectNo).toBeNull();
  });

  it("安全閘：success:true 但 projectNo 空串／純空白 → 都係「WMS 回應缺少專案編號」", async () => {
    stubFetch({ result: { data: { json: { success: true, projectNo: "" } } } });
    const r1 = await h.real.callReceiveWebDesignProject({});
    expect(r1.error).toBe("WMS 回應缺少專案編號");
    expect(r1.projectNo).toBeNull();
    vi.unstubAllGlobals();
    stubFetch({ result: { data: { json: { success: true, projectNo: "   " } } } });
    const r2 = await h.real.callReceiveWebDesignProject({});
    expect(r2.error).toBe("WMS 回應缺少專案編號");
    expect(r2.projectNo).toBeNull();
  });

  it("projectNo 頭尾空白：trim 後回成功（deduped 照舊解析）", async () => {
    stubFetch({ result: { data: { json: { success: true, deduped: true, projectNo: "  WD202611120001  " } } } });
    const r = await h.real.callReceiveWebDesignProject({ orderNo: "WD202611120001" });
    expect(r).toEqual({ projectNo: "WD202611120001", deduped: true, error: null });
  });

  it("tRPC error.json.message 如實解析（例如舊單 CONFLICT）", async () => {
    stubFetch({ error: { json: { message: "CONFLICT：舊 webhookOrders 已有 WD202611120001" } } }, 409);
    const r = await h.real.callReceiveWebDesignProject({ orderNo: "WD202611120001" });
    expect(r.error).toBe("CONFLICT：舊 webhookOrders 已有 WD202611120001");
    expect(r.projectNo).toBeNull();
  });

  it("success 唔係 true → 用 result message；乜都冇 → HTTP 碼", async () => {
    stubFetch({ result: { data: { json: { success: false, message: "WMS 內部錯誤" } } } });
    const r1 = await h.real.callReceiveWebDesignProject({});
    expect(r1.error).toBe("WMS 內部錯誤");
    vi.unstubAllGlobals();
    stubFetch({ result: { data: { json: {} } } }, 500);
    const r2 = await h.real.callReceiveWebDesignProject({});
    expect(r2.error).toBe("HTTP 500");
  });

  it("network error never-throw：fetch reject → error 字串", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("socket hangup");
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await h.real.callReceiveWebDesignProject({ orderNo: "WD202611120001" });
    expect(r.error).toBe("socket hangup");
  });

  it("abort（90s timeout）→ 'timeout 90s'，唔會 throw", async () => {
    const fetchMock = vi.fn(async () => {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      throw e;
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await h.real.callReceiveWebDesignProject({ orderNo: "WD202611120001" });
    expect(r.error).toBe("timeout 90s");
  });
});

// ───────────────────────── ⑤ 舊路不變（普通商品 regression guard）─────────────────────────

describe("callReceiveWebhook 舊路不變（普通商品照舊）", () => {
  it("仍然 POST /api/trpc/order.receiveWebhook，解析 webhookOrderId", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({ result: { data: { json: { success: true, webhookOrderId: 4321 } } } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await h.real.callReceiveWebhook({ customerName: "陳大文", sourceRef: "RC20261112001" });
    expect(r).toEqual({ webhookOrderId: 4321, error: null });
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toBe("https://wms.test/api/trpc/order.receiveWebhook");
    const sent = JSON.parse(init.body);
    expect(sent.json.apiKey).toBe("test-wms-key");
    expect(sent.json.sourceRef).toBe("RC20261112001");
  });
});

// ───────────────────────── ⑥ 舊 WD callbacks 兼容 ─────────────────────────

describe("舊 webDesign callbacks 保留（歷史單不受影響）", () => {
  it("review approved → in_production＋paid，補 paidAt；pending 截圖跟住 approved", async () => {
    h.state.orderRow = { ...WD_ORDER, status: "received", paymentStatus: "review", paidAt: null };
    h.state.proofRows = [{ id: 9, orderId: 5, status: "pending" }];
    h.state.queue = [
      [], // update orders
      [], // update proof
    ];
    const { c } = fakeCtx();
    const r: any = await webDesignReviewCallback(c, {
      orderNo: WD_ORDER.orderNo,
      decision: "approved",
      rejectType: "cancel",
      note: "",
    });
    expect(r.body).toMatchObject({ ok: true, status: "in_production", paymentStatus: "paid" });
    const orderUpd = h.state.updates.find((u) => u.table === webDesignOrders);
    expect(orderUpd?.set.status).toBe("in_production");
    expect(orderUpd?.set.paymentStatus).toBe("paid");
    expect(orderUpd?.set.paidAt).toBeInstanceOf(Date); // WMS 批＝付款確認，補 paidAt
    const proofUpd = h.state.updates.find((u) => u.table === webDesignPaymentProofs);
    expect(proofUpd?.set.status).toBe("approved");
  });

  it("review rejected＋reupload → payment rejected（訂單狀態留 received）", async () => {
    h.state.orderRow = { ...WD_ORDER, status: "received", paymentStatus: "review", paidAt: null };
    h.state.proofRows = [{ id: 9, orderId: 5, status: "pending" }];
    h.state.queue = [[], []];
    const { c } = fakeCtx();
    const r: any = await webDesignReviewCallback(c, {
      orderNo: WD_ORDER.orderNo,
      decision: "rejected",
      rejectType: "reupload",
      note: "截圖唔清",
    });
    expect(r.body).toMatchObject({ ok: true, status: "received", paymentStatus: "rejected" });
    const orderUpd = h.state.updates.find((u) => u.table === webDesignOrders);
    expect(orderUpd?.set.paymentStatus).toBe("rejected");
    expect(orderUpd?.set.status).toBe("received");
    const proofUpd = h.state.updates.find((u) => u.table === webDesignPaymentProofs);
    expect(proofUpd?.set.reviewNote).toBe("截圖唔清");
  });

  it("review 終態冪等：completed 訂單再收 approved → already:true，零 DB 寫入", async () => {
    h.state.orderRow = { ...WD_ORDER, status: "completed", completedAt: new Date() };
    const { c } = fakeCtx();
    const r: any = await webDesignReviewCallback(c, {
      orderNo: WD_ORDER.orderNo,
      decision: "approved",
      rejectType: "cancel",
      note: "",
    });
    expect(r.body).toMatchObject({ ok: true, already: true, status: "completed" });
    expect(h.state.updates).toHaveLength(0);
  });

  it("review 搵唔到訂單 → 404", async () => {
    h.state.orderRow = undefined;
    const { c } = fakeCtx();
    const r: any = await webDesignReviewCallback(c, {
      orderNo: "WD202611129999",
      decision: "approved",
      rejectType: "cancel",
      note: "",
    });
    expect(r.status).toBe(404);
    expect(r.body.ok).toBe(false);
  });

  it("shipment shipped → completed＋completedAt（舊交付回調照常）", async () => {
    h.state.orderRow = { ...WD_ORDER, status: "in_production", paymentStatus: "paid" };
    h.state.queue = [[]];
    const { c } = fakeCtx();
    const r: any = await webDesignShipmentCallback(c, {
      orderNo: WD_ORDER.orderNo,
      action: "shipped",
      actorName: "WMS同事",
    });
    expect(r.body).toMatchObject({ ok: true, status: "completed" });
    const upd = h.state.updates.find((u) => u.table === webDesignOrders);
    expect(upd?.set.status).toBe("completed");
    expect(upd?.set.completedAt).toBeInstanceOf(Date);
  });
});
