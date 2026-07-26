import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { getDb } from "./queries/connection";
import { users } from "@db/schema";
import { createRouter, publicQuery, authedProcedure } from "./middleware";
import { hashPassword, verifyPassword, signToken } from "./auth";

const publicUser = (u: typeof users.$inferSelect) => ({
  id: u.id,
  name: u.name,
  phone: u.phone,
  email: u.email,
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

  // Google 登入（零新 dependency：直接用 Google tokeninfo endpoint 驗 id_token）
  // 搵到 email → 直接簽 JWT；搵唔到 → 自動開會員戶口（phone 用 g-<sub> 佔位、隨機密碼）
  googleLogin: publicQuery
    .input(z.object({ idToken: z.string().min(10) }))
    .mutation(async ({ input }) => {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Google 登入未啟用",
        });
      }

      const googleFail = () =>
        new TRPCError({ code: "UNAUTHORIZED", message: "Google 登入失敗，請再試一次" });

      let info: {
        sub?: string;
        email?: string;
        email_verified?: string | boolean;
        name?: string;
        aud?: string;
      };
      try {
        const res = await fetch(
          `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(input.idToken)}`,
        );
        if (!res.ok) throw googleFail();
        info = (await res.json()) as typeof info;
      } catch (e) {
        if (e instanceof TRPCError) throw e;
        throw googleFail();
      }
      if (info.aud !== clientId || !info.email || !info.sub) throw googleFail();
      if (info.email_verified !== true && info.email_verified !== "true") throw googleFail();

      const email = info.email.toLowerCase();
      const db = getDb();
      let user = await db.query.users.findFirst({ where: eq(users.email, email) });

      if (!user) {
        // 自動開戶：phone 必填 → 用 g- + google sub 前 10 位做佔位（unique）；
        // 密碼用隨機 32-byte hex 落 hash，用戶之後可以經 changePassword 自設
        const placeholderPhone = `g-${info.sub.slice(0, 10)}`;
        const name = info.name?.trim() || email.split("@")[0] || "Google 用戶";
        try {
          const [{ id }] = await db
            .insert(users)
            .values({
              name,
              phone: placeholderPhone,
              email,
              passwordHash: hashPassword(randomBytes(32).toString("hex")),
              role: "member",
            })
            .returning({ id: users.id });
          user = await db.query.users.findFirst({ where: eq(users.id, id) });
        } catch {
          // 並發撞 unique（email / 佔位 phone）→ 重讀一次當登入
          user = await db.query.users.findFirst({ where: eq(users.email, email) });
        }
        if (!user) throw googleFail();
      }

      const token = await signToken({ userId: user.id, role: user.role });
      return { token, user: publicUser(user) };
    }),

  // 畀前台攞 Google Client ID（runtime env，避免 Vite build-time inlining ——
  // Render Docker build 冇 dashboard env，所以 client ID 要 runtime 經 API 攞）
  googleConfig: publicQuery.query(() => {
    return { clientId: process.env.GOOGLE_CLIENT_ID ?? null };
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

  updateProfile: authedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255).optional(),
        address: z.string().nullable().optional(),
        age: z.number().int().min(1).max(120).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const data: Partial<typeof users.$inferInsert> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.address !== undefined) data.address = input.address;
      if (input.age !== undefined) data.age = input.age;
      if (Object.keys(data).length > 0) {
        await db.update(users).set(data).where(eq(users.id, ctx.user.userId));
      }
      const user = await db.query.users.findFirst({
        where: eq(users.id, ctx.user.userId),
      });
      if (!user) {
        throw new TRPCError({ code: "NOT_FOUND", message: "用戶不存在" });
      }
      return publicUser(user);
    }),

  changePassword: authedProcedure
    .input(
      z.object({
        oldPassword: z.string().min(1),
        newPassword: z.string().min(6).max(64),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const user = await db.query.users.findFirst({
        where: eq(users.id, ctx.user.userId),
      });
      if (!user) {
        throw new TRPCError({ code: "NOT_FOUND", message: "用戶不存在" });
      }
      if (!verifyPassword(input.oldPassword, user.passwordHash)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "舊密碼唔啱" });
      }
      await db
        .update(users)
        .set({ passwordHash: hashPassword(input.newPassword) })
        .where(eq(users.id, user.id));
      return { ok: true };
    }),
});
