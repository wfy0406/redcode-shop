/**
 * S05（2026-11-19 安全修復）：改密碼／重設密碼後舊 JWT 即時撤銷。
 *
 * 原始弱點：JWT 7 日有效，改密碼後舊 token 照用到過期——偷到 token 嘅人
 * 喺事主改密碼自救之後仍然入到帳。
 *
 * 修復鏈路：
 *   ① signToken 簽發有 iat；verifyToken 將 iat 帶入 AuthUser；
 *   ② users.passwordChangedAt（改密碼／重設時寫入；舊會員 NULL＝唔影響）；
 *   ③ middleware recheckUserAuthz 覆核時一併攞 passwordChangedAt，
 *      isTokenRevokedByPasswordChange 判定 iat 較舊嘅 token 作廢；
 *   ④ invalidateUserRecheckCache 殺 member 級 60 秒 cache，撤銷唔使等 cache 過期。
 *
 * 呢度唔掂真 DB（repo 規矩）：DB 覆核用 mock getDb。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mock DB（喺 import middleware 之前）────────────────────────────────────
let mockRow: { role: string; passwordChangedAt: Date | null } | null = null;
let dbHits = 0;

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            dbHits++;
            return Promise.resolve(mockRow ? [mockRow] : []);
          },
        }),
      }),
    }),
  }),
}));

import { signToken, verifyToken } from "./auth";
import {
  invalidateUserRecheckCache,
  isTokenRevokedByPasswordChange,
  recheckUserAuthz,
} from "./middleware";

beforeEach(() => {
  process.env.JWT_SECRET = "test-jwt-secret-for-s05"; // 測試 fixture，唔係真 secret
  mockRow = { role: "member", passwordChangedAt: null };
  dbHits = 0;
  invalidateUserRecheckCache(42);
});

describe("JWT iat 管道", () => {
  it("signToken → verifyToken 帶返 iat（撤銷判定嘅基礎）", async () => {
    const token = await signToken({ userId: 42, role: "member" });
    const user = await verifyToken(token);
    expect(user).not.toBeNull();
    expect(user!.userId).toBe(42);
    expect(typeof user!.iat).toBe("number");
    expect(Math.abs(Date.now() / 1000 - user!.iat!)).toBeLessThan(60);
  });
});

describe("isTokenRevokedByPasswordChange", () => {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  it("★ 原始弱點：改密碼前簽發嘅 token 作廢", () => {
    expect(isTokenRevokedByPasswordChange(nowSec - 3600, nowMs)).toBe(true);
  });
  it("合法流程：改密碼後新登入嘅 token 照用", () => {
    expect(isTokenRevokedByPasswordChange(nowSec, nowMs - 3600_000)).toBe(false);
  });
  it("同一秒簽發唔誤殺（改密碼嗰下本身就係用舊 token 打嚟）", () => {
    expect(isTokenRevokedByPasswordChange(nowSec, nowMs)).toBe(false);
  });
  it("passwordChangedAt NULL（從未改密碼／舊會員）→ 唔撤銷；iat 缺失 → 唔撤銷", () => {
    expect(isTokenRevokedByPasswordChange(nowSec - 999999, null)).toBe(false);
    expect(isTokenRevokedByPasswordChange(undefined, nowMs)).toBe(false);
  });
});

describe("recheckUserAuthz（DB 覆核＋cache）", () => {
  it("攞到 role＋passwordChangedAt；已刪帳號回 null", async () => {
    mockRow = { role: "member", passwordChangedAt: new Date("2026-11-19T00:00:00Z") };
    const r = await recheckUserAuthz({ userId: 42, role: "member" });
    expect(r).not.toBeNull();
    expect(r!.role).toBe("member");
    expect(r!.passwordChangedAtMs).toBe(new Date("2026-11-19T00:00:00Z").getTime());
    mockRow = null;
    invalidateUserRecheckCache(42);
    expect(await recheckUserAuthz({ userId: 42, role: "member" })).toBeNull();
  });
  it("member 級 60 秒 cache：第二次唔打 DB；invalidateUserRecheckCache 即刻逼使打 DB", async () => {
    const first = await recheckUserAuthz({ userId: 42, role: "member" });
    expect(first!.role).toBe("member");
    expect(dbHits).toBe(1);
    // cache 命中：DB 內容改咗都仲係舊值
    mockRow = { role: "member", passwordChangedAt: new Date() };
    const cached = await recheckUserAuthz({ userId: 42, role: "member" });
    expect(dbHits).toBe(1);
    expect(cached!.passwordChangedAtMs).toBeNull();
    // ★ 改密碼後即刻殺 cache → 下一個 request 攞到新 passwordChangedAt（即時撤銷）
    invalidateUserRecheckCache(42);
    const fresh = await recheckUserAuthz({ userId: 42, role: "member" });
    expect(dbHits).toBe(2);
    expect(fresh!.passwordChangedAtMs).not.toBeNull();
  });
  it("staff 級唔行 cache（每 request 打 DB）", async () => {
    mockRow = { role: "staff", passwordChangedAt: null };
    await recheckUserAuthz({ userId: 7, role: "staff" });
    await recheckUserAuthz({ userId: 7, role: "staff" });
    expect(dbHits).toBe(2);
  });
});
