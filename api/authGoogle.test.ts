import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  signToken: vi.fn(),
  sendWelcomeEmail: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    query: { users: { findFirst: h.findFirst } },
    insert: h.insert,
    update: h.update,
  }),
}));
vi.mock("./auth", () => ({
  hashPassword: (value: string) => `hash:${value}`,
  verifyPassword: vi.fn(),
  signToken: h.signToken,
}));
vi.mock("./audit", () => ({ logAudit: h.logAudit }));
vi.mock("./email", () => ({
  sendPasswordResetEmail: vi.fn(),
  sendWelcomeEmail: h.sendWelcomeEmail,
}));
vi.mock("./wmsMemberSync", () => ({ forwardMemberToWms: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./vip", () => ({
  effectiveVipTier: () => "NONE",
  normalizeDeliveryMethod: (value: unknown) => value ?? null,
  normalizeRegion: (value: unknown) => value ?? null,
}));

import { authRouter } from "./authRouter";

const CLIENT_ID = "test-google-client";
const SUB = "google-sub-1234567890";
const EMAIL = "member@example.com";

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: "陳小明",
    phone: "91234567",
    email: EMAIL,
    role: "member",
    googleSub: null,
    googleEmail: null,
    googleName: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

function caller() {
  return authRouter.createCaller({
    req: new Request("http://test.local/api/trpc/auth.googleLogin"),
    resHeaders: new Headers(),
  });
}

function mockGoogleToken() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      aud: CLIENT_ID,
      sub: SUB,
      email: EMAIL,
      email_verified: true,
      name: "陳小明",
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  h.signToken.mockResolvedValue("signed-jwt");
  h.sendWelcomeEmail.mockResolvedValue({ ok: true });
  h.logAudit.mockResolvedValue(undefined);
  mockGoogleToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_CLIENT_ID;
});

describe("googleLogin — 防止未驗證 email 自動連結帳號", () => {
  it("電話註冊舊戶用同一 email：拒絕登入，唔寫 googleSub、唔發 token", async () => {
    h.findFirst
      .mockResolvedValueOnce(null) // googleSub 未連結
      .mockResolvedValueOnce(member()); // 本站從未驗證嘅 email 撞中舊戶

    await expect(caller().googleLogin({ idToken: "valid-google-id-token" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "呢個 Email 已經有會員帳號，請用電話同密碼登入，再喺會員中心連結 Google",
    });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.signToken).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("已喺登入狀態連結嘅帳號：照舊用 googleSub 直接登入", async () => {
    h.findFirst.mockResolvedValueOnce(
      member({ googleSub: SUB, googleEmail: EMAIL, googleName: "陳小明" }),
    );

    const result = await caller().googleLogin({ idToken: "valid-google-id-token" });
    expect(result.token).toBe("signed-jwt");
    expect(result.user.id).toBe(7);
    expect(result.user.googleLinked).toBe(true);
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("全新 Google 會員：email 冇人用時照舊自動開戶", async () => {
    const created = member({
      id: 8,
      phone: `g-${SUB.slice(0, 10)}`,
      googleSub: SUB,
      googleEmail: EMAIL,
      googleName: "陳小明",
    });
    h.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(created);
    const returning = vi.fn().mockResolvedValue([{ id: 8 }]);
    const values = vi.fn().mockReturnValue({ returning });
    h.insert.mockReturnValue({ values });

    const result = await caller().googleLogin({ idToken: "valid-google-id-token" });
    expect(result.user.id).toBe(8);
    expect(result.user.googleLinked).toBe(true);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ email: EMAIL, googleSub: SUB }));
    expect(h.signToken).toHaveBeenCalledOnce();
  });

  it("insert 並發撞 unique：只重讀 googleSub，唔准用 email fallback 接管舊戶", async () => {
    h.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null); // catch 後 googleSub 都冇 → 失敗收檔
    const returning = vi.fn().mockRejectedValue(new Error("unique email"));
    const values = vi.fn().mockReturnValue({ returning });
    h.insert.mockReturnValue({ values });

    await expect(caller().googleLogin({ idToken: "valid-google-id-token" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(h.findFirst).toHaveBeenCalledTimes(3);
    expect(h.signToken).not.toHaveBeenCalled();
  });
});
