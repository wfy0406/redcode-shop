import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { randomBytes, randomInt } from "node:crypto";
import { getDb } from "./queries/connection";
import { passwordResetCodes, users } from "@db/schema";
import { createRouter, publicQuery, authedProcedure } from "./middleware";
import { hashPassword, verifyPassword, signToken } from "./auth";
import { logAudit } from "./audit";
import { sendPasswordResetEmail } from "./email";

/**
 * 電話正規化（2026-08-04 Glo 規則）：香港號碼統一儲 8 位本地號。
 * 「9123 4567」「+852 9123 4567」「85291234567」全部視為同一個號。
 * 其他格式（Google 開戶嘅 g-xxxx 佔位、海外號）原樣保留。
 */
function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 8) return digits;
  if (digits.length === 11 && digits.startsWith("852")) return digits.slice(3);
  return trimmed;
}

/** 撞檢查／登入用嘅變體：8 位本地號要同時查舊數據可能存咗嘅 852 版本 */
function phoneLookupVariants(raw: string): string[] {
  const n = normalizePhone(raw);
  return /^\d{8}$/.test(n) ? [n, `852${n}`] : [n];
}

const publicUser = (u: typeof users.$inferSelect) => ({
  id: u.id,
  name: u.name,
  phone: u.phone,
  email: u.email,
  address: u.address,
  age: u.age,
  birthMonth: u.birthMonth,
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
        // 生日月份（選填，1–12；舊會員留空）
        birthMonth: z.number().int().min(1).max(12).optional(),
        // Email（選填，2026-08-03 加；日後忘記密碼收驗證碼用）
        email: z.string().trim().email("Email 格式唔啱").max(255).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      // 電話統一儲 8 位本地號；撞檢查連埋 852 版本一齊查（舊數據可能有前綴）
      const phone = normalizePhone(input.phone);
      const existing = await db.query.users.findFirst({
        where: inArray(users.phone, phoneLookupVariants(input.phone)),
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "呢個電話號碼已經註冊過",
        });
      }
      // Email（選填）：統一細楷；有填就檢查撞唔撞人哋嘅帳號（包括 Google 開戶嗰啲）
      const email = input.email?.trim().toLowerCase() || null;
      if (email) {
        const emailDup = await db.query.users.findFirst({
          where: eq(users.email, email),
        });
        if (emailDup) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "呢個 Email 已經綁咗其他帳號",
          });
        }
      }
      const [{ id }] = await db
        .insert(users)
        .values({
          name: input.name,
          phone,
          passwordHash: hashPassword(input.password),
          email,
          address: input.address ?? null,
          age: input.age ?? null,
          birthMonth: input.birthMonth ?? null,
        })
        .returning({ id: users.id });
      const user = await db.query.users.findFirst({ where: eq(users.id, id) });
      const token = await signToken({ userId: id, role: user!.role });
      void logAudit({
        actorId: id,
        actorRole: "member",
        actorNameFallback: input.name,
        action: "member.register",
        targetType: "member",
        targetId: id,
        detail: `新會員註冊「${input.name}」（${phone}）`,
      });
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
      // 登入都照計 852 變體：舊帳號可能存咗前綴版，客人打 8 位本地號一樣入到
      const user = await db.query.users.findFirst({
        where: inArray(users.phone, phoneLookupVariants(input.phone)),
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
        // Email（2026-08-03 加）：傳 null 或空字串＝清除；有值要撞檢查
        email: z.string().trim().email("Email 格式唔啱").max(255).nullable().optional(),
        address: z.string().nullable().optional(),
        age: z.number().int().min(1).max(120).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const data: Partial<typeof users.$inferInsert> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.email !== undefined) {
        // null／空 → 清除；有值 → 細楷＋防撞（唔可以撞其他人嘅帳號，撞自己冇所謂）
        const email = input.email?.trim().toLowerCase() || null;
        if (email) {
          const dup = await db.query.users.findFirst({
            where: eq(users.email, email),
          });
          if (dup && dup.id !== ctx.user.userId) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "呢個 Email 已經綁咗其他帳號",
            });
          }
        }
        data.email = email;
      }
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

  // ── 忘記密碼（2026-08-04）：email 收 6 位驗證碼 → 驗證 → 重設密碼 ──
  // 安全設計：
  // - 永遠回 { ok: true }，唔會透露個 email 有冇綁帳號（防帳號枚舉）
  // - 驗證碼只存 hash（同密碼同一套 hashPassword），10 分鐘有效
  // - 每個碼最多試 5 次；成功重設後即標記 used；再索取新碼會作廢晒舊碼
  requestPasswordReset: publicQuery
    .input(
      z.object({
        email: z.string().trim().email("Email 格式唔啱").max(255),
      }),
    )
    .mutation(async ({ input }) => {
      const email = input.email.toLowerCase();
      const db = getDb();
      const user = await db.query.users.findFirst({
        where: eq(users.email, email),
        columns: { id: true, name: true },
      });
      if (user) {
        // 舊碼全部作廢，等客人淨係可以用最新嗰個
        await db
          .update(passwordResetCodes)
          .set({ usedAt: new Date() })
          .where(
            and(eq(passwordResetCodes.email, email), isNull(passwordResetCodes.usedAt)),
          );
        const code = String(randomInt(100000, 1000000)); // 6 位數字
        await db.insert(passwordResetCodes).values({
          email,
          codeHash: hashPassword(code),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        });
        await sendPasswordResetEmail(email, code, user.name);
      }
      return { ok: true };
    }),

  resetPasswordWithCode: publicQuery
    .input(
      z.object({
        email: z.string().trim().email("Email 格式唔啱").max(255),
        code: z.string().trim().regex(/^\d{6}$/, "驗證碼係 6 位數字"),
        newPassword: z.string().min(6, "新密碼至少 6 位").max(64),
      }),
    )
    .mutation(async ({ input }) => {
      const email = input.email.toLowerCase();
      const db = getDb();
      const invalid = () =>
        new TRPCError({
          code: "BAD_REQUEST",
          message: "驗證碼唔啱或者已經過期，請重新索取",
        });
      const [record] = await db
        .select()
        .from(passwordResetCodes)
        .where(
          and(eq(passwordResetCodes.email, email), isNull(passwordResetCodes.usedAt)),
        )
        .orderBy(desc(passwordResetCodes.createdAt))
        .limit(1);
      if (!record) throw invalid();
      if (record.expiresAt.getTime() < Date.now()) throw invalid();
      if (record.attempts >= 5) throw invalid();
      if (!verifyPassword(input.code, record.codeHash)) {
        await db
          .update(passwordResetCodes)
          .set({ attempts: record.attempts + 1 })
          .where(eq(passwordResetCodes.id, record.id));
        throw invalid();
      }
      const user = await db.query.users.findFirst({
        where: eq(users.email, email),
        columns: { id: true, name: true },
      });
      if (!user) throw invalid();
      await db
        .update(users)
        .set({ passwordHash: hashPassword(input.newPassword) })
        .where(eq(users.id, user.id));
      await db
        .update(passwordResetCodes)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetCodes.id, record.id));
      void logAudit({
        actorId: user.id,
        actorRole: "member",
        action: "member.emailResetPassword",
        targetType: "member",
        targetId: user.id,
        detail: `會員「${user.name}」經 Email 驗證碼自助重設密碼`,
      });
      return { ok: true };
    }),
});
