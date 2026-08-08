import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { randomBytes, randomInt } from "node:crypto";
import { getDb } from "./queries/connection";
import { passwordResetCodes, users } from "@db/schema";
import { createRouter, publicQuery, authedProcedure } from "./middleware";
import { hashPassword, verifyPassword, signToken } from "./auth";
import { logAudit } from "./audit";
import { sendPasswordResetEmail, sendWelcomeEmail } from "./email";
import { forwardMemberToWms } from "./wmsMemberSync";

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
  // 預設取貨方式（2026-08-08 Glo 要求）：會員中心顯示＋結帳自動帶入用
  deliveryMethod: u.deliveryMethod,
  pickupPoint: u.pickupPoint,
  age: u.age,
  birthMonth: u.birthMonth,
  // 直接促銷同意（2026-08-05）：會員中心開關顯示用；後台列表由 membersRouter 自己 select
  marketingOptIn: u.marketingOptIn,
  // 三態制（2026-08-06）：前台一次性彈窗靠 createdAt + marketingPromptedAt 判斷「未選」
  marketingPromptedAt: u.marketingPromptedAt,
  // 已連結 Google 帳號（2026-08-04）：會員中心顯示連結狀態；sub 本身唔出畀前端
  googleLinked: u.googleSub != null,
  // Google 開戶嘅帳號 email 鎖死跟 Google 電郵（2026-08-04 Glo 要求）：
  // Google 開戶嘅帳號一出世 email 就等於 googleEmail，後端 updateProfile 嘅鎖保證佢永遠一致；
  // 電話註冊、後嚟先連結 Google 而 email 唔同嘅會員就唔會被鎖（佢哋可以自己改 email）
  emailLocked:
    u.googleSub != null &&
    u.email != null &&
    u.googleEmail != null &&
    u.email.toLowerCase() === u.googleEmail.toLowerCase(),
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
        // 預設取貨方式（2026-08-08 Glo 要求）：選填；揀自取可以順手填站點名稱/編號
        deliveryMethod: z.enum(["address", "sf_station", "sf_locker"]).optional(),
        pickupPoint: z.string().max(255).optional(),
        age: z.number().int().min(0).max(150).optional(),
        // 生日月份（選填，1–12；舊會員留空）
        birthMonth: z.number().int().min(1).max(12).optional(),
        // Email（2026-08-03 加；2026-08-04 起改必填，Glo 要求：註冊一定要填，歡迎信先寄得到）
        email: z.string().trim().email("Email 格式唔啱").max(255),
        // 直接促銷同意（2026-08-05 Glo 要求，PDPO 第 6A 部）：註冊頁剔選格，冇傳/冇剔＝false
        marketingOptIn: z.boolean().optional(),
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
      // Email（必填）：統一細楷；檢查撞唔撞人哋嘅帳號（包括 Google 開戶嗰啲）
      const email = input.email.trim().toLowerCase();
      const emailDup = await db.query.users.findFirst({
        where: eq(users.email, email),
      });
      if (emailDup) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "呢個 Email 已經綁咗其他帳號",
        });
      }
      const [{ id }] = await db
        .insert(users)
        .values({
          name: input.name,
          phone,
          passwordHash: hashPassword(input.password),
          email,
          address: input.address ?? null,
          // 預設取貨方式：揀自取先會存站點（送貨上門唔存，唔好留殘舊資料）
          deliveryMethod: input.deliveryMethod ?? "address",
          pickupPoint:
            input.deliveryMethod && input.deliveryMethod !== "address"
              ? input.pickupPoint?.trim() || null
              : null,
          age: input.age ?? null,
          birthMonth: input.birthMonth ?? null,
          // 直接促銷同意：剔咗先記 true＋時間；冇剔＝false（預設），促銷電郵唔會寄畀佢
          marketingOptIn: input.marketingOptIn ?? false,
          marketingOptInAt: input.marketingOptIn ? new Date() : null,
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
        detail: `新會員註冊「${input.name}」（${phone}${input.marketingOptIn ? "，同意接收推廣資訊" : ""}）`,
      });
      // 2026-08-04（Glo 要求）：註冊成功即發歡迎信（內附迎新優惠碼 WELLCOMEYOU）；
      // email 而家係必填，所以每個新會員都一定寄；失敗淨係 log，唔阻註冊
      void sendWelcomeEmail({ to: email, name: input.name })
        .then((r) => {
          if (!r.ok) console.error(`[email] 歡迎信寄唔出 → ${email}:`, r.error);
        })
        .catch((e) => console.error("[email] 歡迎信出錯:", e));
      // B-2（2026-08-06 WMS 對接）：會員資料有變 → 同步去 WMS（fire-and-forget，失敗唔阻流程）
      void forwardMemberToWms(id).catch((e) => console.error("[wms] member sync error:", e));
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
  // 搵人次序（2026-08-04 連結功能後）：
  //   1) googleSub 搵 —— 已連結嘅帳號（改 email 都唔會斷）
  //   2) email 搵 —— 撞中舊帳號 → 順手補寫 googleSub（等如自動連結）
  //   3) 都冇 → 自動開會員戶口（phone 用 g-<sub> 佔位、隨機密碼、一開始就寫埋 googleSub）
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
      const sub = info.sub;
      // Google 顯示名快照（2026-08-04）：後台會員詳情顯示用；冇名就留 null
      const gName = info.name?.trim() || null;
      const db = getDb();
      // 1) 已連結嘅帳號：用 Google 永久 ID 直達
      let user = await db.query.users.findFirst({ where: eq(users.googleSub, sub) });
      if (user) {
        // 順手更新 Google email／名稱快照（會員喺 Google 改咗名都會跟到）
        if (user.googleEmail !== email || user.googleName !== gName) {
          await db
            .update(users)
            .set({ googleEmail: email, googleName: gName })
            .where(eq(users.id, user.id));
          user = { ...user, googleEmail: email, googleName: gName };
        }
      }
      if (!user) {
        // 2) email 撞中舊帳號（例如之前用電話註冊、會員資料填咗同一個 email）
        user = await db.query.users.findFirst({ where: eq(users.email, email) });
        if (user && user.googleSub !== sub) {
          // 順手補寫／校正 googleSub：Google 保證 email 由呢個帳號控制，安全
          await db
            .update(users)
            .set({ googleSub: sub, googleEmail: email, googleName: gName })
            .where(eq(users.id, user.id));
          user = { ...user, googleSub: sub, googleEmail: email, googleName: gName };
          // 2026-08-04（Glo 要求）：舊會員經 Google 登入自動連結咗 Google，日誌要記低
          void logAudit({
            actorId: user.id,
            actorRole: user.role,
            actorNameFallback: user.name,
            action: "member.linkGoogle",
            targetType: "member",
            targetId: user.id,
            detail: `會員「${user.name}」經 Google 登入自動連結 Google 帳號（${email}）`,
          });
        }
      }

      let isNewMember = false;
      if (!user) {
        // 3) 全新會員 → 自動開戶：phone 必填 → 用 g- + google sub 前 10 位做佔位（unique）；
        // 密碼用隨機 32-byte hex 落 hash，用戶之後可以經 changePassword 自設
        const placeholderPhone = `g-${sub.slice(0, 10)}`;
        const name = info.name?.trim() || email.split("@")[0] || "Google 用戶";
        try {
          const [{ id }] = await db
            .insert(users)
            .values({
              name,
              phone: placeholderPhone,
              email,
              googleSub: sub,
              googleEmail: email,
              googleName: gName,
              passwordHash: hashPassword(randomBytes(32).toString("hex")),
              role: "member",
            })
            .returning({ id: users.id });
          isNewMember = true;
          user = await db.query.users.findFirst({ where: eq(users.id, id) });
        } catch {
          // 並發撞 unique（email / 佔位 phone / googleSub）→ 重讀一次當登入
          user =
            (await db.query.users.findFirst({ where: eq(users.googleSub, sub) })) ??
            (await db.query.users.findFirst({ where: eq(users.email, email) }));
        }
        if (!user) throw googleFail();
        if (isNewMember) {
          // 2026-08-04（Glo 要求）：Google 註冊嘅新會員，日誌要寫明有連結 Google
          void logAudit({
            actorId: user.id,
            actorRole: user.role,
            actorNameFallback: user.name,
            action: "member.register",
            targetType: "member",
            targetId: user.id,
            detail: `新會員註冊「${user.name}」（Google 註冊 ${email}，已連結 Google）`,
          });
          // 全新 Google 會員 → 即發歡迎信（2026-08-04；email 一定存在，Google 保證）
          void sendWelcomeEmail({ to: email, name: user.name })
            .then((r) => {
              if (!r.ok) console.error(`[email] 歡迎信寄唔出 → ${email}:`, r.error);
            })
            .catch((e) => console.error("[email] 歡迎信出錯:", e));
        }
      }

      const token = await signToken({ userId: user.id, role: user.role });
      return { token, user: publicUser(user) };
    }),

  // 會員中心「連結 Google 帳號」（2026-08-04）：已登入會員綁定自己嘅 Google，
  // 之後登入頁撳 Google 掣就直入呢個帳號（googleSub 做錨，之後改 email 都唔會斷）。
  // 一個 Google 帳號只可以綁一個會員；同一會員可以再撳一次換綁另一個 Google（覆蓋）。
  linkGoogle: authedProcedure
    .input(z.object({ idToken: z.string().min(10) }))
    .mutation(async ({ ctx, input }) => {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Google 登入未啟用",
        });
      }

      const googleFail = () =>
        new TRPCError({ code: "UNAUTHORIZED", message: "Google 驗證失敗，請再試一次" });

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
      const sub = info.sub;
      const gName = info.name?.trim() || null;
      const db = getDb();

      // 呢個 Google 帳號已經綁咗另一個會員 → 擋（唔可以一個 Google 通兩戶）
      const holder = await db.query.users.findFirst({
        where: eq(users.googleSub, sub),
      });
      if (holder && holder.id !== ctx.user.userId) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "呢個 Google 帳號已經連結咗另一個會員帳號",
        });
      }

      const me = await db.query.users.findFirst({
        where: eq(users.id, ctx.user.userId),
      });
      if (!me) {
        throw new TRPCError({ code: "NOT_FOUND", message: "用戶不存在" });
      }

      // 連結同時記低 Google email／名稱快照（2026-08-04：後台會員詳情顯示用）
      const data: Partial<typeof users.$inferInsert> = {
        googleSub: sub,
        googleEmail: email,
        googleName: gName,
      };
      // 自己 email 空、而 Google email 又冇人用的話 → 順手補埋（忘記密碼都用得著）
      if (!me.email) {
        const emailDup = await db.query.users.findFirst({
          where: eq(users.email, email),
        });
        if (!emailDup) data.email = email;
      }
      await db.update(users).set(data).where(eq(users.id, me.id));
      void logAudit({
        actorId: me.id,
        actorRole: me.role,
        actorNameFallback: me.name,
        action: "member.linkGoogle",
        targetType: "member",
        targetId: me.id,
        detail: `會員「${me.name}」連結 Google 帳號（${email}）`,
      });
      const user = await db.query.users.findFirst({
        where: eq(users.id, me.id),
      });
      return publicUser(user!);
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
        // 電話（2026-08-04 加）：主要畀 Google 開戶（g- 佔位）嘅會員補填真電話；
        // 一般會員改電話都行（電話係登入帳號，改完要用新號登入）
        phone: z.string().min(4).max(32).optional(),
        // Email（2026-08-03 加）：傳 null 或空字串＝清除；有值要撞檢查
        email: z.string().trim().email("Email 格式唔啱").max(255).nullable().optional(),
        address: z.string().nullable().optional(),
        // 預設取貨方式（2026-08-08 Glo 要求）：送貨上門／順豐站／智能櫃；站點傳 null／空＝清除
        deliveryMethod: z.enum(["address", "sf_station", "sf_locker"]).optional(),
        pickupPoint: z.string().max(255).nullable().optional(),
        age: z.number().int().min(1).max(120).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      // 2026-08-04（Glo 要求）：Google 開戶嘅帳號 email 鎖死跟 Google 電郵，唔俾改。
      // 判斷同 publicUser.emailLocked 一致：已連結 Google，而且帳號 email 同 Google 電郵一致。
      // （傳返原值落嚟當冇改過，照過；想改走／清走就即場擋）
      const me = await db.query.users.findFirst({
        where: eq(users.id, ctx.user.userId),
      });
      if (!me) {
        throw new TRPCError({ code: "NOT_FOUND", message: "用戶不存在" });
      }
      const emailLocked =
        me.googleSub != null &&
        me.email != null &&
        me.googleEmail != null &&
        me.email.toLowerCase() === me.googleEmail.toLowerCase();
      if (emailLocked && input.email !== undefined) {
        const currentEmail = (me.email ?? "").toLowerCase();
        const nextEmail = input.email?.trim().toLowerCase() || null;
        if (nextEmail !== currentEmail) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Google 帳號嘅電郵唔可以更改",
          });
        }
      }
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
      if (input.phone !== undefined) {
        // 同註冊同一套正規化＋撞檢查（連埋 852 前綴變體）；撞自己冇所謂
        const phone = normalizePhone(input.phone);
        const dup = await db.query.users.findFirst({
          where: inArray(users.phone, phoneLookupVariants(input.phone)),
        });
        if (dup && dup.id !== ctx.user.userId) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "呢個電話號碼已經綁咗其他帳號",
          });
        }
        data.phone = phone;
      }
      if (input.address !== undefined) data.address = input.address;
      if (input.deliveryMethod !== undefined) {
        data.deliveryMethod = input.deliveryMethod;
        // 改做送貨上門又冇一併傳站點 → 清走舊站點，唔好留殘舊資料
        if (input.deliveryMethod === "address" && input.pickupPoint === undefined) {
          data.pickupPoint = null;
        }
      }
      if (input.pickupPoint !== undefined) data.pickupPoint = input.pickupPoint?.trim() || null;
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
      // B-2（2026-08-06 WMS 對接）：會員資料有變 → 同步去 WMS（fire-and-forget，失敗唔阻流程）
      void forwardMemberToWms(ctx.user.userId).catch((e) => console.error("[wms] member sync error:", e));
      return publicUser(user);
    }),

  // 直接促銷同意開關（2026-08-05 Glo 要求，PDPO 第 6A 部）：
  // 會員中心可以自己隨時開/關；開＝記新同意時間（marketingOptInAt），
  // 關＝保留當初同意紀錄唔郁（舉證用），動作記落操作日誌；
  // 關咗之後後台「促銷電郵」唔會再寄畀佢
  setMarketingOptIn: authedProcedure
    .input(z.object({ optIn: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const me = await db.query.users.findFirst({
        where: eq(users.id, ctx.user.userId),
      });
      if (!me) {
        throw new TRPCError({ code: "NOT_FOUND", message: "用戶不存在" });
      }
      const data: Partial<typeof users.$inferInsert> = {
        marketingOptIn: input.optIn,
      };
      // 由唔同意→同意先記新同意時間；撤回時保留原紀錄，日誌已記低撤回動作
      if (input.optIn && !me.marketingOptIn) {
        data.marketingOptInAt = new Date();
      }
      await db.update(users).set(data).where(eq(users.id, me.id));
      void logAudit({
        actorId: me.id,
        actorRole: me.role,
        actorNameFallback: me.name,
        action: "member.setMarketingOptIn",
        targetType: "member",
        targetId: me.id,
        detail: `會員「${me.name}」${input.optIn ? "開啟" : "關閉"}推廣資訊接收`,
      });
      const user = await db.query.users.findFirst({
        where: eq(users.id, me.id),
      });
      // B-2（2026-08-06 WMS 對接）：會員資料有變 → 同步去 WMS（fire-and-forget，失敗唔阻流程）
      void forwardMemberToWms(me.id).catch((e) => console.error("[wms] member sync error:", e));
      return publicUser(user!);
    }),

  // 一次性推廣同意彈窗嘅回答（2026-08-06 Glo 要求）：
  // 無論接受定唔接受都記 marketingPromptedAt=now → 唔再彈；
  // 接受先更新 marketingOptInAt（PDPO 舉證）；唔接受唔郁舊紀錄。
  respondMarketingPrompt: authedProcedure
    .input(z.object({ optIn: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const me = await db.query.users.findFirst({
        where: eq(users.id, ctx.user.userId),
      });
      if (!me) {
        throw new TRPCError({ code: "NOT_FOUND", message: "用戶不存在" });
      }
      const now = new Date();
      const data: Partial<typeof users.$inferInsert> = {
        marketingOptIn: input.optIn,
        marketingPromptedAt: now,
      };
      if (input.optIn) data.marketingOptInAt = now;
      await db.update(users).set(data).where(eq(users.id, me.id));
      void logAudit({
        actorId: me.id,
        actorRole: me.role,
        actorNameFallback: me.name,
        action: "member.respondMarketingPrompt",
        targetType: "member",
        targetId: me.id,
        detail: `會員「${me.name}」喺推廣同意彈窗揀咗「${input.optIn ? "接受" : "唔接受"}」推廣資訊`,
      });
      const user = await db.query.users.findFirst({
        where: eq(users.id, me.id),
      });
      // B-2（2026-08-06 WMS 對接）：會員資料有變 → 同步去 WMS（fire-and-forget，失敗唔阻流程）
      void forwardMemberToWms(me.id).catch((e) => console.error("[wms] member sync error:", e));
      return publicUser(user!);
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
