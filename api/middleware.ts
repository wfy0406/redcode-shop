import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { eq } from "drizzle-orm";
import type { TrpcContext } from "./context";
import { userFromAuthHeader, type AuthUser } from "./auth";
import { getDb } from "./queries/connection";
import { users } from "@db/schema";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const createRouter = t.router;
export const publicQuery = t.procedure;
// 2026-10-09（訪客購買）：語意化别名——訪客 tRPC 全部用呢個（唔使登入，權限喺 procedure 內用 orderNo+token 雙因子強制）
export const publicProcedure = t.procedure;

// ── P1-2（2026-10 安全修復）：JWT 角色快照覆核 ──────────────────────────────
// 舊做法淨係解 JWT payload（7 日有效）——降職／刪帳號後舊 token 照用到過期。
// 而家：staff／supervisor／admin 級**每 request 以 PK 查 DB 覆核**（用戶存在＋role 同 JWT 相符）；
// member 級加 60 秒 in-memory cache 覆核（會員量大，唔好每下都打 DB）。
// S05（2026-11-19）：同一覆核順手攞 users.passwordChangedAt——改密碼／重設密碼後
// iat 較舊嘅 JWT 即時作廢（passwordChangedAt NULL＝從未改密碼，唔影響舊會員）。
const MEMBER_RECHECK_CACHE_MS = 60 * 1000;
const memberRoleCache = new Map<
  number,
  { role: AuthUser["role"] | null; passwordChangedAtMs: number | null; at: number }
>();

export type UserRecheck = {
  role: AuthUser["role"] | null;
  passwordChangedAtMs: number | null;
};

/** 以 PK 查 DB 攞最新 role＋密碼更改時間；搵唔到（已刪帳號）回 null。member 級行 60 秒 cache。 */
export async function recheckUserAuthz(user: AuthUser): Promise<UserRecheck | null> {
  if (user.role === "member") {
    const hit = memberRoleCache.get(user.userId);
    if (hit && Date.now() - hit.at < MEMBER_RECHECK_CACHE_MS) {
      return { role: hit.role, passwordChangedAtMs: hit.passwordChangedAtMs };
    }
  }
  const db = getDb();
  const [row] = await db
    .select({ role: users.role, passwordChangedAt: users.passwordChangedAt })
    .from(users)
    .where(eq(users.id, user.userId))
    .limit(1);
  const result: UserRecheck | null = row
    ? {
        role: row.role as AuthUser["role"],
        passwordChangedAtMs: row.passwordChangedAt ? row.passwordChangedAt.getTime() : null,
      }
    : null;
  if (user.role === "member") {
    memberRoleCache.set(user.userId, {
      role: result?.role ?? null,
      passwordChangedAtMs: result?.passwordChangedAtMs ?? null,
      at: Date.now(),
    });
    // 防記憶體無限增長：bucket 大咗就掃走過期 entry
    if (memberRoleCache.size > 5000) {
      const now = Date.now();
      for (const [k, v] of memberRoleCache) {
        if (now - v.at >= MEMBER_RECHECK_CACHE_MS) memberRoleCache.delete(k);
      }
    }
  }
  return result;
}

/** 以 PK 查 DB 攞最新 role；搵唔到（已刪帳號）回 null。member 級行 60 秒 cache。 */
export async function recheckUserRole(user: AuthUser): Promise<AuthUser["role"] | null> {
  return (await recheckUserAuthz(user))?.role ?? null;
}

/**
 * S05：改密碼／重設密碼後即時作廢 member 級 60 秒 cache（等舊 token 唔係最遲 60 秒後先死，
 * 而係下一個 request 已經打返 DB 攞到新 passwordChangedAt）。authRouter 改完密碼要叫。
 */
export function invalidateUserRecheckCache(userId: number): void {
  memberRoleCache.delete(userId);
}

/**
 * S05：JWT iat 早過密碼更改時間 → true（token 已作廢）。
 * 容忍同一秒：iat（秒精度）同 passwordChangedAt 同一秒嘅 token 唔殺（改密碼嗰下本身
 * 就係用舊 token 打嚟）；舊過一秒或以上先拒。iat 缺失（手簽 token）→ 唔殺（向後兼容）。
 */
export function isTokenRevokedByPasswordChange(
  iatSeconds: number | undefined,
  passwordChangedAtMs: number | null,
): boolean {
  if (!passwordChangedAtMs || iatSeconds === undefined) return false;
  return Math.floor(passwordChangedAtMs / 1000) > iatSeconds;
}

/**
 * JWT 驗完再覆核 DB：帳號已刪 → 401；role 同 JWT 唔符（降職／改職）→ 403；
 * token 簽發早過最後改密碼 → 401（舊 token 即時作廢）。
 * 通過後 ctx.user 用 **DB 嘅最新 role**（唔再信 JWT 快照）。
 */
async function verifiedUser(ctx: TrpcContext): Promise<AuthUser> {
  const user = await userFromAuthHeader(ctx.req.headers.get("authorization"));
  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "請先登入" });
  }
  const recheck = await recheckUserAuthz(user);
  if (!recheck?.role) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "帳號狀態有變，請重新登入" });
  }
  if (isTokenRevokedByPasswordChange(user.iat, recheck.passwordChangedAtMs)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "密碼已更改，請重新登入" });
  }
  if (recheck.role !== user.role) {
    throw new TRPCError({ code: "FORBIDDEN", message: "帳號權限已變更，請重新登入" });
  }
  return { userId: user.userId, role: recheck.role };
}

const requireUser = t.middleware(async ({ ctx, next }) => {
  const user = await verifiedUser(ctx);
  return next({ ctx: { ...ctx, user } });
});

const requireStaff = t.middleware(async ({ ctx, next }) => {
  const user = await verifiedUser(ctx);
  // 三級制（2026-08-06）：supervisor＝主管，同主管級以上先入到後台
  if (user.role !== "staff" && user.role !== "supervisor" && user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "需要管理員權限" });
  }
  return next({ ctx: { ...ctx, user } });
});

/** Requires a valid Bearer JWT; injects ctx.user. */
export const authedProcedure = t.procedure.use(requireUser);

const requireAdmin = t.middleware(async ({ ctx, next }) => {
  const user = await verifiedUser(ctx);
  if (user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "需要最高管理員權限" });
  }
  return next({ ctx: { ...ctx, user } });
});

const requireSupervisor = t.middleware(async ({ ctx, next }) => {
  const user = await verifiedUser(ctx);
  // 三級制（2026-08-06）：審批中心只有主管＋管理員入得（員工唔批得單）
  if (user.role !== "supervisor" && user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "需要主管或管理員權限" });
  }
  return next({ ctx: { ...ctx, user } });
});

/** Requires a valid Bearer JWT with role staff or admin; injects ctx.user. */
export const staffProcedure = t.procedure.use(requireStaff);

/** Requires a valid Bearer JWT with role supervisor or admin; injects ctx.user. */
export const supervisorProcedure = t.procedure.use(requireSupervisor);

/** Requires a valid Bearer JWT with role admin only; injects ctx.user. */
export const adminProcedure = t.procedure.use(requireAdmin);

export type { AuthUser };
