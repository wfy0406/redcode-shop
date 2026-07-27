import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { asc, eq, ne } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { users } from "@db/schema";
import { hashPassword } from "./auth";
import { createRouter, adminProcedure } from "./middleware";
import { logAudit } from "./audit";

/**
 * 員工帳號管理 —— 全部係 admin-only（最高管理員）
 * list：只列員工＋管理員帳號（會員帳號喺「會員」頁管，唔回 passwordHash）
 * create：開新帳號（會員／員工／管理員）
 * updateRole：改權限（唔可以改自己）
 * remove：刪帳號（唔可以刪自己；有訂單嘅會員刪唔到）
 */
const roleSchema = z.enum(["member", "staff", "admin"]);

export const usersRouter = createRouter({
  list: adminProcedure.query(async () => {
    const db = getDb();
    return db
      .select({
        id: users.id,
        name: users.name,
        phone: users.phone,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(ne(users.role, "member"))
      .orderBy(asc(users.id));
  }),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1, "名稱必填").max(255),
        phone: z
          .string()
          .min(8, "電話至少 8 位")
          .max(32)
          .regex(/^[0-9+\-\s]+$/, "電話格式唔啱"),
        password: z.string().min(6, "密碼至少 6 位").max(64),
        role: roleSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const dup = await db.query.users.findFirst({
        where: eq(users.phone, input.phone),
      });
      if (dup) {
        throw new TRPCError({ code: "CONFLICT", message: "呢個電話號碼已經註冊咗" });
      }
      const [{ id }] = await db
        .insert(users)
        .values({
          name: input.name.trim(),
          phone: input.phone.trim(),
          passwordHash: hashPassword(input.password),
          role: input.role,
        })
        .returning({ id: users.id });
      const roleLabel = { member: "會員", staff: "員工", admin: "管理員" }[input.role];
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "staff.create",
        targetType: "staff",
        targetId: id,
        detail: `開新帳號「${input.name.trim()}」（${input.phone.trim()}，${roleLabel}）`,
      });
      return { id };
    }),

  updateRole: adminProcedure
    .input(z.object({ id: z.number().int().positive(), role: roleSchema }))
    .mutation(async ({ input, ctx }) => {
      if (input.id === ctx.user.userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "唔可以改自己嘅權限",
        });
      }
      const db = getDb();
      const existing = await db.query.users.findFirst({
        where: eq(users.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "帳號不存在" });
      }
      await db.update(users).set({ role: input.role }).where(eq(users.id, input.id));
      const roleLabel = { member: "會員", staff: "員工", admin: "管理員" }[input.role];
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "staff.updateRole",
        targetType: "staff",
        targetId: input.id,
        detail: `將「${existing.name}」嘅權限改做${roleLabel}`,
      });
      return { ok: true };
    }),

  remove: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      if (input.id === ctx.user.userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "唔可以刪除自己嘅帳號",
        });
      }
      const db = getDb();
      const existing = await db.query.users.findFirst({
        where: eq(users.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "帳號不存在" });
      }
      // 有訂單／購物車紀錄嘅帳號會被外鍵擋住，畀個友善提示
      try {
        await db.delete(users).where(eq(users.id, input.id));
      } catch {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "呢個帳號有訂單或購物車紀錄，唔可以刪除（可以改做會員權限代替）",
        });
      }
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "staff.remove",
        targetType: "staff",
        targetId: input.id,
        detail: `刪除帳號「${existing.name}」（${existing.phone}，${existing.role}）`,
      });
      return { ok: true };
    }),
});
