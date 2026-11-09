/**
 * 網站設計服務 tRPC router（v2026.11.09）——獨立訂單鏈，絕不掂普通 orders／orderItems。
 * Lead 會喺 api/router.ts 掛 `webDesign: webDesignRouter`（router.ts 唔喺我 ownership）。
 *
 * public：getCatalog／createOrder／lookup／attachProof／submitInquiry／createPayment
 * admin： adminCatalog／setCatalog
 * staff： adminOrders／retryWms／adminInquiries／markInquiryHandled
 * supervisor：reviewProof
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, ne } from "drizzle-orm";
import { getDb } from "./queries/connection";
import {
  siteSettings,
  webDesignInquiries,
  webDesignOrderItems,
  webDesignOrders,
  webDesignPaymentProofs,
} from "@db/schema";
import {
  WEB_DESIGN_CATALOG_SETTING_KEY,
  WEB_DESIGN_PLANS,
  type WebDesignCatalog,
} from "@contracts/webDesign";
import {
  adminProcedure,
  createRouter,
  publicProcedure,
  staffProcedure,
  supervisorProcedure,
} from "./middleware";
import { RateLimiter, clientIpFromRequest } from "./guestUtils";
import {
  WEB_DESIGN_LOOKUP_FAIL_MESSAGE,
  generateWebDesignOrderNo,
  isUniqueViolation,
  mergeCatalogWithDefaults,
  normalizeWebDesignPhone,
  priceOrder,
  validateCatalog,
  validateLookupInput,
} from "./webDesignCore";
import { deleteWebDesignOrderImage, generateWebDesignOrderImage } from "./webDesignImage";
import { forwardWebDesignOrderToWms } from "./webDesignWms";
import { getAirwallexConfig, createHostedPayment } from "./airwallex";
import { sendWebDesignInquiryEmail } from "./email";
import { logAudit } from "./audit";

// public 入口 rate limit（同訪客購物一套寬鬆口徑）
const lookupLimiter = new RateLimiter(10, 60 * 1000);
const createOrderLimiter = new RateLimiter(10, 60 * 1000);
const proofLimiter = new RateLimiter(10, 60 * 1000);
const inquiryLimiter = new RateLimiter(5, 60 * 1000);
const paymentLimiter = new RateLimiter(10, 60 * 1000);

function tooFrequent(): never {
  throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "操作太頻密，請一分鐘後再試" });
}

/** 讀 siteSettings 嘅 catalog JSON，合併預設（壞咗／冇 → 預設） */
async function loadCatalog(): Promise<WebDesignCatalog> {
  const db = getDb();
  const row = await db.query.siteSettings.findFirst({
    where: eq(siteSettings.key, WEB_DESIGN_CATALOG_SETTING_KEY),
  });
  if (!row) return mergeCatalogWithDefaults(null);
  try {
    return mergeCatalogWithDefaults(JSON.parse(row.value));
  } catch {
    return mergeCatalogWithDefaults(null);
  }
}

const nameSchema = z.string().trim().min(1, "姓名唔可以留空").max(64);
const phoneSchema = z.string().trim().min(1).max(32);
const emailSchema = z.string().trim().email("電郵格式唔啱").max(255);

const identityInput = {
  orderNo: z.string().trim().min(1).max(32),
  name: nameSchema,
  phone: phoneSchema,
};

/** 三欄核實：orderNo＋完整姓名＋normalized 電話；唔中 → 統一 NOT_FOUND（防枚舉） */
async function findOrderByIdentity(input: { orderNo: string; name: string; phone: string }) {
  const id = validateLookupInput(input.name, input.phone);
  if (!id) {
    throw new TRPCError({ code: "NOT_FOUND", message: WEB_DESIGN_LOOKUP_FAIL_MESSAGE });
  }
  const db = getDb();
  const order = await db.query.webDesignOrders.findFirst({
    where: and(
      eq(webDesignOrders.orderNo, input.orderNo),
      eq(webDesignOrders.name, id.name),
      eq(webDesignOrders.phone, id.phone),
    ),
  });
  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: WEB_DESIGN_LOOKUP_FAIL_MESSAGE });
  }
  return order;
}

export const webDesignRouter = createRouter({
  /** 公開目錄：siteSettings JSON 合併預設（validate 過先出街） */
  getCatalog: publicProcedure.query(async (): Promise<WebDesignCatalog> => {
    return loadCatalog();
  }),

  /**
   * 落單：server 以 DB catalog 重新計價（唔信 browser 金額）＋方案依賴再擋；
   * 先產正式訂單圖（sharp PNG）再 transaction 寫 order＋items 快照——
   * 產圖失敗＝落單明確失敗（未寫 DB，唔會有半張單）；DB 寫入失敗會清返張孤兒圖；
   * orderNo 撞號（unique violation）先 retry，其他 DB 錯誤即刻失敗。
   */
  createOrder: publicProcedure
    .input(
      z.object({
        plan: z.enum(WEB_DESIGN_PLANS),
        itemKeys: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
        name: nameSchema,
        phone: phoneSchema,
        email: emailSchema.optional(),
        requirements: z.string().max(2000).default(""),
        styleNotes: z.string().max(2000).default(""),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!createOrderLimiter.allow(clientIpFromRequest(ctx.req))) tooFrequent();
      const phone = normalizeWebDesignPhone(input.phone);
      if (!phone) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "電話格式唔啱（要香港 8 位數字）" });
      }
      const catalog = await loadCatalog();
      const priced = priceOrder(catalog, input.plan, input.itemKeys);
      if (!priced.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: priced.error });
      }
      const db = getDb();
      // 落單＝訂單＋items＋正式訂單圖，三件事齊先算成功（用戶硬要求：落單後必有正式訂單圖）：
      //   ① 先抽 orderNo＋產圖（圖入面有單號，所以要跟號生）；
      //   ② 圖失敗 → 明確落單失敗（未寫 DB，唔會有半張單）；
      //   ③ 圖好咗先開 transaction 寫 order＋items（同事務，唔會半套）；
      //   ④ orderNo 撞號（pg 23505 unique violation）先 retry——其他 DB 錯誤即刻失敗，
      //      兼清返張孤兒圖，唔會亂 retry 三次。
      let created: typeof webDesignOrders.$inferSelect | null = null;
      let orderImagePath: string | null = null;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3 && !created; attempt++) {
        const orderNo = generateWebDesignOrderNo();
        let imagePath: string;
        try {
          imagePath = await generateWebDesignOrderImage({
            orderNo,
            plan: input.plan,
            name: input.name,
            phone,
            email: input.email ?? null,
            requirements: input.requirements,
            styleNotes: input.styleNotes,
            items: priced.items,
            oneOffTotal: priced.oneOffTotal,
            monthlyTotal: priced.monthlyTotal,
            total: priced.total,
            createdAt: new Date(),
          });
        } catch (e) {
          console.error(`[webDesign] ⚠️ 訂單圖生成失敗（${orderNo}），落單中止（未寫 DB）:`, e);
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "落單失敗：訂單圖生成唔到，請稍後再試；你嘅訂單未被建立",
          });
        }
        try {
          created = await db.transaction(async (tx) => {
            const [row] = await tx
              .insert(webDesignOrders)
              .values({
                orderNo,
                plan: input.plan,
                name: input.name,
                phone,
                email: input.email ?? null,
                requirements: input.requirements,
                styleNotes: input.styleNotes,
                status: "received",
                paymentStatus: "pending",
                oneOffTotal: priced.oneOffTotal,
                monthlyTotal: priced.monthlyTotal,
                total: priced.total,
                orderImagePath: imagePath,
              })
              .returning();
            await tx.insert(webDesignOrderItems).values(
              priced.items.map((it) => ({
                orderId: row.id,
                itemKey: it.itemKey,
                name: it.name,
                category: it.category,
                plan: it.plan,
                billing: it.billing,
                price: it.price,
                marketPrice: it.marketPrice,
                priceNote: it.priceNote,
                sortOrder: it.sortOrder,
              })),
            );
            return row;
          });
          orderImagePath = imagePath;
        } catch (e) {
          lastErr = e;
          created = null;
          // 唔係撞號 → 即刻收檔（清孤兒圖＋報失敗），唔好當撞號亂 retry
          if (!isUniqueViolation(e)) {
            await deleteWebDesignOrderImage(imagePath);
            console.error(`[webDesign] 落單 DB 寫入失敗（${orderNo}，非撞號，唔 retry）:`, e);
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "落單失敗，請稍後再試；你嘅訂單未被建立",
            });
          }
          // 撞號：張圖跟舊號生，冇用——清咗佢，下個 loop 連號重新產
          await deleteWebDesignOrderImage(imagePath);
        }
      }
      if (!created || !orderImagePath) {
        console.error("[webDesign] 落單失敗（orderNo 連續撞號 3 次）:", lastErr);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "落單失敗，請稍後再試" });
      }

      void logAudit({
        actorId: null,
        actorRole: "system",
        actorNameFallback: "網站設計頁",
        action: "webDesign.createOrder",
        targetType: "webDesignOrder",
        targetId: created.orderNo,
        detail: `網站設計落單 ${created.orderNo}（方案 ${input.plan}，一次性 HK$${priced.oneOffTotal}，月費 HK$${priced.monthlyTotal}，今次總額 HK$${priced.total}，${priced.items.length - 1} 項自選功能）`,
      });
      return {
        orderNo: created.orderNo,
        oneOffTotal: priced.oneOffTotal,
        monthlyTotal: priced.monthlyTotal,
        total: priced.total,
        orderImagePath,
      };
    }),

  /**
   * 專屬查單（私隱）：完整姓名＋電話，rate limit；最新 10 張帶 items。
   * 用 **mutation**（姓名＋電話係私隱，唔應該入 GET URL／access log）。
   * 統一回 { found:false, orders:[] }——唔分開話邊欄錯，防枚舉。
   */
  lookup: publicProcedure
    .input(z.object({ name: nameSchema, phone: phoneSchema }))
    .mutation(async ({ ctx, input }) => {
      if (!lookupLimiter.allow(clientIpFromRequest(ctx.req))) tooFrequent();
      const id = validateLookupInput(input.name, input.phone);
      if (!id) return { found: false as const, orders: [] as never[] };
      const db = getDb();
      const rows = await db.query.webDesignOrders.findMany({
        where: and(eq(webDesignOrders.name, id.name), eq(webDesignOrders.phone, id.phone)),
        orderBy: desc(webDesignOrders.createdAt),
        limit: 10,
        with: { items: true },
      });
      return {
        found: rows.length > 0,
        orders: rows.map((o) => ({
          orderNo: o.orderNo,
          plan: o.plan,
          status: o.status,
          paymentStatus: o.paymentStatus,
          oneOffTotal: o.oneOffTotal,
          monthlyTotal: o.monthlyTotal,
          total: o.total,
          createdAt: o.createdAt.toISOString(),
          items: o.items
            .slice()
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((it) => ({
              itemKey: it.itemKey,
              name: it.name,
              plan: it.plan,
              billing: it.billing,
              price: it.price,
              marketPrice: it.marketPrice,
            })),
          orderImagePath: o.orderImagePath,
        })),
      };
    }),

  /**
   * 掛付款證明（圖先經 REST POST /api/web-design/upload 上傳攞 path）：
   * 三欄核實＋path 白名單（**只收 /uploads/wdproof-<隨機檔名>**，即頭先上傳 handler 出嘅圖；
   * 唔准任意 /uploads 舊圖路徑，防攞人哋張圖嚟冒認）；
   * paymentStatus pending／rejected → review（rejected 即客人重傳）。
   */
  attachProof: publicProcedure
    .input(z.object({ ...identityInput, imagePath: z.string().trim().min(1).max(512) }))
    .mutation(async ({ ctx, input }) => {
      if (!proofLimiter.allow(clientIpFromRequest(ctx.req))) tooFrequent();
      if (!/^\/uploads\/wdproof-[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|png|webp)$/.test(input.imagePath)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "圖片路徑唔啱（要用付款證明上傳入口取得嘅路徑）" });
      }
      const order = await findOrderByIdentity(input);
      if (order.status === "cancelled") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "呢張訂單已取消，唔可以再上傳付款證明" });
      }
      if (order.paymentStatus !== "pending" && order.paymentStatus !== "rejected") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "呢張訂單而家唔係待付款狀態" });
      }
      const db = getDb();
      await db.transaction(async (tx) => {
        await tx.insert(webDesignPaymentProofs).values({
          orderId: order.id,
          imagePath: input.imagePath,
          status: "pending",
        });
        // 條件更新做並發鎖：網上付款 webhook／WMS 取消若啱啱先一步改態，
        // 呢度郁 0 行會 rollback 新 proof，唔會將 paid／cancelled 冚返做 review。
        const [locked] = await tx
          .update(webDesignOrders)
          .set({ paymentStatus: "review", updatedAt: new Date() })
          .where(
            and(
              eq(webDesignOrders.id, order.id),
              eq(webDesignOrders.paymentStatus, order.paymentStatus),
              ne(webDesignOrders.status, "cancelled"),
            ),
          )
          .returning({ id: webDesignOrders.id });
        if (!locked) {
          throw new TRPCError({ code: "CONFLICT", message: "訂單狀態啱啱更新咗，請重新查單後再試" });
        }
      });
      void logAudit({
        actorId: null,
        actorRole: "system",
        actorNameFallback: "網站設計頁",
        action: "webDesign.attachProof",
        targetType: "webDesignOrder",
        targetId: order.orderNo,
        detail: `網站設計單 ${order.orderNo} 收到付款證明（${input.imagePath}），付款狀態轉 review`,
      });
      return { ok: true as const, orderNo: order.orderNo, paymentStatus: "review" as const };
    }),

  /**
   * 留言：DB 保存＋寄 service.support@ows.redcode.red。
   * email 失敗 → 回明確部分成功（saved:true, emailSent:false）——留言唔會丟。
   */
  submitInquiry: publicProcedure
    .input(
      z.object({
        name: nameSchema,
        phone: phoneSchema,
        email: emailSchema,
        message: z.string().trim().min(1, "訊息唔可以留空").max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!inquiryLimiter.allow(clientIpFromRequest(ctx.req))) tooFrequent();
      const phone = normalizeWebDesignPhone(input.phone);
      if (!phone) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "電話格式唔啱（要香港 8 位數字）" });
      }
      const db = getDb();
      const [row] = await db
        .insert(webDesignInquiries)
        .values({ name: input.name, phone, email: input.email, message: input.message })
        .returning({ id: webDesignInquiries.id });
      const r = await sendWebDesignInquiryEmail({
        name: input.name,
        phone,
        email: input.email,
        message: input.message,
        inquiryId: row.id,
      });
      if (r.ok) {
        await db
          .update(webDesignInquiries)
          .set({ emailSent: true })
          .where(eq(webDesignInquiries.id, row.id));
      } else {
        console.error(`[webDesign] 留言 #${row.id} 通知信寄失敗（DB 已保存）：${r.error ?? "未知"}`);
      }
      return {
        ok: true as const,
        saved: true as const,
        inquiryId: row.id,
        emailSent: r.ok,
        ...(r.ok
          ? {}
          : { note: "留言已保存，但通知電郵寄出失敗；我哋會喺後台直接跟進，請放心。" }),
      };
    }),

  /**
   * 網上付款（Airwallex HPP）：三欄核實＋paymentStatus='pending' 先開得單。
   * returnUrl＝/api/airwallex/return-web-design?orderNo=...（Lead 喺 boot 註冊中轉）。
   * 回傳同 redirectToAirwallexCheckout 完全一致嘅 shape；未配置 → { enabled:false, message }。
   */
  createPayment: publicProcedure
    .input(z.object(identityInput))
    .mutation(async ({ ctx, input }) => {
      if (!paymentLimiter.allow(clientIpFromRequest(ctx.req))) tooFrequent();
      const cfg = await getAirwallexConfig();
      if (!cfg) {
        return { enabled: false as const, message: "網上付款未啟用，請改用截圖上傳方式付款" };
      }
      const order = await findOrderByIdentity(input);
      if (order.status === "cancelled") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "呢張訂單已取消" });
      }
      if (order.paymentStatus !== "pending") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "呢張訂單而家唔係待付款狀態，唔可以再付款",
        });
      }
      const returnUrl = `${cfg.publicBaseUrl}/api/airwallex/return-web-design?orderNo=${encodeURIComponent(order.orderNo)}`;
      try {
        const session = await createHostedPayment({
          cfg,
          orderId: order.id,
          orderNo: order.orderNo,
          amount: order.total, // 整數港元（major unit），直接傳
          returnUrl,
        });
        const db = getDb();
        try {
          await db
            .update(webDesignOrders)
            .set({ airwallexIntentId: session.intentId, updatedAt: new Date() })
            .where(eq(webDesignOrders.id, order.id));
        } catch (e) {
          // 冇 stored intent id 就唔好將 clientSecret 交出去：之後 webhook 無法綁定同一個 intent。
          console.error(`[airwallex] 記低網站設計單 intent id 失敗（${order.orderNo}），中止付款：`, e);
          throw e;
        }
        return {
          enabled: true as const,
          intentId: session.intentId,
          clientSecret: session.clientSecret,
          env: session.env,
          currency: session.currency,
          returnUrl: session.returnUrl,
          orderNo: order.orderNo,
          amount: order.total,
        };
      } catch (e) {
        console.error(`[airwallex] 開網站設計付款單失敗（${order.orderNo}）：`, e);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "開網上付款單失敗，請稍後再試，或者改用截圖上傳方式付款",
        });
      }
    }),

  // ─── 後台 ──────────────────────────────────────────────────────────────

  /** 後台睇 catalog（admin；同公開版一樣係合併預設後嘅完整結構） */
  adminCatalog: adminProcedure.query(async (): Promise<WebDesignCatalog> => {
    return loadCatalog();
  }),

  /** 改 catalog（admin；validateCatalog 嚴格驗證，壞 payload 唔落得 DB） */
  setCatalog: adminProcedure
    .input(z.object({ catalog: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const catalog = validateCatalog(input.catalog);
      if (!catalog) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Catalog 格式唔啱：四個方案價要非負整數，items 逐項要有 key/name/category/price/requiredPlan/billing",
        });
      }
      const db = getDb();
      await db
        .insert(siteSettings)
        .values({
          key: WEB_DESIGN_CATALOG_SETTING_KEY,
          value: JSON.stringify(catalog),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: siteSettings.key,
          set: { value: JSON.stringify(catalog), updatedAt: new Date() },
        });
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "webDesign.setCatalog",
        targetType: "setting",
        targetId: WEB_DESIGN_CATALOG_SETTING_KEY,
        detail: `更新網站設計目錄：前台 HK$${catalog.frontOnlyPrice}／前台＋後台 HK$${catalog.fullStackPrice}，${catalog.items.length} 項功能`,
      });
      return { ok: true as const };
    }),

  /** 後台訂單列表（staff）：最新先，帶 items＋proofs＋WMS 欄 */
  adminOrders: staffProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.query.webDesignOrders.findMany({
        orderBy: desc(webDesignOrders.createdAt),
        limit: input?.limit ?? 50,
        with: { items: true, proofs: true },
      });
      return rows.map((o) => ({
        id: o.id,
        orderNo: o.orderNo,
        plan: o.plan,
        name: o.name,
        phone: o.phone,
        email: o.email,
        requirements: o.requirements,
        styleNotes: o.styleNotes,
        status: o.status,
        paymentStatus: o.paymentStatus,
        oneOffTotal: o.oneOffTotal,
        monthlyTotal: o.monthlyTotal,
        total: o.total,
        orderImagePath: o.orderImagePath,
        paymentChannel: o.paymentChannel,
        airwallexIntentId: o.airwallexIntentId,
        paidAt: o.paidAt ? o.paidAt.toISOString() : null,
        wmsStatus: o.wmsStatus,
        wmsError: o.wmsError,
        wmsWebhookOrderId: o.wmsWebhookOrderId,
        completedAt: o.completedAt ? o.completedAt.toISOString() : null,
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
        items: o.items
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((it) => ({
            itemKey: it.itemKey,
            name: it.name,
            plan: it.plan,
            billing: it.billing,
            price: it.price,
            marketPrice: it.marketPrice,
            priceNote: it.priceNote,
          })),
        proofs: o.proofs
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((p) => ({
            id: p.id,
            imagePath: p.imagePath,
            status: p.status,
            note: p.reviewNote,
            createdAt: p.createdAt.toISOString(),
          })),
      }));
    }),

  /**
   * 核實付款證明（supervisor）：
   * approve → proof approved＋訂單 paymentStatus paid（status 留 received）＋即時 forward WMS；
   * reject  → proof rejected＋訂單 paymentStatus rejected（等客人重傳）。
   */
  reviewProof: supervisorProcedure
    .input(
      z.object({
        proofId: z.number().int().positive(),
        decision: z.enum(["approve", "reject"]),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const proof = await db.query.webDesignPaymentProofs.findFirst({
        where: eq(webDesignPaymentProofs.id, input.proofId),
      });
      if (!proof) {
        throw new TRPCError({ code: "NOT_FOUND", message: "搵唔到呢張付款證明" });
      }
      if (proof.status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "呢張付款證明已經核實過" });
      }
      const order = await db.query.webDesignOrders.findFirst({
        where: eq(webDesignOrders.id, proof.orderId),
      });
      if (!order) {
        throw new TRPCError({ code: "NOT_FOUND", message: "搵唔到相關訂單" });
      }
      if (order.status === "cancelled" || order.paymentStatus !== "review") {
        throw new TRPCError({ code: "CONFLICT", message: "訂單狀態已更新，唔可以再核實呢張截圖" });
      }
      const now = new Date();
      const approve = input.decision === "approve";
      await db.transaction(async (tx) => {
        // 兩個主管同時撳都得一個成功：proof 同 order 都用條件更新做鎖。
        const [proofLocked] = await tx
          .update(webDesignPaymentProofs)
          .set({
            status: approve ? "approved" : "rejected",
            reviewedBy: ctx.user.userId,
            reviewNote: input.note ?? null,
            reviewedAt: now,
          })
          .where(and(eq(webDesignPaymentProofs.id, proof.id), eq(webDesignPaymentProofs.status, "pending")))
          .returning({ id: webDesignPaymentProofs.id });
        if (!proofLocked) {
          throw new TRPCError({ code: "CONFLICT", message: "呢張付款證明已經由另一位同事核實" });
        }
        const [orderLocked] = await tx
          .update(webDesignOrders)
          .set({
            paymentStatus: approve ? "paid" : "rejected",
            ...(approve && !order.paidAt ? { paidAt: now } : {}),
            updatedAt: now,
          })
          .where(
            and(
              eq(webDesignOrders.id, order.id),
              eq(webDesignOrders.paymentStatus, "review"),
              ne(webDesignOrders.status, "cancelled"),
            ),
          )
          .returning({ id: webDesignOrders.id });
        if (!orderLocked) {
          throw new TRPCError({ code: "CONFLICT", message: "訂單狀態啱啱更新咗，請刷新後再試" });
        }
      });
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: approve ? "webDesign.proofApprove" : "webDesign.proofReject",
        targetType: "webDesignOrder",
        targetId: order.orderNo,
        detail: `網站設計單 ${order.orderNo} 付款證明 #${proof.id} ${approve ? "核實通過（付款確認）" : "核實拒絕"}${input.note ? `，備註：${input.note}` : ""}`,
      });
      // approve → 即時 forward WMS（失敗 wmsError 落 DB，可 retryWms）
      let wms: Awaited<ReturnType<typeof forwardWebDesignOrderToWms>> | null = null;
      if (approve) {
        wms = await forwardWebDesignOrderToWms(order.id);
      }
      return { ok: true as const, orderNo: order.orderNo, decision: input.decision, wms };
    }),

  /** 重試 WMS 同步（staff）：未配置／失敗嘅單人手補送 */
  retryWms: staffProcedure
    .input(z.object({ orderNo: z.string().trim().min(1).max(32) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const order = await db.query.webDesignOrders.findFirst({
        where: eq(webDesignOrders.orderNo, input.orderNo),
      });
      if (!order) {
        throw new TRPCError({ code: "NOT_FOUND", message: "搵唔到呢張訂單" });
      }
      if (order.status === "cancelled" || order.paymentStatus !== "paid") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "訂單未確認付款或者已取消，唔可以同步去 WMS" });
      }
      const result = await forwardWebDesignOrderToWms(order.id);
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "webDesign.retryWms",
        targetType: "webDesignOrder",
        targetId: order.orderNo,
        detail: `重試 WMS 同步：${result.status}${result.error ? `（${result.error}）` : ""}`,
      });
      return { ok: true as const, orderNo: order.orderNo, wms: result };
    }),

  /** 後台留言列表（staff）：最新先 */
  adminInquiries: staffProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(100) }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.query.webDesignInquiries.findMany({
        orderBy: desc(webDesignInquiries.createdAt),
        limit: input?.limit ?? 100,
      });
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        email: r.email,
        message: r.message,
        status: r.status,
        emailSent: r.emailSent,
        handledBy: r.handledBy,
        handledAt: r.handledAt ? r.handledAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      }));
    }),

  /** 標記留言已跟進（staff） */
  markInquiryHandled: staffProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [updated] = await db
        .update(webDesignInquiries)
        .set({
          status: "handled",
          handledBy: String(ctx.user.userId),
          handledAt: new Date(),
        })
        .where(and(eq(webDesignInquiries.id, input.id), eq(webDesignInquiries.status, "new")))
        .returning({ id: webDesignInquiries.id });
      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "搵唔到呢條留言（或者已經跟進咗）" });
      }
      return { ok: true as const, id: updated.id };
    }),
});
