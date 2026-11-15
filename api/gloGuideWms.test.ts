/**
 * Glo Glo WMS 內部端點測試（唔掂 DB／network）：
 * ─ secretEquals 常數時間 secret 閘（未設 503／錯 401／非 JSON 400）；
 * ─ actor 白名單；approve/reject staff → 403，supervisor/admin 通過；
 * ─ dispatch 權限矩陣＋錯誤映射（GloGuideError → {ok:false,error,code}＋HTTP status）；
 * ─ 全部 action 經 mock service 逐個覆核（冇 mock 成功——mock 淨係替身，斷言呼叫參數）。
 */
import { describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

// audit 唔掂真 DB（錯誤路徑會 logAudit；mock 咗佢測試唔會嘗試連線）
vi.mock("./audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { dispatchGloGuideAction, wmsGloGuide, type GloGuideDispatchDeps } from "./gloGuideWms";
import { GloGuideError } from "./gloGuideService";
import type { GloGuideActor } from "./gloGuideValidation";

// ── mock service：逐個 action 記低呼叫，回標記值 ──────────────────────────
function mockDeps() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const rec = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve({ fn });
  };
  const deps: GloGuideDispatchDeps = {
    service: {
      listWeeklyProducts: rec("listWeeklyProducts"),
      listArticleSummaries: rec("listArticleSummaries"),
      getArticleBundle: rec("getArticleBundle"),
      toInternalArticle: rec("toInternalArticle"),
      generateArticle: rec("generateArticle"),
      regenerateArticle: rec("regenerateArticle"),
      updateArticle: rec("updateArticle"),
      submitArticle: rec("submitArticle"),
      approveArticle: rec("approveArticle"),
      rejectArticle: rec("rejectArticle"),
      archiveArticle: rec("archiveArticle"),
      reviewImage: rec("reviewImage"),
      deleteImage: rec("deleteImage"),
      uploadImage: rec("uploadImage"),
      generateImages: rec("generateImages"),
      readImageForPreview: rec("readImageForPreview"),
    } as unknown as GloGuideDispatchDeps["service"],
    providers: {
      getWeather: vi.fn(),
      generateText: vi.fn(),
      generateImage: vi.fn(),
      resumeImage: vi.fn(),
      saveUpload: vi.fn(),
    },
  };
  return { deps, calls };
}

const staff: GloGuideActor = { id: 11, name: "小明", role: "staff" };
const supervisor: GloGuideActor = { id: 7, name: "主管", role: "supervisor" };
const admin: GloGuideActor = { id: 1, name: "老闆", role: "admin" };

describe("dispatch 權限矩陣", () => {
  it("staff 可以 generate/update/submit/image.*，但 approve/reject/archive → 403", async () => {
    const { deps, calls } = mockDeps();
    await dispatchGloGuideAction(staff, "article.generate", { productIds: [1, 2] }, deps);
    await dispatchGloGuideAction(staff, "article.submit", { id: 3 }, deps);
    await dispatchGloGuideAction(staff, "image.review", { id: 3, imageId: 9, decision: "approved" }, deps);
    await dispatchGloGuideAction(staff, "image.read", { id: 3, imageId: 9 }, deps);
    expect(calls.map((c) => c.fn)).toEqual(["generateArticle", "submitArticle", "reviewImage", "readImageForPreview"]);
    for (const action of ["article.approve", "article.reject", "article.archive"] as const) {
      await expect(
        dispatchGloGuideAction(staff, action, { id: 3, reason: "x" }, deps),
      ).rejects.toMatchObject({ httpStatus: 403, code: "FORBIDDEN" });
    }
  });
  it("supervisor／admin 可以 approve/reject/archive；WMS 內建管理員（id=0, admin）都可以", async () => {
    const { deps, calls } = mockDeps();
    await dispatchGloGuideAction(supervisor, "article.approve", { id: 3 }, deps);
    await dispatchGloGuideAction(admin, "article.reject", { id: 3, reason: "唔啱" }, deps);
    await dispatchGloGuideAction({ id: 0, name: "內建管理員", role: "admin" }, "article.archive", { id: 3 }, deps);
    await dispatchGloGuideAction({ id: 0, name: "內建管理員", role: "admin" }, "article.approve", { id: 4 }, deps);
    await dispatchGloGuideAction({ id: 0, name: "內建管理員", role: "admin" }, "article.reject", { id: 4, reason: "x" }, deps);
    expect(calls.map((c) => c.fn)).toEqual(["approveArticle", "rejectArticle", "archiveArticle", "approveArticle", "rejectArticle"]);
  });
  it("payload 校驗：缺 id／壞 productIds／壞 decision → 400", async () => {
    const { deps } = mockDeps();
    await expect(dispatchGloGuideAction(staff, "article.get", {}, deps)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(
      dispatchGloGuideAction(staff, "article.generate", { productIds: ["a"] }, deps),
    ).rejects.toMatchObject({ httpStatus: 400 });
    await expect(
      dispatchGloGuideAction(staff, "image.review", { id: 1, imageId: 2, decision: "maybe" }, deps),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });
  it("service 錯誤原樣透傳（真 JSON error，唔准包成成功）", async () => {
    const { deps } = mockDeps();
    deps.service.getArticleBundle = vi.fn().mockRejectedValue(new GloGuideError(404, "NOT_FOUND", "搵唔到呢篇指南")) as never;
    await expect(dispatchGloGuideAction(staff, "article.get", { id: 99 }, deps)).rejects.toMatchObject({
      httpStatus: 404,
      code: "NOT_FOUND",
    });
  });
});

// ── handler 層（secret／actor／回應形狀）──────────────────────────────
function fakeContext(body: unknown): Context {
  return {
    req: {
      json: () => (body instanceof Error ? Promise.reject(new Error("bad json")) : Promise.resolve(body)),
    },
    json: (data: unknown, status?: number) =>
      new Response(JSON.stringify(data), { status: status ?? 200, headers: { "Content-Type": "application/json" } }),
  } as unknown as Context;
}

describe("wmsGloGuide handler", () => {
  it("未設 WMS_CALLBACK_SECRET → 503", async () => {
    delete process.env.WMS_CALLBACK_SECRET;
    const res = await wmsGloGuide(fakeContext({}));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });
  it("secret 錯 → 401；body 非 JSON → 400；actor 壞 → 400；action 壞 → 400", async () => {
    process.env.WMS_CALLBACK_SECRET = "s";
    expect((await wmsGloGuide(fakeContext({ secret: "wrong" }))).status).toBe(401);
    expect((await wmsGloGuide(fakeContext(new Error("x")))).status).toBe(400);
    expect(
      (await wmsGloGuide(fakeContext({ secret: "s", actor: { id: 1, name: "A", role: "member" }, action: "products.list" }))).status,
    ).toBe(400);
    expect(
      (await wmsGloGuide(fakeContext({ secret: "s", actor: { id: 1, name: "A", role: "staff" }, action: "hack" }))).status,
    ).toBe(400);
  });
  it("staff 經 HTTP 調 approve → 403 JSON", async () => {
    process.env.WMS_CALLBACK_SECRET = "test-secret-3";
    const res = await wmsGloGuide(
      fakeContext({
        secret: "test-secret-3",
        actor: { id: 1, name: "小明", role: "staff" },
        action: "article.approve",
        payload: { id: 3 },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; code?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("FORBIDDEN");
  });
});
