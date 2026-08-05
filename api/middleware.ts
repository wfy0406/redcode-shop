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

const requireStaff = t.middleware(async ({ ctx, next }) => {
  const user = await userFromAuthHeader(ctx.req.headers.get("authorization"));
  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "請先登入" });
  }
  if (user.role !== "staff" && user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "需要管理員權限" });
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

/** Requires a valid Bearer JWT with role staff or admin; injects ctx.user. */
export const staffProcedure = t.procedure.use(requireStaff);

/** Requires a valid Bearer JWT with role admin only; injects ctx.user. */
export const adminProcedure = t.procedure.use(requireAdmin);

export type { AuthUser };
