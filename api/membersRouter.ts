import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { cartItems, orderItems, orders, paymentProofs, pushSubscriptions, users, wmsSyncLog } from "@db/schema";
import { createRouter, adminProcedure, staffProcedure } from "./middleware";
import { logAudit } from "./audit";
import { hashPassword } from "./auth";
import { requestApprovalIfStaff } from "./approvalGuard";
import { forwardMemberToWms } from "./wmsMemberSync";
import { sendVipUpgradeEmail, siteUrl } from "./email";
import { buildVipVerifyUrl } from "./vipCert";
import { getVipRules } from "./vip";

/**
 * v2.2.0（合約 §9）：userAgent → 裝置描述（「iPhone・Safari」款）。
 * server 端統一 parse（官網後台 adminGetPushStatus 同 WMS member-admin 共用，口徑一致）；
 * 純字串比對，永遠唔會 throw；唔識分就回「不明裝置」。
 */
export function deviceLabelFromUserAgent(ua: string | null): string {
  if (!ua) return "不明裝置";
  let device = "電腦";
  if (/iPhone/i.test(ua)) device = "iPhone";
  else if (/iPad/i.test(ua)) device = "iPad";
  else if (/Android/i.test(ua)) device = /Mobile/i.test(ua) ? "Android 手機" : "Android 平板";
  else if (/Windows/i.test(ua)) device = "Windows 電腦";
  else if (/Macintosh|Mac OS X/i.test(ua)) device = "Mac 電腦";
  else if (/Linux/i.test(ua)) device = "Linux 電腦";
  // 次序有講究：Edge／Chrome UA 都帶 "Safari" 字樣，要先排除
  let browser = "瀏覽器";
  if (/Edg(e|A|iOS)?\//i.test(ua)) browser = "Edge";
  else if (/CriOS|Chrome\//i.test(ua)) browser = "Chrome";
  else if (/FxiOS|Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Safari\//i.test(ua)) browser = "Safari";
  return `${device}・${browser}`;
}

/**
 * v2.2.43（老闆指令：後台新增「綁定手機清單」，要「裝置廠牌」同「瀏覽器」分開兩欄）：
 * UA → { brand, browser }。純字串比對，永遠唔 throw；唔識分就回「其他」款。
 * 同上面 deviceLabelFromUserAgent 分開——舊嗰個會員詳情／WMS 仲用緊，一字唔郁。
 * Android 機多數帶型號（Android 14; SM-S918B），抽出嚟對廠牌對照表；
 * Apple 機 UA 冇型號，廠牌即 Apple。
 */
export function deviceInfoFromUserAgent(ua: string | null): { brand: string; browser: string } {
  if (!ua) return { brand: "不明", browser: "不明" };

  // ── 廠牌 ──
  let brand = "不明";
  if (/iPhone/i.test(ua)) brand = "Apple iPhone";
  else if (/iPad/i.test(ua)) brand = "Apple iPad";
  else if (/Macintosh|Mac OS X/i.test(ua)) brand = "Apple Mac";
  else if (/Windows/i.test(ua)) brand = "Windows 電腦";
  else if (/Android/i.test(ua)) {
    // 抽型號段：Android 14; SM-S918B）→ 對照常見廠牌；對唔上叫「其他 Android」
    const model = /Android [\d.]+;\s*([^;)]+)/i.exec(ua)?.[1]?.trim() ?? "";
    if (/^SM-|SAMSUNG/i.test(model)) brand = "Samsung";
    else if (/^Pixel/i.test(model)) brand = "Google Pixel";
    else if (/^(Redmi|POCO|Mi |MIX )/i.test(model)) brand = "Xiaomi";
    else if (/HUAWEI/i.test(model) || /HUAWEI/i.test(ua)) brand = "Huawei";
    else if (/HONOR/i.test(model)) brand = "Honor";
    else if (/^(OPPO|CPH)/i.test(model)) brand = "OPPO";
    else if (/^(vivo|IQOO|V2\d{3})/i.test(model)) brand = "vivo";
    else if (/^OnePlus/i.test(model)) brand = "OnePlus";
    else if (/^(XQ-|SO-)/i.test(model)) brand = "Sony";
    else if (/^(LG-|LM-)/i.test(model)) brand = "LG";
    else if (/^(Moto|motorola)/i.test(model)) brand = "Motorola";
    else if (/^Nothing/i.test(model)) brand = "Nothing";
    else brand = "其他 Android";
  } else if (/Linux/i.test(ua)) brand = "Linux 電腦";

  // ── 瀏覽器（次序有講究：in-app 先；Edge／Chrome UA 都帶 Safari 字樣要排尾）──
  let browser = "其他瀏覽器";
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) browser = "Facebook 內置";
  else if (/Instagram/i.test(ua)) browser = "Instagram 內置";
  else if (/MicroMessenger/i.test(ua)) browser = "微信內置";
  else if (/Line\//i.test(ua)) browser = "LINE 內置";
  else if (/SamsungBrowser/i.test(ua)) browser = "Samsung Internet";
  else if (/Edg(e|A|iOS)?\//i.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(ua)) browser = "Opera";
  else if (/CriOS|Chrome\//i.test(ua)) browser = "Chrome";
  else if (/FxiOS|Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Safari\//i.test(ua)) browser = "Safari";

  return { brand, browser };
}

/**
 * v2.2.0（合約 §9）：會員直播推送狀態（membersRouter.adminGetPushStatus 同
 * api/wmsMemberAdmin.ts get action 共用，兩邊睇到嘅嘢一致）。
 * 淨回 id／deviceLabel／綁定時間／最近推送；endpoint／p256dh／auth 永遠唔回前端、唔落 log。
 */
export async function getMemberPushStatus(userId: number): Promise<{
  optIn: boolean;
  devices: { id: number; deviceLabel: string; boundAt: string; lastSentAt: string | null }[];
}> {
  const db = getDb();
  const [me] = await db
    .select({ livePushOptIn: users.livePushOptIn })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const rows = await db.query.pushSubscriptions.findMany({
    where: and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.active, true)),
    columns: { id: true, userAgent: true, createdAt: true, lastSentAt: true },
    orderBy: [desc(pushSubscriptions.createdAt)],
  });
  return {
    optIn: me?.livePushOptIn ?? false,
    devices: rows.map((r) => ({
      id: r.id,
      deviceLabel: deviceLabelFromUserAgent(r.userAgent),
      boundAt: r.createdAt.toISOString(),
      lastSentAt: r.lastSentAt ? r.lastSentAt.toISOString() : null,
    })),
  };
}

/** 由 userId 攞顯示名（audit detail 要落管理員名；搵唔到就「#id」兜底） */
async function userNameOf(userId: number): Promise<string> {
  const db = getDb();
  const [u] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u?.name ?? `#${userId}`;
}

/**
 * 會員列表 —— staff（員工）＋ admin 可用（2026-07-29 起：員工都可以睇同改會員資料）
 * totalSpent 排除 cancelled/rejected；按註冊時間 createdAt desc
 * update：修改會員基本資料（名/電話/email/地址/年齡/生日月份），電話撞號會 CONFLICT
 * resetPassword：幫會員重設密碼（2026-08-03 加；會員唔記得密碼時用，即時生效）
 * remove：刪除會員（仍係 admin only）；有訂單嘅會員要 alsoDeleteOrders=true 先刪得（連訂單一併刪，唔可以復原）
 */
export const membersRouter = createRouter({
  // 2026-07-28：加搜尋（q＝名或電話模糊對照）＋地址欄
  list: staffProcedure
    .input(z.object({ q: z.string().trim().max(100).optional() }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      const q = input?.q?.trim();
      // 用家輸入嘅 % / _ / \ 先 escape，唔畀佢哋變通配符
      const term = q ? `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
      return db
        .select({
          id: users.id,
          name: users.name,
          phone: users.phone,
          email: users.email,
          address: users.address,
          birthMonth: users.birthMonth,
          createdAt: users.createdAt,
          // Google 連結狀態（2026-08-04 Glo 要求：後台列表用顏色標示）：淨係出 boolean，sub 本身唔出
          googleLinked: sql<boolean>`(${users.googleSub} is not null)`,
          // 直接促銷同意（2026-08-05 Glo 要求：列表睇到客戶接唔接受推廣）
          marketingOptIn: users.marketingOptIn,
          marketingPromptedAt: users.marketingPromptedAt,
          // v2.1.0（VIP+免運）：列表直接睇到級別＋到期（後台會員列表「級別」欄用）
          vipTier: users.vipTier,
          vipExpiresAt: users.vipExpiresAt,
          // v2.2.0（合約 §9）：列表睇埋會員有無接收直播開播推播通知
          livePushOptIn: users.livePushOptIn,
          // v2.2.13（老闆指令）：列表睇埋會員有冇訂閱推播通知（幾多部裝置訂閱緊）
          // 鐵律：endpoint/p256dh/auth 永遠唔准回前端——淨係回 count 數字
          pushSubCount: sql<number>`(select count(*)::int from "pushSubscriptions" ps where ps."userId" = ${users.id} and ps.active)`,
          orderCount: sql<number>`count(${orders.id})::int`,
          totalSpent: sql<number>`coalesce(sum(${orders.total}) filter (where ${orders.status} not in ('cancelled', 'rejected')), 0)::int`,
        })
        .from(users)
        .leftJoin(orders, eq(orders.userId, users.id))
        .where(
          term
            ? and(
                eq(users.role, "member"),
                sql`(${users.name} ilike ${term} escape '\\' or ${users.phone} ilike ${term} escape '\\')`,
              )
            : eq(users.role, "member"),
        )
        .groupBy(users.id)
        .orderBy(desc(users.createdAt));
    }),

  /**
   * 會員詳情（前台撳行彈出）：基本資料（唔回 passwordHash）＋訂單統計＋最近 10 張訂單
   */
  detail: staffProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [user] = await db
        .select({
          id: users.id,
          name: users.name,
          phone: users.phone,
          email: users.email,
          address: users.address,
          age: users.age,
          birthMonth: users.birthMonth,
          role: users.role,
          createdAt: users.createdAt,
          // Google 連結資料（2026-08-04 Glo 要求：會員詳情顯示 Google email＋名稱）
          googleLinked: sql<boolean>`(${users.googleSub} is not null)`,
          googleEmail: users.googleEmail,
          googleName: users.googleName,
          // 直接促銷同意（2026-08-05 Glo 要求：詳細會員資料都要睇到）
          marketingOptIn: users.marketingOptIn,
          marketingOptInAt: users.marketingOptInAt,
          marketingPromptedAt: users.marketingPromptedAt,
          // v2.1.0（VIP+免運）：會員詳情睇埋 VIP 級別＋生效／到期
          vipTier: users.vipTier,
          vipEffectiveAt: users.vipEffectiveAt,
          vipExpiresAt: users.vipExpiresAt,
          // v2.2.0（合約 §9）：會員詳情睇埋直播推送同意狀態
          livePushOptIn: users.livePushOptIn,
        })
        .from(users)
        .where(eq(users.id, input.id))
        .limit(1);
      if (!user || user.role !== "member") {
        throw new TRPCError({ code: "NOT_FOUND", message: "會員唔存在" });
      }
      const [stats] = await db
        .select({
          orderCount: sql<number>`count(${orders.id})::int`,
          totalSpent: sql<number>`coalesce(sum(${orders.total}) filter (where ${orders.status} not in ('cancelled', 'rejected')), 0)::int`,
        })
        .from(orders)
        .where(eq(orders.userId, input.id));
      const recentOrders = await db
        .select({
          id: orders.id,
          orderNo: orders.orderNo,
          status: orders.status,
          total: orders.total,
          deliveryMethod: orders.deliveryMethod,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(eq(orders.userId, input.id))
        .orderBy(desc(orders.createdAt))
        .limit(10);
      return {
        user,
        orderCount: stats.orderCount,
        totalSpent: stats.totalSpent,
        recentOrders,
      };
    }),

  /**
   * 修改會員資料（員工＋管理員，2026-07-29）：名/電話/email/地址/年齡/生日月份
   * 淨係改有傳嘅欄；email/地址/年齡/生日月份傳 null＝清空；電話撞咗人哋嘅號會 CONFLICT
   */
  update: staffProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().trim().min(1, "名稱必填").max(255).optional(),
        phone: z
          .string()
          .trim()
          .min(8, "電話至少 8 位")
          .max(32)
          .regex(/^[0-9+\-\s]+$/, "電話格式唔啱")
          .optional(),
        email: z.string().trim().email("Email 格式唔啱").max(255).nullable().optional(),
        address: z.string().nullable().optional(),
        age: z.number().int().min(0).max(150).nullable().optional(),
        birthMonth: z.number().int().min(1).max(12).nullable().optional(),
        marketingOptIn: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [target] = await db
        .select({ id: users.id, role: users.role, name: users.name })
        .from(users)
        .where(eq(users.id, input.id))
        .limit(1);
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "會員唔存在" });
      }
      if (target.role !== "member") {
        throw new TRPCError({ code: "FORBIDDEN", message: "員工帳號請去「員工帳號」頁修改" });
      }
      if (input.phone) {
        const dup = await db.query.users.findFirst({ where: eq(users.phone, input.phone) });
        if (dup && dup.id !== input.id) {
          throw new TRPCError({ code: "CONFLICT", message: "呢個電話號碼已經註冊咗" });
        }
      }
      // 撞 email 檢查（2026-08-03 補；email 有 unique 索引，撞咗 DB 會炸 500，要先擋）
      if (input.email) {
        const emailNorm = input.email.toLowerCase();
        const dup = await db.query.users.findFirst({ where: eq(users.email, emailNorm) });
        if (dup && dup.id !== input.id) {
          throw new TRPCError({ code: "CONFLICT", message: "呢個 Email 已經綁咗其他帳號" });
        }
      }
      // 員工操作需審批（2026-08-06 Glo 要求）：staff 唔直接執行，開審批單等主管/管理員批准
      if (ctx.user.role === "staff") {
        const [before] = await db
          .select({
            name: users.name, phone: users.phone, email: users.email,
            address: users.address, age: users.age, birthMonth: users.birthMonth,
            marketingOptIn: users.marketingOptIn,
          })
          .from(users)
          .where(eq(users.id, input.id))
          .limit(1);
        const pending = await requestApprovalIfStaff({
          user: ctx.user,
          action: "member.update",
          payload: { input, before: before ?? null },
          summary: `修改會員 #${input.id}「${target.name}」資料`,
        });
        if (pending) return pending;
      }
      const data: Partial<typeof users.$inferInsert> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.phone !== undefined) data.phone = input.phone;
      if (input.email !== undefined) data.email = input.email ? input.email.toLowerCase() : null;
      if (input.address !== undefined) data.address = input.address;
      if (input.age !== undefined) data.age = input.age;
      if (input.birthMonth !== undefined) data.birthMonth = input.birthMonth;
      // 推廣同意（2026-08-06 Glo 要求）：員工可喺會員詳情人手設定接受／唔接受；
      // 人手設定＝已表態，寫 marketingPromptedAt，會員唔會再見到彈窗
      if (input.marketingOptIn !== undefined) {
        data.marketingOptIn = input.marketingOptIn;
        if (input.marketingOptIn) data.marketingOptInAt = new Date();
        data.marketingPromptedAt = new Date();
      }
      if (Object.keys(data).length > 0) {
        await db.update(users).set(data).where(eq(users.id, input.id));
      }
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "member.update",
        targetType: "member",
        targetId: input.id,
        detail: `修改會員「${input.name ?? target.name}」資料（${Object.keys(data).join("、") || "冇改動"}）`,
      });
      // B-2（2026-08-06 WMS 對接）：會員資料有變 → 同步去 WMS（fire-and-forget，失敗唔阻流程）
      void forwardMemberToWms(input.id).catch((e) => console.error("[wms] member sync error:", e));
      return { ok: true };
    }),

  /**
   * 幫會員重設密碼（員工＋管理員，2026-08-03 加）
   * 會員唔記得密碼搵客服時用：唔使舊密碼，新密碼即時生效；
   * 只可以改 member 帳號（員工帳號去「員工帳號」頁）；動作會記落操作日誌
   */
  resetPassword: staffProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        newPassword: z.string().min(6, "新密碼至少 6 位").max(64),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [target] = await db
        .select({ id: users.id, role: users.role, name: users.name })
        .from(users)
        .where(eq(users.id, input.id))
        .limit(1);
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "會員唔存在" });
      }
      if (target.role !== "member") {
        throw new TRPCError({ code: "FORBIDDEN", message: "員工帳號請去「員工帳號」頁修改" });
      }
      await db
        .update(users)
        .set({ passwordHash: hashPassword(input.newPassword) })
        .where(eq(users.id, input.id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "member.resetPassword",
        targetType: "member",
        targetId: input.id,
        detail: `重設會員「${target.name}」密碼`,
      });
      return { ok: true };
    }),

  /**
   * v2.1.0（VIP+免運）：管理員手動改會員 VIP 級別（admin 專用）。
   * 用途：特事特辦（例如大客／公關單）唔使等年度消費達標。
   * ─ tier=NONE：清走級別（生效／到期時間一併清）
   * ─ tier=SILVER/GOLD：expiresAt 必填（手動改級唔會自動計期限，管理員話事）；
   *   vipEffectiveAt 寫而家
   * 下次訂單確認後 recomputeVipTier 會按規則重判——期限內唔會被降級（規則照顧咗）。
   * 動作記落操作日誌（action: member.setVipTier）。
   */
  setVipTier: adminProcedure
    .input(
      z.object({
        userId: z.number().int().positive(),
        tier: z.enum(["NONE", "SILVER", "GOLD"]),
        // 升級必填到期日；NONE 會忽略呢個欄
        expiresAt: z.coerce.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [target] = await db
        .select({ id: users.id, role: users.role, name: users.name, email: users.email, phone: users.phone, vipTier: users.vipTier })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "會員唔存在" });
      }
      if (target.role !== "member") {
        throw new TRPCError({ code: "FORBIDDEN", message: "員工帳號唔可以喺會員管理改 VIP 級別" });
      }
      if (input.tier !== "NONE" && !input.expiresAt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "設定 VIP 級別要填到期日" });
      }
      if (input.tier !== "NONE" && input.expiresAt!.getTime() <= Date.now()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "到期日要係將來嘅時間" });
      }
      // v2.1.1（Wave 2）：手動升級（new rank > old rank）都要寄 VIP 晉升恭賀信；
      // 同級改期／降級唔寄。DB commit 完先 void 寄，寄信失敗唔影響操作。
      const rankOf = (t: string) => (t === "GOLD" ? 2 : t === "SILVER" ? 1 : 0);
      const isUpgrade = rankOf(input.tier) > rankOf(target.vipTier);
      // v2.2.0 門檻凍結：升級（發證書嗰啲 transition）先寫「升級嗰刻嘅門檻」快照；
      // 降級／清級／同級改期唔郁舊快照（歷史留念）
      const upgradeRules = isUpgrade ? await getVipRules() : null;
      await db
        .update(users)
        .set(
          input.tier === "NONE"
            ? { vipTier: "NONE", vipEffectiveAt: null, vipExpiresAt: null }
            : {
                vipTier: input.tier,
                vipEffectiveAt: new Date(),
                vipExpiresAt: input.expiresAt!,
                ...(upgradeRules
                  ? {
                      vipThresholdCents:
                        input.tier === "GOLD"
                          ? upgradeRules.goldThresholdCents
                          : upgradeRules.silverThresholdCents,
                    }
                  : {}),
              },
        )
        .where(eq(users.id, input.userId));
      if (isUpgrade && target.email) {
        const rules = await getVipRules();
        const memberNo = `RC-${String(target.id).padStart(6, "0")}`;
        void sendVipUpgradeEmail({
          to: target.email,
          name: target.name,
          tier: input.tier as "SILVER" | "GOLD",
          effectiveAt: new Date(),
          expiresAt: input.expiresAt!,
          memberNo,
          phone: target.phone ?? null,
          // v2.2.0 證書版：證書附件要齊門檻（呢級嘅年度消費門檻，整數仙）／期限／驗證連結
          thresholdCents: input.tier === "GOLD" ? rules.goldThresholdCents : rules.silverThresholdCents,
          durationMonths: rules.durationMonths,
          verifyUrl: buildVipVerifyUrl(siteUrl(), memberNo),
        }).then((r) => {
          if (!r.ok) console.error(`[vip] 手動升級恭賀信寄唔出（會員 #${input.userId} → ${input.tier}）：`, r.error);
        }).catch((e) => console.error("[vip] 手動升級恭賀信寄送錯誤:", e));
      }
      const tierLabel = input.tier === "GOLD" ? "金會員" : input.tier === "SILVER" ? "銀會員" : "普通會員";
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "member.setVipTier",
        targetType: "member",
        targetId: input.userId,
        detail: `手動設定會員「${target.name}」VIP 級別：${target.vipTier} → ${input.tier}（${tierLabel}${input.tier === "NONE" ? "" : `，到期 ${input.expiresAt!.toISOString().slice(0, 10)}`}）`,
      });
      // v2.2.0：手動改 VIP 級別成功（升／降／清級都計）→ 推送最新級別去 WMS
      // （fire-and-forget，失敗淨 log 唔阻操作）
      void forwardMemberToWms(input.userId).catch((e) => console.error("[wms] VIP 級別同步 error:", e));
      return { ok: true };
    }),

  /**
   * v2.2.0：管理員人手將全部 VIP 會員（vipTier ∈ SILVER/GOLD）嘅級別批量推送去 WMS。
   * 用途：WMS 嗰邊加咗 vipTier／vipExpiresAt 欄之後，一次性補返現有 VIP 會員嘅級別。
   * ─ 逐個推（receiveMember 用 phone upsert，idempotent，重複推唔怕）；
   * ─ 錯誤逐個收集：一個衰唔會停晒成批（best-effort，同開機回填同款做法）；
   * ─ 每 20 位抖半秒，唔好一次過打晒落 WMS（佢免費 plan 冷啟動會慢）；
   * ─ log／回傳淨係錯誤訊息，永遠唔准落 apiKey（老闆鐵律：秘密落 log 必須遮罩）。
   */
  syncVipTiersToWms: adminProcedure.mutation(async ({ ctx }) => {
    const db = getDb();
    const vipMembers = await db.query.users.findMany({
      where: and(
        eq(users.role, "member"),
        inArray(users.vipTier, ["SILVER", "GOLD"]),
      ),
      columns: { id: true },
    });
    let pushed = 0;
    let skipped = 0;
    const failures: { userId: number; error: string }[] = [];
    for (const m of vipMembers) {
      const r = await forwardMemberToWms(m.id);
      if (r.ok) {
        pushed++;
      } else if (r.skipped) {
        skipped++; // g- 佔位電話等：唔算失敗，補咗真電話嗰次自然會推
      } else {
        failures.push({ userId: m.id, error: r.error ?? "unknown" });
      }
      // 每 20 位抖半秒，唔好一次過打晒落 WMS
      if ((pushed + skipped + failures.length) % 20 === 0) {
        await new Promise((res) => setTimeout(res, 500));
      }
    }
    if (failures.length > 0) {
      console.error(
        `[wms] VIP 級別批量同步有 ${failures.length} 位失敗:`,
        failures.map((f) => `#${f.userId} ${f.error}`).join("；"),
      );
    }
    void logAudit({
      actorId: ctx.user.userId,
      actorRole: ctx.user.role,
      action: "member.syncVipTiersToWms",
      targetType: "member",
      detail: `批量同步 VIP 級別去 WMS：共 ${vipMembers.length} 位，成功 ${pushed}、略過 ${skipped}、失敗 ${failures.length}`,
    });
    return { ok: true, total: vipMembers.length, pushed, skipped, failures };
  }),

  remove: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        // 會員有訂單時，必須明確授權先可以連訂單一併刪除（預設擋住，保住營業數據）
        alsoDeleteOrders: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      if (input.id === ctx.user.userId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "唔可以刪除自己嘅帳號" });
      }
      const [target] = await db
        .select({ id: users.id, role: users.role, name: users.name })
        .from(users)
        .where(eq(users.id, input.id))
        .limit(1);
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "會員唔存在" });
      }
      if (target.role !== "member") {
        throw new TRPCError({ code: "FORBIDDEN", message: "員工帳號唔可以喺會員管理刪除" });
      }
      const orderRows = await db
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.userId, input.id));
      if (orderRows.length > 0 && !input.alsoDeleteOrders) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `「${target.name}」有 ${orderRows.length} 張訂單，刪除會連埋訂單一齊冇晒，請確認先好再撳`,
        });
      }
      if (orderRows.length > 0) {
        // 先刪晒啲 child rows（FK 冇 cascade），順序：同步記錄 → 截圖 → 明細 → 訂單
        const ids = orderRows.map((r) => r.id);
        await db.delete(wmsSyncLog).where(inArray(wmsSyncLog.orderId, ids));
        await db.delete(paymentProofs).where(inArray(paymentProofs.orderId, ids));
        await db.delete(orderItems).where(inArray(orderItems.orderId, ids));
        await db.delete(orders).where(eq(orders.userId, input.id));
      }
      await db.delete(cartItems).where(eq(cartItems.userId, input.id));
      // v2.2.22（老闆報障）：pushSubscriptions.userId 有 FK 連住 users（無 cascade）——
      // 會員一訂閱直播通知就會被資料庫擋住刪除。連埋裝置一併刪；
      // 安全鐵律：endpoint／p256dh／auth 永遠唔回前端、唔落 log，淨係計數。
      const removedDevices = await db
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, input.id))
        .returning({ id: pushSubscriptions.id });
      try {
        await db.delete(users).where(eq(users.id, input.id));
      } catch {
        // 防禦：日後新表再加 FK 都唔會將 raw SQL 彈出管理後台
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "呢個會員仲有其他紀錄連住，暫時刪唔到，請通知技術員處理",
        });
      }
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "member.remove",
        targetType: "member",
        targetId: input.id,
        detail: `刪除會員「${target.name}」${orderRows.length > 0 ? `（連埋 ${orderRows.length} 張訂單）` : ""}${removedDevices.length > 0 ? `（連埋 ${removedDevices.length} 部推播裝置）` : ""}`,
      });
      return { ok: true, id: input.id, deletedOrders: orderRows.length, removedDevices: removedDevices.length };
    }),

  // ─── v2.2.1（合約 §9）：會員直播推送管理（admin 專用）────────────────────
  // 官網後台會員卡「直播推送」段用；WMS 嗰邊行 /api/wms/member-admin（共用 getMemberPushStatus）。
  // 安全鐵律：endpoint／p256dh／auth 永遠唔回前端、唔落 log。

  /** 睇會員有無接收直播推播通知＋已綁定裝置清單 */
  adminGetPushStatus: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [target] = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      if (!target || target.role !== "member") {
        throw new TRPCError({ code: "NOT_FOUND", message: "會員唔存在" });
      }
      return getMemberPushStatus(input.userId);
    }),

  /** v2.2.43（老闆指令）：全店「綁定手機清單」——客戶名／幾時綁定／裝置廠牌／用咩瀏覽器
   *  一覽，唔使逐個會員入詳情先睇到。淨回非敏感欄位；
   *  endpoint／p256dh／auth 永遠唔回前端、唔落 log（安全鐵律）。 */
  adminListPushDevices: adminProcedure.query(async () => {
    const db = getDb();
    const rows = await db
      .select({
        id: pushSubscriptions.id,
        userAgent: pushSubscriptions.userAgent,
        createdAt: pushSubscriptions.createdAt,
        lastSentAt: pushSubscriptions.lastSentAt,
        customerName: users.name,
        customerPhone: users.phone,
        customerEmail: users.email,
      })
      .from(pushSubscriptions)
      .innerJoin(users, eq(pushSubscriptions.userId, users.id))
      .where(eq(pushSubscriptions.active, true))
      .orderBy(desc(pushSubscriptions.createdAt))
      .limit(500);
    return rows.map((r) => {
      const info = deviceInfoFromUserAgent(r.userAgent);
      return {
        id: r.id,
        customerName: r.customerName,
        customerPhone: r.customerPhone,
        customerEmail: r.customerEmail,
        brand: info.brand,
        browser: info.browser,
        boundAt: r.createdAt.toISOString(),
        lastSentAt: r.lastSentAt ? r.lastSentAt.toISOString() : null,
      };
    });
  }),

  /** 幫會員踢走一部已綁定裝置（where id＋userId＋active，唔會郁到別人嘅機） */
  adminRemovePushDevice: adminProcedure
    .input(
      z.object({
        userId: z.number().int().positive(),
        deviceId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [target] = await db
        .select({ id: users.id, role: users.role, name: users.name })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      if (!target || target.role !== "member") {
        throw new TRPCError({ code: "NOT_FOUND", message: "會員唔存在" });
      }
      const updated = await db
        .update(pushSubscriptions)
        .set({ active: false })
        .where(
          and(
            eq(pushSubscriptions.id, input.deviceId),
            eq(pushSubscriptions.userId, input.userId),
            eq(pushSubscriptions.active, true),
          ),
        )
        .returning({ id: pushSubscriptions.id });
      if (updated.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "裝置唔存在或已移除" });
      }
      // 冇 active 裝置就 optIn=false（同意狀態跟實際綁定走，同客戶自己踢機同款規則）
      const remaining = await db.query.pushSubscriptions.findMany({
        where: and(
          eq(pushSubscriptions.userId, input.userId),
          eq(pushSubscriptions.active, true),
        ),
        columns: { id: true },
      });
      if (remaining.length === 0) {
        await db
          .update(users)
          .set({ livePushOptIn: false })
          .where(eq(users.id, input.userId));
      }
      // audit：淨落 id，endpoint 明文永遠唔准落 log
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "member.adminRemovePushDevice",
        targetType: "member",
        targetId: input.userId,
        detail: `管理員移除會員「${target.name}」嘅直播推送裝置（訂閱 #${input.deviceId}）；剩餘有效裝置 ${remaining.length} 部`,
      });
      // 同意狀態有機會變咗 → 同步去 WMS（fire-and-forget，失敗淨 log）
      void forwardMemberToWms(input.userId).catch((e) => console.error("[wms] member sync error:", e));
      return { ok: true, remainingDevices: remaining.length };
    }),

  /** 幫會員「拒絕接收」直播推送：optIn=false＋全部裝置註銷 */
  adminUnsubscribePush: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [target] = await db
        .select({ id: users.id, role: users.role, name: users.name })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      if (!target || target.role !== "member") {
        throw new TRPCError({ code: "NOT_FOUND", message: "會員唔存在" });
      }
      await db
        .update(users)
        .set({ livePushOptIn: false, livePushOptInAt: new Date() })
        .where(eq(users.id, input.userId));
      const deactivated = await db
        .update(pushSubscriptions)
        .set({ active: false })
        .where(
          and(
            eq(pushSubscriptions.userId, input.userId),
            eq(pushSubscriptions.active, true),
          ),
        )
        .returning({ id: pushSubscriptions.id });
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "member.adminUnsubscribePush",
        targetType: "member",
        targetId: input.userId,
        detail: `管理員幫會員「${target.name}」拒絕接收直播推送；註銷咗 ${deactivated.length} 部裝置`,
      });
      void forwardMemberToWms(input.userId).catch((e) => console.error("[wms] member sync error:", e));
      return { ok: true, removedDevices: deactivated.length };
    }),
});
