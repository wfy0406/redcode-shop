import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { users } from "@db/schema";
import { createRouter, publicQuery, authedProcedure } from "./middleware";
import { hashPassword, verifyPassword, signToken } from "./auth";

const publicUser = (u: typeof users.$inferSelect) => ({
  id: u.id,
  name: u.name,
  phone: u.phone,
  address: u.address,
  age: u.age,
  role: u.role,
  createdAt: u.createdAt,
});

export const authRouter = createRouter({
  register: publicQuery
    .input(
      z.object({
        name: z.string().min(1),
        phone: z.string().min(4).max(32),
        password: z.string().min(6),
        address: z.string().optional(),
        age: z.number().int().min(0).max(150).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const existing = await db.query.users.findFirst({
        where: eq(users.phone, input.phone),
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "呢個電話號碼已經註冊過",
        });
      }
      const [{ id }] = await db
        .insert(users)
        .values({
          name: input.name,
          phone: input.phone,
          passwordHash: hashPassword(input.password),
          address: input.address ?? null,
          age: input.age ?? null,
        })
        .returning({ id: users.id });
      const user = await db.query.users.findFirst({ where: eq(users.id, id) });
      const token = await signToken({ userId: id, role: user!.role });
      return { token, user: publicUser(user!) };
    }),

  login: publicQuery
    .input(
      z.object({
        phone: z.string().min(1),
        password: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const user = await db.query.users.findFirst({
        where: eq(users.phone, input.phone),
      });
      if (!user || !verifyPassword(input.password, user.passwordHash)) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "電話號碼或密碼錯誤",
        });
      }
      const token = await signToken({ userId: user.id, role: user.role });
      return { token, user: publicUser(user) };
    }),

  me: authedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const user = await db.query.users.findFirst({
      where: eq(users.id, ctx.user.userId),
    });
    if (!user) {
      throw new TRPCError({ code: "NOT_FOUND", message: "用戶不存在" });
    }
    return publicUser(user);
  }),
});
