import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { userFromAuthHeader, type AuthUser } from "./auth";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const createRouter = t.router;
export const publicQuery = t.procedure;

const requireUser = t.middleware(async ({ ctx, next }) => {
  const user = await userFromAuthHeader(ctx.req.headers.get("authorization"));
  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "請先登入" });
  }
  return next({ ctx: { ...ctx, user } });
});

// 三級員工制（2026-08-06 Glo 要求）：staff（員工）都可以入後台，
// 但五類敏感操作會喺各 router 被攔截轉審批單；supervisor/admin 照舊直接執行。
const requireStaff = t.middleware(async ({ ctx, next }) => {
  const user = await userFromAuthHeader(ctx.req.headers.get("authorization"));
  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "請先登入" });
  }
  if (user.role !== "staff" && user.role !== "supervisor" && user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "需要員工權限" });
  }
  return next({ ctx: { ...ctx, user } });
});

/** Requires a valid Bearer JWT; injects ctx.user. */
export const authedProcedure = t.procedure.use(requireUser);

const requireAdmin = t.middleware(async ({ ctx, next }) => {
  const user = await userFromAuthHeader(ctx.req.headers.get("authorization"));
  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "請先登入" });
  }
  if (user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "需要最高管理員權限" });
  }
  return next({ ctx: { ...ctx, user } });
});

/** Requires a valid Bearer JWT with role staff, supervisor or admin; injects ctx.user. */
export const staffProcedure = t.procedure.use(requireStaff);

// 三級員工制（2026-08-06 Glo 要求）：審批中心專用——主管＋管理員先可以審批員工請求
const requireSupervisor = t.middleware(async ({ ctx, next }) => {
  const user = await userFromAuthHeader(ctx.req.headers.get("authorization"));
  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "請先登入" });
  }
  if (user.role !== "supervisor" && user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "需要主管或管理員權限" });
  }
  return next({ ctx: { ...ctx, user } });
});

/** Requires a valid Bearer JWT with role supervisor or admin; injects ctx.user. */
export const supervisorProcedure = t.procedure.use(requireSupervisor);

/** Requires a valid Bearer JWT with role admin only; injects ctx.user. */
export const adminProcedure = t.procedure.use(requireAdmin);

export type { AuthUser };
