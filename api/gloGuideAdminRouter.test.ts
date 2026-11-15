/**
 * gloGuideAdminRouter 層測試——mock auth（JWT 身份）、mock DB（middleware role 覆核＋
 * router 員工名查詢）、mock gloGuideService（全部業務函數 vi.fn）。
 *
 * 覆蓋重點（SPEC 驗收硬閘）：
 * ─ 未登入 → UNAUTHORIZED；member → FORBIDDEN；
 * ─ staff 可以用查詢／生成／編輯／圖片生成・上傳・刪除／submit；
 * ─ **staff 越權 approve／reject／archive／逐圖審批（imageReview）必須 FORBIDDEN，而且 service 完全冇被調用**；
 * ─ supervisor approve 會用 server-side 砌嘅 actor（id＋DB 名＋DB role，唔信 client）；
 * ─ GloGuideError httpStatus → 正確 tRPC code（400/404/409/500）；
 * ─ zod 輸入閘（id 要正整數）喺 service 之前擋。
 *
 * ⚠️ 界限：DB 已 mock，service 內部 transaction／閘口邏輯唔喺度驗（嗰啲係 gloGuideService.test 範圍）。
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

// ───────────────────────── mock 基礎設施（hoisted）─────────────────────────
const h = vi.hoisted(() => {
  const state = {
    user: null as null | { userId: number; role: string },
    /** middleware 每 request 以 users PK 覆核嘅 role（預設跟 JWT role） */
    dbRole: null as string | null,
    /** actorFromAuthUser 以 PK 查返嘅員工名 */
    dbName: "陳小明",
  };
  function makeChain(result: unknown[]) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "limit", "orderBy", "groupBy"]) {
      chain[m] = () => (m === "limit" ? Promise.resolve(result) : chain);
    }
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    return chain;
  }
  const db = {
    select: (selection?: Record<string, unknown>) => {
      // middleware role 覆核：select({ role: users.role })
      if (selection && "role" in selection) {
        return makeChain(state.dbRole ? [{ role: state.dbRole }] : []);
      }
      // actor 名查詢：select({ name: users.name })
      if (selection && "name" in selection) {
        return makeChain(state.dbName ? [{ name: state.dbName }] : []);
      }
      return makeChain([]);
    },
  };
  // 帶參數簽名嘅 mock factory（避免 zero-arg tuple 型別錯；void args 防止 lint 未用參數）
  const fn = <T>(result: T) =>
    vi.fn(async (...args: unknown[]) => {
      void args;
      return result;
    });
  const service = {
    listWeeklyProducts: fn([] as unknown[]),
    listArticleSummaries: fn([] as unknown[]),
    getArticleBundle: fn(null as unknown),
    toInternalArticle: vi.fn((b: unknown) => b),
    generateArticle: fn({ id: 1 }),
    regenerateArticle: fn({ id: 1 }),
    updateArticle: fn({ id: 1 }),
    submitArticle: fn({ id: 1, status: "pending_review" }),
    approveArticle: fn({ id: 1, status: "published" }),
    rejectArticle: fn({ id: 1, status: "rejected" }),
    archiveArticle: fn({ id: 1, status: "archived" }),
    reviewImage: fn({ id: 1 }),
    deleteImage: fn({ id: 1 }),
    uploadImage: fn({ id: 1 }),
    generateImages: fn({ id: 1 }),
    readImageForPreview: fn({
      filename: "x.png",
      mime: "image/png",
      dataBase64: "AAAA",
    }),
    listModelImages: fn({
      items: [],
      maxCount: 8,
      fallback: { ref: "/gloglo-3.jpg" },
      effective: { ref: "/gloglo-3.jpg", source: "env" },
    } as unknown),
    uploadModelImage: fn({ items: [{ id: 1, isDefault: true }] } as unknown),
    setDefaultModelImage: fn({ items: [] } as unknown),
    deleteModelImage: fn({ items: [] } as unknown),
    readModelImageForPreview: fn({
      filename: "m.jpg",
      mime: "image/jpeg",
      dataBase64: "AAAA",
    }),
  };
  return { state, db, service };
});

vi.mock("./queries/connection", () => ({ getDb: () => h.db }));
vi.mock("./auth", () => ({
  userFromAuthHeader: vi.fn(async () => h.state.user),
  verifyToken: vi.fn(async () => h.state.user),
}));
vi.mock("./audit", () => ({ logAudit: vi.fn(async () => undefined) }));
// 保留真 GloGuideError class（router instanceof 要靠佢），業務函數全部換 mock
vi.mock("./gloGuideService", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./gloGuideService")>();
  return { ...mod, ...h.service };
});
vi.mock("./gloGuideProviders", () => ({
  defaultGloGuideProviders: vi.fn(() => ({ kind: "mock-providers" })),
}));

import { gloGuideAdminRouter } from "./gloGuideAdminRouter";
import { GloGuideError } from "./gloGuideService";

function caller() {
  return gloGuideAdminRouter.createCaller({
    req: new Request("http://test.local/api/trpc", {
      headers: { authorization: "Bearer test-token" },
    }),
    resHeaders: new Headers(),
  });
}

function reset(
  user: { userId: number; role: string } | null = { userId: 7, role: "staff" },
  dbRole?: string | null,
) {
  h.state.user = user;
  h.state.dbRole = dbRole === undefined ? (user?.role ?? null) : dbRole;
  h.state.dbName = "陳小明";
  vi.clearAllMocks();
}

/** 抽出 TRPCError code 斷言 */
async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code });
}

beforeEach(() => reset());

describe("權限閘（SPEC：staff 越權 approve 必須後端擋）", () => {
  it("未登入：UNAUTHORIZED", async () => {
    reset(null);
    await expectCode(caller().articles(), "UNAUTHORIZED");
    await expectCode(caller().approve({ id: 1 }), "UNAUTHORIZED");
  });

  it("member：查詢同操作都 FORBIDDEN", async () => {
    reset({ userId: 9, role: "member" });
    await expectCode(caller().articles(), "FORBIDDEN");
    await expectCode(caller().generate({ productIds: [1, 2] }), "FORBIDDEN");
    await expectCode(caller().approve({ id: 1 }), "FORBIDDEN");
  });

  it("staff 越權 approve：FORBIDDEN 兼 approveArticle 完全冇被調用", async () => {
    reset({ userId: 7, role: "staff" });
    await expectCode(caller().approve({ id: 1 }), "FORBIDDEN");
    expect(h.service.approveArticle).not.toHaveBeenCalled();
  });

  it("staff 越權 reject／archive：FORBIDDEN 兼 service 冇被調用", async () => {
    reset({ userId: 7, role: "staff" });
    await expectCode(caller().reject({ id: 1, reason: "唔得" }), "FORBIDDEN");
    await expectCode(caller().archive({ id: 1 }), "FORBIDDEN");
    expect(h.service.rejectArticle).not.toHaveBeenCalled();
    expect(h.service.archiveArticle).not.toHaveBeenCalled();
  });

  it("staff 越權逐圖審批（imageReview approve／reject）：FORBIDDEN 兼 service 冇被調用", async () => {
    reset({ userId: 7, role: "staff" });
    await expectCode(caller().imageReview({ id: 1, imageId: 9, decision: "approved" }), "FORBIDDEN");
    await expectCode(
      caller().imageReview({ id: 1, imageId: 9, decision: "rejected", note: "唔似" }),
      "FORBIDDEN",
    );
    expect(h.service.reviewImage).not.toHaveBeenCalled();
  });

  it("supervisor 逐圖審批落到 service（actor server-side 砌）", async () => {
    reset({ userId: 3, role: "supervisor" });
    h.state.dbName = "主管阿欣";
    await caller().imageReview({ id: 1, imageId: 9, decision: "approved" });
    expect(h.service.reviewImage).toHaveBeenCalledWith(
      { id: 3, name: "主管阿欣", role: "supervisor" },
      { id: 1, imageId: 9, decision: "approved", note: undefined },
    );
  });

  it("supervisor 可以 approve；actor 由 server 砌（id＋DB 名＋supervisor role）", async () => {
    reset({ userId: 3, role: "supervisor" });
    h.state.dbName = "主管阿欣";
    const out = await caller().approve({ id: 42 });
    expect(out).toMatchObject({ id: 1, status: "published" });
    expect(h.service.approveArticle).toHaveBeenCalledTimes(1);
    const [actor, id] = h.service.approveArticle.mock.calls[0]!;
    expect(actor).toEqual({ id: 3, name: "主管阿欣", role: "supervisor" });
    expect(id).toBe(42);
  });

  it("admin 可以 reject／archive", async () => {
    reset({ userId: 1, role: "admin" });
    await caller().reject({ id: 5, reason: "內容唔啱" });
    await caller().archive({ id: 5 });
    expect(h.service.rejectArticle).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, role: "admin" }),
      { id: 5, reason: "內容唔啱" },
    );
    expect(h.service.archiveArticle).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), 5);
  });

  it("JWT role 同 DB 覆核唔符（降職）→ FORBIDDEN", async () => {
    reset({ userId: 7, role: "supervisor" }, "staff");
    await expectCode(caller().approve({ id: 1 }), "FORBIDDEN");
    expect(h.service.approveArticle).not.toHaveBeenCalled();
  });
});

describe("staff 正常操作（全員可用）", () => {
  it("articles／weeklyProducts／article 查詢", async () => {
    h.service.listArticleSummaries.mockResolvedValueOnce([{ id: 1 }]);
    const list = await caller().articles({ status: "draft" });
    expect(list.items).toHaveLength(1);
    expect(h.service.listArticleSummaries).toHaveBeenCalledWith({ status: "draft" });
    await caller().weeklyProducts();
    expect(h.service.listWeeklyProducts).toHaveBeenCalled();

    const bundle = { article: { id: 2 }, links: [], images: [], jobs: [], currentProducts: new Map() };
    h.service.getArticleBundle.mockResolvedValueOnce(bundle);
    await caller().article({ id: 2 });
    expect(h.service.getArticleBundle).toHaveBeenCalledWith(2);
    expect(h.service.toInternalArticle).toHaveBeenCalledWith(bundle);
  });

  it("generate：actor name 嚟自 DB（唔信 client），input 根本冇 role/name 欄位", async () => {
    await caller().generate({ productIds: [11, 12], themeHint: "雨天" });
    const [actor, input] = h.service.generateArticle.mock.calls[0]!;
    expect(actor).toEqual({ id: 7, name: "陳小明", role: "staff" });
    expect(input).toEqual({ productIds: [11, 12], themeHint: "雨天" });
  });

  it("update／submit／regenerate／imageDelete／imageGenerate 都落到 service", async () => {
    await caller().update({ id: 1, title: "標題四個字", body: "內文", theme: "主題" });
    expect(h.service.updateArticle).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, role: "staff" }),
      { id: 1, title: "標題四個字", body: "內文", theme: "主題", productIds: undefined },
    );
    await caller().submit({ id: 1 });
    expect(h.service.submitArticle).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), 1);
    await caller().regenerate({ id: 1 });
    expect(h.service.regenerateArticle).toHaveBeenCalled();
    await caller().imageDelete({ id: 1, imageId: 9 });
    expect(h.service.deleteImage).toHaveBeenCalled();
    await caller().imageGenerate({ id: 1, imageId: 9 });
    expect(h.service.generateImages).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      { id: 1, imageId: 9, productId: undefined },
    );
  });

  it("imageUpload 注入 providers；imageRead 回 base64 預覽", async () => {
    await caller().imageUpload({
      id: 1,
      productId: 2,
      filename: "a.png",
      mime: "image/png",
      dataBase64: "QUJD",
    });
    const up = h.service.uploadImage.mock.calls[0]!;
    expect(up[1]).toMatchObject({ id: 1, productId: 2, dataBase64: "QUJD" });
    expect(up[2]).toEqual({ kind: "mock-providers" });

    const preview = await caller().imageRead({ id: 1, imageId: 9 });
    expect(preview.mime).toBe("image/png");
    expect(h.service.readImageForPreview).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      { id: 1, imageId: 9 },
    );
  });
});

describe("GloGuideError → tRPC code 映射", () => {
  it("400 → BAD_REQUEST", async () => {
    h.service.updateArticle.mockRejectedValueOnce(new GloGuideError(400, "BAD_REQUEST", "標題要 4–80 字"));
    await expectCode(caller().update({ id: 1, title: "x", body: "y", theme: "z" }), "BAD_REQUEST");
  });

  it("404 → NOT_FOUND", async () => {
    h.service.getArticleBundle.mockRejectedValueOnce(new GloGuideError(404, "NOT_FOUND", "搵唔到呢篇指南"));
    await expectCode(caller().article({ id: 999 }), "NOT_FOUND");
  });

  it("409 → CONFLICT（狀態／閘口錯）", async () => {
    reset({ userId: 3, role: "supervisor" });
    h.service.approveArticle.mockRejectedValueOnce(
      new GloGuideError(409, "CONFLICT", "只有待審批（pending_review）嘅指南可以批准"),
    );
    await expectCode(caller().approve({ id: 1 }), "CONFLICT");
  });

  it("未識別錯誤 → INTERNAL_SERVER_ERROR，唔洩內部訊息", async () => {
    h.service.listArticleSummaries.mockRejectedValueOnce(new Error("db connection string leaked"));
    await expect(caller().articles()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "內部錯誤，請稍後再試",
    });
  });
});

describe("模特兒原圖管理（員工 JWT 閘；預覽只限後台）", () => {
  it("未登入 → UNAUTHORIZED；member → FORBIDDEN（service 完全冇被調用）", async () => {
    reset(null);
    await expectCode(caller().modelImages(), "UNAUTHORIZED");
    await expectCode(caller().modelImageDelete({ id: 1 }), "UNAUTHORIZED");
    reset({ userId: 9, role: "member" });
    await expectCode(caller().modelImages(), "FORBIDDEN");
    await expectCode(caller().modelImageSetDefault({ id: 1 }), "FORBIDDEN");
    await expectCode(
      caller().modelImageUpload({ filename: "a.png", mime: "image/png", dataBase64: "QUJD" }),
      "FORBIDDEN",
    );
    await expectCode(caller().modelImageRead({ id: 1 }), "FORBIDDEN");
    expect(h.service.listModelImages).not.toHaveBeenCalled();
    expect(h.service.uploadModelImage).not.toHaveBeenCalled();
    expect(h.service.setDefaultModelImage).not.toHaveBeenCalled();
    expect(h.service.deleteModelImage).not.toHaveBeenCalled();
    expect(h.service.readModelImageForPreview).not.toHaveBeenCalled();
  });

  it("staff 可以用全部五個 model image procedure；actor 由 server 砌（DB 名）", async () => {
    const list = await caller().modelImages();
    expect(list.maxCount).toBe(8);
    expect(h.service.listModelImages).toHaveBeenCalledTimes(1);

    await caller().modelImageUpload({ filename: "model.jpg", mime: "image/jpeg", dataBase64: "QUJD" });
    expect(h.service.uploadModelImage).toHaveBeenCalledWith(
      { id: 7, name: "陳小明", role: "staff" },
      { filename: "model.jpg", mime: "image/jpeg", dataBase64: "QUJD" },
    );

    await caller().modelImageSetDefault({ id: 3 });
    expect(h.service.setDefaultModelImage).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), { id: 3 });
    await caller().modelImageDelete({ id: 3 });
    expect(h.service.deleteModelImage).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), { id: 3 });

    const preview = await caller().modelImageRead({ id: 3 });
    expect(preview.mime).toBe("image/jpeg");
    expect(h.service.readModelImageForPreview).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      { id: 3 },
    );
  });

  it("zod 閘：id 要正整數；dataBase64 唔准空／超 14M chars；service 唔會收到壞 payload", async () => {
    await expect(caller().modelImageSetDefault({ id: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().modelImageDelete({ id: -2 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().modelImageRead({ id: 1.5 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller().modelImageUpload({ filename: "a.png", mime: "image/png", dataBase64: "" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller().modelImageUpload({ filename: "a.png", mime: "image/png", dataBase64: "A".repeat(14_000_001) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.service.uploadModelImage).not.toHaveBeenCalled();
    expect(h.service.setDefaultModelImage).not.toHaveBeenCalled();
  });

  it("service GloGuideError 映射：409（張數上限）→ CONFLICT；404 → NOT_FOUND", async () => {
    h.service.uploadModelImage.mockRejectedValueOnce(
      new GloGuideError(409, "CONFLICT", "最多 8 張模特兒原圖，請先刪除舊相"),
    );
    await expectCode(
      caller().modelImageUpload({ filename: "a.png", mime: "image/png", dataBase64: "QUJD" }),
      "CONFLICT",
    );
    h.service.readModelImageForPreview.mockRejectedValueOnce(
      new GloGuideError(404, "NOT_FOUND", "搵唔到呢張模特兒原圖"),
    );
    await expectCode(caller().modelImageRead({ id: 99 }), "NOT_FOUND");
  });
});

describe("輸入形狀閘（zod 先擋，service 唔會收到壞 payload）", () => {
  it("id 要正整數", async () => {
    await expect(caller().article({ id: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().article({ id: 1.5 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.service.getArticleBundle).not.toHaveBeenCalled();
  });

  it("imageReview decision 白名單（supervisor 都過唔到 zod）", async () => {
    reset({ userId: 3, role: "supervisor" });
    await expect(
      caller().imageReview({ id: 1, imageId: 2, decision: "maybe" as never }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.service.reviewImage).not.toHaveBeenCalled();
  });

  it("articles status filter 白名單", async () => {
    await expect(
      caller().articles({ status: "hacked" as never }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
