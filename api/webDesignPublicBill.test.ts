/**
 * SPEC §9 官網公開單據 gateway 測試——全部 mock upstream fetch，唔連真 WMS／DB。
 * 覆蓋：allowlist、zod 嚴格 input、無 cookie/auth forwarding、10s timeout、
 * upstream error sanitization（唔洩 WMS base/stack/secrets）、no-store、
 * per-IP+token rate limit、route token 權威、returnUrl 同源同單據、confirmAndPay 錯誤白名單。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  webDesignPublicBillRouter,
  sanitizePublicBill,
  sanitizeConfirmResult,
  sanitizePayErrorMessage,
  resolveOnlineUrl,
  returnUrlMatchesBill,
  webDesignPublicBillOnlineUrl,
  PUBLIC_BILL_TOKEN_RE,
} from "./webDesignPublicBill";

const WMS_BASE = "https://wms-internal.example"; // 假 WMS 內部域名——測試佢唔會漏出
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345"; // 32 字 base64url
const TOKEN_B = "ZYXWvUtSrQpOnMlKjIhGfEdCbA987654";

/** 每個 caller 用獨立 IP，避免 module 級 RateLimiter 喺成個測試檔互相撞限 */
let ipSeq = 0;
function caller(ip?: string) {
  ipSeq += 1;
  const resHeaders = new Headers();
  const c = webDesignPublicBillRouter.createCaller({
    req: new Request("https://redcode.red/api/trpc", {
      headers: {
        "x-forwarded-for": ip ?? `10.8.8.${ipSeq}`,
        // 真係帶敏感 Cookie/Authorization 落官網（L2：斷言 upstream 絕對唔會收到佢哋，唔係齋靠「冇帶」）
        cookie: "rc_session=super-secret-session; rc_csrf=super-secret-csrf",
        authorization: "Bearer super-secret-jwt",
      },
    }),
    resHeaders,
  });
  return { caller: c, resHeaders };
}

function trpcOk(data: unknown): Response {
  return new Response(JSON.stringify({ result: { data: { json: data } } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function trpcErr(code: string, httpStatus: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: { json: { message, code: -1, data: { code, httpStatus } } } }),
    { status: httpStatus, headers: { "Content-Type": "application/json" } },
  );
}

const UPSTREAM_BILL = {
  billNo: "WDB-2026-11-0001",
  period: "2026-11",
  projectTitle: "陳記網站",
  customerName: "陳大文",
  items: [{ name: "網站月費", qty: 1, unitPriceCents: 98000, amountCents: 98000 }],
  subtotalCents: 98000,
  adjustCents: 0,
  adjustLog: [],
  finalCents: 98000,
  status: "issued",
  mode: "live",
  orderDate: "2026-11-01",
  sessionNo: null,
  remark: null,
  createdAt: "2026-11-01T03:00:00.000Z",
  paidAt: null,
  paymentMethod: null,
  customerPaidCents: null,
  refundedAt: null,
  refundedCents: 0,
  refundStatus: null,
  companyName: "RedCode HK直播台",
  surchargeOn: true,
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  process.env.WMS_BASE_URL = WMS_BASE;
  delete process.env.PUBLIC_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("官網公開單據 gateway — getPublic", () => {
  it("成功：白名單欄位輸出、onlineUrl 用官網 canonical、no-store", async () => {
    fetchMock.mockResolvedValueOnce(trpcOk({ ...UPSTREAM_BILL, feeCents: 1234, netCents: 90000, operator: "staffA" }));
    const { caller: c, resHeaders } = caller();
    const bill = await c.getPublic({ token: TOKEN });
    expect(bill.billNo).toBe("WDB-2026-11-0001");
    expect(bill.finalCents).toBe(98000);
    // 內部欄位唔准出現
    expect(bill).not.toHaveProperty("feeCents");
    expect(bill).not.toHaveProperty("netCents");
    expect(bill).not.toHaveProperty("operator");
    // SPEC §9：onlineUrl 永遠係官網 canonical（route token 權威）
    expect(bill.onlineUrl).toBe(`https://redcode.red/web-design-bill/${TOKEN}`);
    expect(bill.publicToken).toBe(TOKEN);
    expect(bill.kind).toBe("monthly"); // 舊上游未返 kind → default monthly
    expect(resHeaders.get("Cache-Control")).toBe("no-store");
    // upstream call：GET 正確 path＋input；唔 forward cookies/authorization；有 request id
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith(`${WMS_BASE}/api/trpc/webDesignBilling.getPublic?input=`)).toBe(true);
    expect(decodeURIComponent(url.split("input=")[1])).toBe(JSON.stringify({ json: { token: TOKEN } }));
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(typeof headers["x-request-id"]).toBe("string");
    // L2：incoming request 真係帶咗 Cookie/Authorization（見 caller()），upstream captured headers 絕無佢哋
    expect(headers["cookie"]).toBeUndefined();
    expect(headers["Cookie"]).toBeUndefined();
    expect(headers["authorization"]).toBeUndefined();
    expect(headers["Authorization"]).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain("super-secret");
  });

  it("上游 adjustLog 漏咗操作員 `by`／notes 漏 `updatedBy`：輸出再剥一次", async () => {
    fetchMock.mockResolvedValueOnce(
      trpcOk({
        ...UPSTREAM_BILL,
        kind: "project",
        publicToken: TOKEN,
        adjustLog: [{ deltaCents: -5000, reason: " goodwill", by: "staffA", at: "2026-11-02T00:00:00Z" }],
        notes: [{ id: "n1", text: "加整會員系統", updatedAt: "2026-11-01T08:00:00Z", updatedBy: "staffA" }],
      }),
    );
    const { caller: c } = caller();
    const bill = await c.getPublic({ token: TOKEN });
    expect(bill.kind).toBe("project");
    expect(JSON.stringify(bill.adjustLog)).not.toContain("staffA");
    expect(JSON.stringify(bill.notes)).not.toContain("staffA");
    expect(bill.notes).toEqual([{ id: "n1", text: "加整會員系統", updatedAt: "2026-11-01T08:00:00Z" }]);
  });

  it("invalid token（唔係 32 字 base64url）：BAD_REQUEST，upstream fetch 0 次，回應一樣 no-store", async () => {
    const { caller: c, resHeaders } = caller();
    await expect(c.getPublic({ token: "short" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(c.getPublic({ token: `${TOKEN}#` })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
    // L1：BAD_REQUEST（input 驗證階段已擋）都要有 no-store
    expect(resHeaders.get("Cache-Control")).toBe("no-store");
  });

  it("上游 NOT_FOUND → 安全訊息「單據不存在或連結已失效」，回應一樣 no-store", async () => {
    fetchMock.mockResolvedValueOnce(trpcErr("NOT_FOUND", 404, "單據不存在或連結已失效"));
    const { caller: c, resHeaders } = caller();
    await expect(c.getPublic({ token: TOKEN })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "單據不存在或連結已失效",
    });
    expect(resHeaders.get("Cache-Control")).toBe("no-store");
  });

  it("上游 500／內部錯誤 body → sanitize，唔洩 WMS base／stack／body，回應一樣 no-store", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(`Internal crash at ${WMS_BASE}/api/trpc\nError: pg connect ECONNREFUSED db.internal:5432`, {
        status: 500,
      }),
    );
    const { caller: c, resHeaders } = caller();
    const err = (await c.getPublic({ token: TOKEN }).catch((e) => e)) as TRPCError;
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.message).not.toContain("wms-internal.example");
    expect(err.message).not.toContain("ECONNREFUSED");
    expect(err.message).not.toContain("db.internal");
    expect(err.message).toBe("暫時未能連接單據系統，請稍後再試");
    expect(resHeaders.get("Cache-Control")).toBe("no-store");
  });

  it("上游 tRPC error（非 NOT_FOUND）→ sanitize，唔洩 upstream message", async () => {
    fetchMock.mockResolvedValueOnce(trpcErr("INTERNAL_SERVER_ERROR", 500, `pg boom at ${WMS_BASE}`));
    const { caller: c } = caller();
    const err = (await c.getPublic({ token: TOKEN }).catch((e) => e)) as TRPCError;
    expect(err.message).toBe("暫時未能連接單據系統，請稍後再試");
  });

  it("上游 10s timeout → 安全逾時訊息", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    );
    const { caller: c } = caller();
    const p = c.getPublic({ token: TOKEN });
    const assertion = expect(p).rejects.toMatchObject({ message: "單據系統回應逾時，請稍後再試" });
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
  });

  it("上游 publicToken 同 route token 唔一致 → 拒絕（唔准改用另一張單嘅 token）", async () => {
    fetchMock.mockResolvedValueOnce(trpcOk({ ...UPSTREAM_BILL, publicToken: TOKEN_B }));
    const { caller: c } = caller();
    const err = (await c.getPublic({ token: TOKEN }).catch((e) => e)) as TRPCError;
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.message).toBe("暫時未能連接單據系統，請稍後再試");
  });

  it("上游 onlineUrl 指向 evil.example → 唔信 upstream origin，輸出仍係 redcode.red canonical", async () => {
    fetchMock.mockResolvedValueOnce(
      trpcOk({ ...UPSTREAM_BILL, publicToken: TOKEN, onlineUrl: `https://evil.example/web-design-bill/${TOKEN}` }),
    );
    const { caller: c } = caller();
    const bill = await c.getPublic({ token: TOKEN });
    expect(bill.onlineUrl).toBe(`https://redcode.red/web-design-bill/${TOKEN}`);
    expect(JSON.stringify(bill)).not.toContain("evil.example");
    expect(JSON.stringify(bill)).not.toContain("wms-internal.example");
  });

  it("rate limit：同一 IP+token 第 21 次 getPublic → TOO_MANY_REQUESTS，upstream 唔再被打，429 都 no-store", async () => {
    // 每次新 Response（mockResolvedValue 重用同一 Response 會 body consumed）
    fetchMock.mockImplementation(() => Promise.resolve(trpcOk(UPSTREAM_BILL)));
    const { caller: c, resHeaders } = caller("9.9.9.1");
    for (let i = 0; i < 20; i += 1) {
      await c.getPublic({ token: TOKEN });
    }
    await expect(c.getPublic({ token: TOKEN })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(fetchMock).toHaveBeenCalledTimes(20);
    // L1：429 都要有 no-store
    expect(resHeaders.get("Cache-Control")).toBe("no-store");
  });

  it("router 只得 getPublic／confirmAndPay 兩個 procedure（allowlist 無其他路去 WMS）", () => {
    expect(Object.keys(webDesignPublicBillRouter._def.procedures).sort()).toEqual(["confirmAndPay", "getPublic"]);
  });
});

describe("官網公開單據 gateway — confirmAndPay", () => {
  const GOOD_RETURN_URL = `https://redcode.red/web-design-bill/${TOKEN}`;

  it("成功：轉發 {token, returnUrl}；輸出 intentId/clientSecret/env；no-store", async () => {
    fetchMock.mockResolvedValueOnce(
      trpcOk({ ok: true, intentId: "int_123", clientSecret: "secret_abc", env: "prod" }),
    );
    const { caller: c, resHeaders } = caller();
    const res = await c.confirmAndPay({ token: TOKEN, returnUrl: GOOD_RETURN_URL });
    expect(res).toEqual({ ok: true, intentId: "int_123", clientSecret: "secret_abc", env: "prod" });
    expect(resHeaders.get("Cache-Control")).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${WMS_BASE}/api/trpc/webDesignBilling.confirmAndPay`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ json: { token: TOKEN, returnUrl: GOOD_RETURN_URL } });
    const headers = init.headers as Record<string, string>;
    // L2：incoming request 帶咗真 Cookie/Authorization（見 caller()），upstream 絕無轉發
    expect(headers["cookie"]).toBeUndefined();
    expect(headers["authorization"]).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain("super-secret");
  });

  it("returnUrl 帶 query（Airwallex 回跳狀態）照過", async () => {
    fetchMock.mockResolvedValueOnce(trpcOk({ ok: false, error: "單據已付款，多謝支持" }));
    const { caller: c } = caller();
    const res = await c.confirmAndPay({ token: TOKEN, returnUrl: `${GOOD_RETURN_URL}?paid=1` });
    expect(res).toEqual({ ok: false, error: "單據已付款，多謝支持" });
  });

  it("外部 origin returnUrl → BAD_REQUEST，upstream fetch 0 次，回應一樣 no-store", async () => {
    const { caller: c, resHeaders } = caller();
    await expect(
      c.confirmAndPay({ token: TOKEN, returnUrl: `https://evil.example/web-design-bill/${TOKEN}` }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resHeaders.get("Cache-Control")).toBe("no-store");
  });

  it("M1：上游返 legacy url/redirectUrl（包括 evil https host）→ 完全 strip，唔到前端；intent flow 照行", async () => {
    fetchMock.mockResolvedValueOnce(
      trpcOk({
        ok: true,
        intentId: "int_123",
        clientSecret: "secret_abc",
        env: "prod",
        url: "https://evil.example/capture",
        redirectUrl: "https://evil.example/phish",
      }),
    );
    const { caller: c } = caller();
    const res = await c.confirmAndPay({ token: TOKEN, returnUrl: GOOD_RETURN_URL });
    // 完整 Airwallex HPP intent flow 保留
    expect(res).toEqual({ ok: true, intentId: "int_123", clientSecret: "secret_abc", env: "prod" });
    expect(res).not.toHaveProperty("url");
    expect(res).not.toHaveProperty("redirectUrl");
    expect(JSON.stringify(res)).not.toContain("evil.example");
  });

  it("官網 origin 但 path 唔係同一張單 → BAD_REQUEST，upstream fetch 0 次", async () => {
    const { caller: c } = caller();
    await expect(
      c.confirmAndPay({ token: TOKEN, returnUrl: `https://redcode.red/web-design-bill/${TOKEN_B}` }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      c.confirmAndPay({ token: TOKEN, returnUrl: "https://redcode.red/" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("javascript: 偽協議 returnUrl → BAD_REQUEST，upstream fetch 0 次", async () => {
    const { caller: c } = caller();
    await expect(
      c.confirmAndPay({ token: TOKEN, returnUrl: "javascript:alert(1)" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("上游 {ok:false} 已知安全訊息 → 原樣傳", async () => {
    fetchMock.mockResolvedValueOnce(
      trpcOk({ ok: false, error: "暫時未能核實上一筆付款狀態，請稍後再試；系統冇建立新付款" }),
    );
    const { caller: c } = caller();
    const res = await c.confirmAndPay({ token: TOKEN, returnUrl: GOOD_RETURN_URL });
    expect(res).toEqual({ ok: false, error: "暫時未能核實上一筆付款狀態，請稍後再試；系統冇建立新付款" });
  });

  it("上游 {ok:false,error} 含內部 URL/stack → 統一安全訊息，唔含內部域名", async () => {
    fetchMock.mockResolvedValueOnce(
      trpcOk({
        ok: false,
        error: `Request failed: https://wms-internal.example/api/trpc/x\n    at fetch (${WMS_BASE}:12:3)`,
      }),
    );
    const { caller: c } = caller();
    const res = await c.confirmAndPay({ token: TOKEN, returnUrl: GOOD_RETURN_URL });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain("wms-internal.example");
    expect(JSON.stringify(res)).not.toContain("at fetch");
    expect((res as { error: string }).error).toBe("暫時未能發起付款，請稍後再試");
  });

  it("上游 transport 失敗 → sanitize 通用訊息（唔洩 base）", async () => {
    fetchMock.mockRejectedValueOnce(new Error(`connect ECONNREFUSED wms-internal.example:443`));
    const { caller: c } = caller();
    const err = (await c.confirmAndPay({ token: TOKEN, returnUrl: GOOD_RETURN_URL }).catch((e) => e)) as TRPCError;
    expect(err.message).not.toContain("wms-internal.example");
    expect(err.message).toBe("暫時未能連接單據系統，請稍後再試");
  });

  it("rate limit：同一 IP+token 第 9 次 confirmAndPay → TOO_MANY_REQUESTS，upstream 唔再被打，429 都 no-store", async () => {
    // 每次新 Response（mockResolvedValue 重用同一 Response 會 body consumed）
    fetchMock.mockImplementation(() => Promise.resolve(trpcOk({ ok: false, error: "單據已付款，多謝支持" })));
    const { caller: c, resHeaders } = caller("9.9.9.2");
    for (let i = 0; i < 8; i += 1) {
      await c.confirmAndPay({ token: TOKEN, returnUrl: GOOD_RETURN_URL });
    }
    await expect(
      c.confirmAndPay({ token: TOKEN, returnUrl: GOOD_RETURN_URL }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(resHeaders.get("Cache-Control")).toBe("no-store");
  });
});

describe("純函數", () => {
  it("PUBLIC_BILL_TOKEN_RE：32 字 base64url 先過", () => {
    expect(PUBLIC_BILL_TOKEN_RE.test(TOKEN)).toBe(true);
    expect(PUBLIC_BILL_TOKEN_RE.test(TOKEN.slice(1))).toBe(false);
    expect(PUBLIC_BILL_TOKEN_RE.test(`${TOKEN}+`)).toBe(false);
    expect(PUBLIC_BILL_TOKEN_RE.test(`${TOKEN.slice(0, 31)}=`)).toBe(false);
  });

  it("webDesignPublicBillOnlineUrl：default redcode.red；invalid base config 要 loud", () => {
    expect(webDesignPublicBillOnlineUrl(TOKEN)).toBe(`https://redcode.red/web-design-bill/${TOKEN}`);
    process.env.PUBLIC_BASE_URL = "http://insecure.example";
    expect(() => webDesignPublicBillOnlineUrl(TOKEN)).toThrow();
    process.env.PUBLIC_BASE_URL = "https://user:pass@redcode.red";
    expect(() => webDesignPublicBillOnlineUrl(TOKEN)).toThrow();
    process.env.PUBLIC_BASE_URL = "https://redcode.red/?x=1";
    expect(() => webDesignPublicBillOnlineUrl(TOKEN)).toThrow();
    process.env.PUBLIC_BASE_URL = "https://staging.redcode.red/";
    expect(webDesignPublicBillOnlineUrl(TOKEN)).toBe(`https://staging.redcode.red/web-design-bill/${TOKEN}`);
    delete process.env.PUBLIC_BASE_URL;
    expect(() => webDesignPublicBillOnlineUrl("bad")).toThrow();
  });

  it("resolveOnlineUrl：永遠重砌 canonical；upstream 值唔會改變輸出", () => {
    const canonical = `https://redcode.red/web-design-bill/${TOKEN}`;
    expect(resolveOnlineUrl(undefined, TOKEN)).toBe(canonical);
    expect(resolveOnlineUrl(canonical, TOKEN)).toBe(canonical);
    expect(resolveOnlineUrl(`https://evil.example/web-design-bill/${TOKEN}`, TOKEN)).toBe(canonical);
    expect(resolveOnlineUrl(`https://wms-internal.example/web-design-bill/${TOKEN}`, TOKEN)).toBe(canonical);
  });

  it("sanitizePublicBill：route token 權威；缺欄補返；錯形即拒", () => {
    const bill = sanitizePublicBill({ ...UPSTREAM_BILL }, TOKEN);
    expect(bill.onlineUrl).toBe(`https://redcode.red/web-design-bill/${TOKEN}`);
    expect(bill.publicToken).toBe(TOKEN);
    expect(bill.kind).toBe("monthly");
    expect(() => sanitizePublicBill({ finalCents: "not-a-number" }, TOKEN)).toThrow(TRPCError);
    expect(() => sanitizePublicBill({ ...UPSTREAM_BILL, publicToken: TOKEN_B }, TOKEN)).toThrow(TRPCError);
  });

  it("returnUrlMatchesBill：官方 origin＋同單據 path 先過；query 可留", () => {
    expect(returnUrlMatchesBill(`https://redcode.red/web-design-bill/${TOKEN}`, TOKEN)).toBe(true);
    expect(returnUrlMatchesBill(`https://redcode.red/web-design-bill/${TOKEN}?a=1`, TOKEN)).toBe(true);
    expect(returnUrlMatchesBill(`https://evil.example/web-design-bill/${TOKEN}`, TOKEN)).toBe(false);
    expect(returnUrlMatchesBill(`https://redcode.red/web-design-bill/${TOKEN_B}`, TOKEN)).toBe(false);
    expect(returnUrlMatchesBill("https://redcode.red/", TOKEN)).toBe(false);
    expect(returnUrlMatchesBill("not a url", TOKEN)).toBe(false);
  });

  it("sanitizePayErrorMessage：白名單外嘅訊息一律換安全通用句", () => {
    expect(sanitizePayErrorMessage("單據已付款，多謝支持")).toBe("單據已付款，多謝支持");
    expect(sanitizePayErrorMessage(`https://wms-internal.example/x\nstack`)).toBe("暫時未能發起付款，請稍後再試");
    expect(sanitizePayErrorMessage(undefined)).toBe("暫時未能發起付款，請稍後再試");
  });

  it("sanitizeConfirmResult：ok 缺 intent/clientSecret 即拒；legacy url/redirectUrl 永遠 strip（唔准只驗 javascript:）", () => {
    expect(() => sanitizeConfirmResult({ ok: true })).toThrow(TRPCError);
    // evil https host 都要 strip——唔係齋擋 javascript: 偽協議
    const cleaned = sanitizeConfirmResult({
      ok: true,
      intentId: "i",
      clientSecret: "s",
      url: "https://evil.example/capture",
      redirectUrl: "https://evil.example/phish",
    });
    expect(cleaned).not.toHaveProperty("url");
    expect(cleaned).not.toHaveProperty("redirectUrl");
    expect(cleaned).toEqual({ ok: true, intentId: "i", clientSecret: "s" });
    const cleanedJs = sanitizeConfirmResult({ ok: true, intentId: "i", clientSecret: "s", url: "javascript:alert(1)" });
    expect(cleanedJs).not.toHaveProperty("url");
    expect(sanitizeConfirmResult({ ok: false, error: "單據已退款", redirectUrl: "https://evil.example/x" })).toEqual({
      ok: false,
      error: "單據已退款",
    });
  });
});
