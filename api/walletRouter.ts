/**
 * v2.5.0（會員購物金 wallet，2026-10-09 老闆指令）：購物金 tRPC API。
 *
 * ─ packages（登入）：上架中套票列表（充值頁）
 * ─ myWallet（登入）：我嘅餘額＋流水賬＋充值紀錄（會員中心）
 * ─ createTopup（登入）：開充值單（30 分鐘付款期；待付款）
 * ─ attachTopupProof（登入）：上傳付款截圖 → 待批核（圖先經 /api/upload 落 disk）
 * ─ adminPackages／upsertPackage（staff/supervisor）：後台套票管理
 * ─ deletePackage（supervisor/admin，老闆 2026-10-11：「主管同管理員都要可以del翻」）：
 *   有充值紀錄引用嘅套票唔刪得（報錯轉下架），冇引用先 hard delete＋異動紀錄
 * ─ adminTopups（staff）：待批核充值單＋最近紀錄
 * ─ reviewTopup（staff）：批核（入帳＋寄信）／拒絕（寄信）——冪等
 * ─ deleteTopup（admin 專用，老闆 2026-10-11：「後台紀錄購物金充值要官網管理員先可以刪除」）：
 *   刪紀錄唔會扣回已入帳嘅購物金（流水賬係獨立 audit 級紀錄，照舊保留）；
 *   每次刪除都寫完整快照落異動紀錄（邊個刪、刪咗咩、幾時刪）
 * ─ memberWallet（supervisor/admin）：後台睇指定會員餘額＋紀錄
 *
 * 鐵律：
 * - 入帳只有一條路：reviewTopup approve／WMS callback approve（conditional update 冪等）；
 * - 購物金不設退款；只限官網商品；
 * - 金額全部整數港元。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { orders, users, walletLedger, walletPackages, walletTopups } from "@db/schema";
import {
  createRouter,
  authedProcedure,
  staffProcedure,
  supervisorProcedure,
  adminProcedure,
} from "./middleware";
import { logAudit } from "./audit";
import {
  sendWalletTopupPendingEmail,
  sendWalletTopupApprovedEmail,
  sendWalletTopupRejectedEmail,
  sendWalletTopupReviewAlertEmail,
} from "./email";
import {
  generateTopupNo,
  TOPUP_TTL_MS,
  TOPUP_CHANNEL_LABEL,
} from "./wallet";

/** 充值單對外輸出（整數港元直接出；日期 ISO） */
function topupPayload(t: typeof walletTopups.$inferSelect) {
  return {
    id: t.id,
    topupNo: t.topupNo,
    label: t.label,
    creditAmount: t.creditAmount,
    price: t.price,
    status: t.status,
    paymentChannel: t.paymentChannel,
    paidAt: t.paidAt?.toISOString() ?? null,
    expiresAt: t.expiresAt.toISOString(),
    proofImagePath: t.proofImagePath,
    reviewNote: t.reviewNote,
    approvedAt: t.approvedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

function ledgerPayload(l: typeof walletLedger.$inferSelect) {
  return {
    id: l.id,
    type: l.type,
    amount: l.amount,
    balanceAfter: l.balanceAfter,
    refType: l.refType,
    refId: l.refId,
    note: l.note,
    createdAt: l.createdAt.toISOString(),
  };
}

/**
 * 充值單批核核心（官網後台 reviewTopup 同 WMS callback 共用）：
 * 冪等——conditional update 淨郁 payment_review 嘅單；郁到先入帳（同事務加餘額＋記賬）。
 * 回傳 null＝冇郁到（已批過／狀態唔啱），caller 自己決定點答。
 */
export async function approveTopupCore(
  topupId: number,
  approverName: string,
  note: string | null,
): Promise<{ topupNo: string; balanceAfter: number } | null> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(walletTopups)
      .set({
        status: "approved",
        approvedBy: approverName,
        approvedAt: new Date(),
        reviewNote: note,
        paidAt: sql`COALESCE(${walletTopups.paidAt}, now())`,
        updatedAt: new Date(),
      })
      .where(and(eq(walletTopups.id, topupId), eq(walletTopups.status, "payment_review")))
      .returning();
    if (!claimed) return null;
    const [u] = await tx
      .update(users)
      .set({ storeCredit: sql`${users.storeCredit} + ${claimed.creditAmount}` })
      .where(eq(users.id, claimed.userId))
      .returning({ storeCredit: users.storeCredit });
    if (!u) throw new Error(`搵唔到會員 #${claimed.userId}`);
    await tx.insert(walletLedger).values({
      userId: claimed.userId,
      type: "topup",
      amount: claimed.creditAmount,
      balanceAfter: u.storeCredit,
      refType: "topup",
      refId: claimed.topupNo,
      note: `充值「${claimed.label}」批核入帳（${TOPUP_CHANNEL_LABEL[claimed.paymentChannel] ?? claimed.paymentChannel}）`,
    });
    return { topupNo: claimed.topupNo, balanceAfter: u.storeCredit };
  });
}

export const walletRouter = createRouter({
  /** 上架中套票（充值頁用；登入先入到頁，但接口本身唔使權限分級） */
  packages: authedProcedure.query(async () => {
    const db = getDb();
    return db.query.walletPackages.findMany({
      where: eq(walletPackages.isActive, true),
      orderBy: [walletPackages.sortOrder, walletPackages.price],
    });
  }),

  /**
   * 我嘅購物金：餘額＋流水賬（**每頁 15 筆**，老闆指令）＋充值紀錄（50 條）。
   * 流水賬每條附埋對照資料，會員中心直接顯示：
   *   存入 → channelByTopupNo 攞付款方式（用咩方式比錢）；
   *   使用／返還 → orderIdByNo 攞 orderId，前端撳得落去睇返張訂單（/receipt/:id）。
   */
  myWallet: authedProcedure
    .input(z.object({ ledgerPage: z.number().int().min(1).default(1) }).optional())
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const page = input?.ledgerPage ?? 1;
      const PAGE_SIZE = 15;
      const me = await db.query.users.findFirst({
        where: eq(users.id, ctx.user.userId),
        columns: { storeCredit: true },
      });
      const [countRow] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(walletLedger)
        .where(eq(walletLedger.userId, ctx.user.userId));
      const ledgerTotal = countRow?.n ?? 0;
      const [ledger, topups] = await Promise.all([
        db.query.walletLedger.findMany({
          where: eq(walletLedger.userId, ctx.user.userId),
          orderBy: [desc(walletLedger.createdAt), desc(walletLedger.id)],
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        }),
        // 充值紀錄淨係第一頁先返（會員中心首屏用；慳流量）
        page === 1
          ? db.query.walletTopups.findMany({
              where: eq(walletTopups.userId, ctx.user.userId),
              orderBy: [desc(walletTopups.createdAt), desc(walletTopups.id)],
              limit: 50,
            })
          : Promise.resolve([]),
      ]);
      // 呢頁流水涉及嘅訂單號／充值單號 → 對照 orderId／付款方式
      const orderNos = [...new Set(ledger.filter((l) => l.refType === "order").map((l) => l.refId))];
      const topupNos = [...new Set(ledger.filter((l) => l.refType === "topup").map((l) => l.refId))];
      const [orderRows, topupRows] = await Promise.all([
        orderNos.length > 0
          ? db.query.orders.findMany({
              where: and(eq(orders.userId, ctx.user.userId), inArray(orders.orderNo, orderNos)),
              columns: { id: true, orderNo: true },
              // 「買左咩」摘要：貨名（尺寸）×數量，頭兩件＋等 N 件
              with: { items: { columns: { productName: true, size: true, quantity: true } } },
            })
          : Promise.resolve([]),
        topupNos.length > 0
          ? db
              .select({ topupNo: walletTopups.topupNo, paymentChannel: walletTopups.paymentChannel })
              .from(walletTopups)
              .where(inArray(walletTopups.topupNo, topupNos))
          : Promise.resolve([]),
      ]);
      const orderInfoByNo = Object.fromEntries(
        orderRows.map((o) => {
          const names = o.items.map(
            (it) => `${it.productName}${it.size ? `（${it.size}）` : ""} ×${it.quantity}`,
          );
          const summary =
            names.length <= 2 ? names.join("、") : `${names.slice(0, 2).join("、")} 等 ${names.length} 件`;
          return [o.orderNo, { id: o.id, summary }];
        }),
      );
      return {
        balance: me?.storeCredit ?? 0,
        ledger: ledger.map(ledgerPayload),
        ledgerTotal,
        ledgerPage: page,
        ledgerPageSize: PAGE_SIZE,
        orderInfoByNo,
        channelByTopupNo: Object.fromEntries(topupRows.map((t) => [t.topupNo, t.paymentChannel])),
        topups: topups.map(topupPayload),
      };
    }),

  /**
   * 開充值單：揀套票 → pending_payment（30 分鐘死線）→ 寄待付款信。
   * 同一時間最多 3 張未完成充值單（pending_payment／payment_review）——防洗版式開單。
   */
  createTopup: authedProcedure
    .input(z.object({ packageId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const pkg = await db.query.walletPackages.findFirst({
        where: and(eq(walletPackages.id, input.packageId), eq(walletPackages.isActive, true)),
      });
      if (!pkg) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "呢個套票已下架，請揀過第二個" });
      }
      const open = await db.query.walletTopups.findMany({
        where: and(
          eq(walletTopups.userId, ctx.user.userId),
          ne(walletTopups.status, "approved"),
          ne(walletTopups.status, "rejected"),
          ne(walletTopups.status, "cancelled"),
        ),
        columns: { id: true },
      });
      if (open.length >= 3) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "你有 3 張充值單未完成，請先付款或等佢哋過期，先好開新單",
        });
      }
      let topupNo = generateTopupNo();
      for (let i = 0; i < 10; i++) {
        const dup = await db.query.walletTopups.findFirst({
          where: eq(walletTopups.topupNo, topupNo),
          columns: { id: true },
        });
        if (!dup) break;
        topupNo = generateTopupNo();
      }
      const expiresAt = new Date(Date.now() + TOPUP_TTL_MS);
      const [created] = await db
        .insert(walletTopups)
        .values({
          topupNo,
          userId: ctx.user.userId,
          packageId: pkg.id,
          label: pkg.label,
          creditAmount: pkg.creditAmount,
          price: pkg.price,
          expiresAt,
        })
        .returning();
      // 待付款信（有 email 先寄；結果寫入日誌 detail，唔阻開單）
      let emailNote = "";
      const member = await db.query.users.findFirst({
        where: eq(users.id, ctx.user.userId),
        columns: { name: true, email: true },
      });
      if (member?.email) {
        const r = await sendWalletTopupPendingEmail({
          to: member.email,
          name: member.name,
          topupNo,
          label: pkg.label,
          creditAmount: pkg.creditAmount,
          price: pkg.price,
          expiresAt,
        });
        emailNote = r.ok ? `，待付款信已寄出至 ${member.email}` : `，待付款信寄出失敗（${r.error ?? "未知原因"}）`;
      } else {
        emailNote = "，會員冇綁 Email，冇寄待付款信";
      }
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "wallet.topupCreate",
        targetType: "walletTopup",
        targetId: topupNo,
        detail: `開充值單 ${topupNo}：「${pkg.label}」面額 HK$${pkg.creditAmount}、售價 HK$${pkg.price}，30 分鐘付款期${emailNote}`,
      });
      return topupPayload(created);
    }),

  /**
   * 上傳付款截圖：圖先經 /api/upload 落 disk 攞 imagePath；呢度綁上充值單＋轉待批核。
   * 只限自己嘅單＋pending_payment＋未過 30 分鐘。
   */
  attachTopupProof: authedProcedure
    .input(
      z.object({
        topupId: z.number().int().positive(),
        imagePath: z.string().trim().min(1).max(512),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const topup = await db.query.walletTopups.findFirst({
        where: and(eq(walletTopups.id, input.topupId), eq(walletTopups.userId, ctx.user.userId)),
      });
      if (!topup) {
        throw new TRPCError({ code: "NOT_FOUND", message: "充值單不存在" });
      }
      if (topup.status !== "pending_payment") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "呢張充值單而家唔係待付款狀態" });
      }
      if (topup.expiresAt.getTime() <= Date.now()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "付款期已過，充值單會自動取消，請開新單" });
      }
      const [updated] = await db
        .update(walletTopups)
        .set({
          proofImagePath: input.imagePath,
          paymentChannel: "manual",
          status: "payment_review",
          updatedAt: new Date(),
        })
        .where(and(eq(walletTopups.id, topup.id), eq(walletTopups.status, "pending_payment")))
        .returning();
      if (!updated) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "充值單狀態已更新，請刷新再睇" });
      }
      // 內部待批核通知（背景，失敗唔阻）
      void (async () => {
        const member = await db.query.users.findFirst({
          where: eq(users.id, ctx.user.userId),
          columns: { name: true, phone: true, email: true },
        });
        if (!member) return;
        const r = await sendWalletTopupReviewAlertEmail({
          topupNo: topup.topupNo,
          memberName: member.name,
          memberPhone: member.phone,
          memberEmail: member.email,
          label: topup.label,
          creditAmount: topup.creditAmount,
          price: topup.price,
          channel: "手動上傳截圖",
        });
        if (!r.ok) console.error(`[wallet] 充值待批核通知寄唔出（${topup.topupNo}）：`, r.error);
      })();
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "wallet.topupProof",
        targetType: "walletTopup",
        targetId: topup.topupNo,
        detail: `上傳充值付款截圖（${topup.topupNo}，HK$${topup.price}），轉待批核`,
      });
      return topupPayload(updated);
    }),

  // ─────────────────────────── 後台 ───────────────────────────

  /** 套票列表（staff 以上；包埋下架嘅） */
  adminPackages: staffProcedure.query(async () => {
    const db = getDb();
    return db.query.walletPackages.findMany({
      orderBy: [walletPackages.sortOrder, walletPackages.price],
    });
  }),

  /**
   * 上架／修改套票（supervisor/admin——改價錢屬敏感操作，唔開放畀普通員工）。
   * 有 id 就更新（label/面額/售價/排序/上下架）；冇 id 就新增。
   */
  upsertPackage: supervisorProcedure
    .input(
      z.object({
        id: z.number().int().positive().optional(),
        label: z.string().trim().min(1).max(64),
        creditAmount: z.number().int().positive().max(1_000_000),
        price: z.number().int().positive().max(1_000_000),
        sortOrder: z.number().int().min(0).max(9999).default(0),
        isActive: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      if (input.id) {
        const [updated] = await db
          .update(walletPackages)
          .set({
            label: input.label,
            creditAmount: input.creditAmount,
            price: input.price,
            sortOrder: input.sortOrder,
            isActive: input.isActive,
          })
          .where(eq(walletPackages.id, input.id))
          .returning();
        if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "套票不存在" });
        void logAudit({
          actorId: ctx.user.userId,
          actorRole: ctx.user.role,
          action: "wallet.packageUpdate",
          targetType: "walletPackage",
          targetId: String(input.id),
          detail: `更新套票 #${input.id}：「${input.label}」面額 HK$${input.creditAmount}、售價 HK$${input.price}、${input.isActive ? "上架中" : "已下架"}`,
        });
        return updated;
      }
      const [created] = await db
        .insert(walletPackages)
        .values({
          label: input.label,
          creditAmount: input.creditAmount,
          price: input.price,
          sortOrder: input.sortOrder,
          isActive: input.isActive,
        })
        .returning();
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "wallet.packageCreate",
        targetType: "walletPackage",
        targetId: String(created.id),
        detail: `新增套票「${input.label}」：面額 HK$${input.creditAmount}、售價 HK$${input.price}`,
      });
      return created;
    }),

  /**
   * 刪除套票（supervisor/admin——老闆 2026-10-11：「購物金套票管理，主管同管理員都要可以del翻」）。
   * 安全閘：有充值紀錄（walletTopups.packageId）引用嘅套票唔刪得——歷史充值單靠快照留名，
   * 但套票一刪就再冇得對返；呢種情況報錯叫佢改用「下架」（失敗即報錯，唔靜默）。
   * 刪除成功寫完整快照落異動紀錄。
   */
  deletePackage: supervisorProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const pkg = await db.query.walletPackages.findFirst({
        where: eq(walletPackages.id, input.id),
      });
      if (!pkg) throw new TRPCError({ code: "NOT_FOUND", message: "套票不存在" });
      const [{ n: refCount }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(walletTopups)
        .where(eq(walletTopups.packageId, input.id));
      if (refCount > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `呢個套票有 ${refCount} 張充值單用過，為咗保留紀錄唔可以刪除——可以改用「下架」（唔剔上架），客人就睇唔到`,
        });
      }
      const [deleted] = await db
        .delete(walletPackages)
        .where(eq(walletPackages.id, input.id))
        .returning({ id: walletPackages.id });
      if (!deleted) throw new TRPCError({ code: "NOT_FOUND", message: "套票不存在" });
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "wallet.packageDelete",
        targetType: "walletPackage",
        targetId: String(input.id),
        detail: `刪除套票 #${input.id}：「${pkg.label}」面額 HK$${pkg.creditAmount}、售價 HK$${pkg.price}、排序 ${pkg.sortOrder}、${pkg.isActive ? "上架中" : "已下架"}（冇充值紀錄引用）`,
      });
      return { ok: true as const };
    }),

  /**
   * 充值單列表（staff）：預設待批核單排先＋最近 100 條；會員資料 join 埋。
   * status 篩選：'payment_review'（待批核）｜'approved'｜'rejected'｜'cancelled'｜'pending_payment'｜唔傳＝全部
   */
  adminTopups: staffProcedure
    .input(z.object({ status: z.string().trim().max(16).optional() }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.query.walletTopups.findMany({
        where: input?.status ? eq(walletTopups.status, input.status) : undefined,
        with: { user: { columns: { id: true, name: true, phone: true, email: true } } },
        orderBy: [desc(walletTopups.createdAt), desc(walletTopups.id)],
        limit: 100,
      });
      return rows.map((t) => ({
        ...topupPayload(t),
        member: t.user
          ? { id: t.user.id, name: t.user.name, phone: t.user.phone, email: t.user.email }
          : null,
      }));
    }),

  /**
   * 批核充值單（staff 以上）：approve＝入帳（冪等 core）＋寄入帳信；
   * reject＝轉已拒絕＋寄拒絕信（購物金唔會郁）。
   */
  reviewTopup: staffProcedure
    .input(
      z.object({
        topupId: z.number().int().positive(),
        approve: z.boolean(),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const topup = await db.query.walletTopups.findFirst({
        where: eq(walletTopups.id, input.topupId),
      });
      if (!topup) throw new TRPCError({ code: "NOT_FOUND", message: "充值單不存在" });
      const member = await db.query.users.findFirst({
        where: eq(users.id, topup.userId),
        columns: { name: true, email: true },
      });
      // 批准人顯示名（寫落充值單 approvedBy，客人／WMS 都睇到邊個批）
      const staff = await db.query.users.findFirst({
        where: eq(users.id, ctx.user.userId),
        columns: { name: true },
      });
      const approverName = staff?.name ?? `員工#${ctx.user.userId}`;
      if (!input.approve) {
        // 拒絕：只可以拒絕待批核嘅單
        const [rejected] = await db
          .update(walletTopups)
          .set({
            status: "rejected",
            reviewNote: input.note ?? null,
            updatedAt: new Date(),
          })
          .where(and(eq(walletTopups.id, topup.id), eq(walletTopups.status, "payment_review")))
          .returning();
        if (!rejected) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "充值單已經處理咗" });
        }
        let emailNote = "";
        if (member?.email) {
          const r = await sendWalletTopupRejectedEmail({
            to: member.email,
            name: member.name,
            topupNo: topup.topupNo,
            label: topup.label,
            price: topup.price,
            note: input.note ?? null,
          });
          emailNote = r.ok ? `，拒絕信已寄出至 ${member.email}` : `，拒絕信寄出失敗（${r.error ?? "未知原因"}）`;
        }
        void logAudit({
          actorId: ctx.user.userId,
          actorRole: ctx.user.role,
          action: "wallet.topupReject",
          targetType: "walletTopup",
          targetId: topup.topupNo,
          detail: `拒絕充值單 ${topup.topupNo}（${topup.label}，HK$${topup.price}）${input.note ? `，原因：${input.note}` : ""}${emailNote}`,
        });
        return { ok: true as const, status: "rejected" as const, emailNote };
      }
      // 批准：入帳 core（冪等）——approvedBy 用上面攞好嘅友好名（客人／WMS 會睇到邊個批）
      const result = await approveTopupCore(topup.id, approverName, input.note ?? null);
      if (!result) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "充值單已經處理咗" });
      }
      let emailNote = "";
      if (member?.email) {
        const r = await sendWalletTopupApprovedEmail({
          to: member.email,
          name: member.name,
          topupNo: topup.topupNo,
          label: topup.label,
          creditAmount: topup.creditAmount,
          balanceAfter: result.balanceAfter,
          channel: TOPUP_CHANNEL_LABEL[topup.paymentChannel] ?? topup.paymentChannel,
        });
        emailNote = r.ok ? `，入帳信已寄出至 ${member.email}` : `，入帳信寄出失敗（${r.error ?? "未知原因"}）`;
      } else {
        emailNote = "，會員冇綁 Email，冇寄入帳信";
      }
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "wallet.topupApprove",
        targetType: "walletTopup",
        targetId: topup.topupNo,
        detail: `批准充值單 ${topup.topupNo}：入帳 HK$${topup.creditAmount}，會員最新餘額 HK$${result.balanceAfter}${emailNote}`,
      });
      return { ok: true as const, status: "approved" as const, balanceAfter: result.balanceAfter, emailNote };
    }),

  /**
   * 刪除充值紀錄（**admin 專用**——老闆 2026-10-11：「後台紀錄購物金充值要官網管理員先可以刪除」）。
   * 注意：呢度淨係刪「紀錄」——已入帳嘅購物金唔會扣回（流水賬 walletLedger 係 audit 級，
   * 永久保留，唔會跟住刪）；要扣回餘額係另一個動作，唔係刪紀錄做嘅。
   * 待批核（payment_review）嘅單刪咗＝放棄批核，會員購物金唔會入帳；刪之前 UI 有 confirm。
   * 每次刪除都寫完整快照落異動紀錄（單號／會員／金額／狀態／渠道／邊個刪）。
   */
  deleteTopup: adminProcedure
    .input(z.object({ topupId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const topup = await db.query.walletTopups.findFirst({
        where: eq(walletTopups.id, input.topupId),
        with: { user: { columns: { name: true, phone: true } } },
      });
      if (!topup) throw new TRPCError({ code: "NOT_FOUND", message: "充值紀錄不存在" });
      const [deleted] = await db
        .delete(walletTopups)
        .where(eq(walletTopups.id, input.topupId))
        .returning({ id: walletTopups.id });
      if (!deleted) throw new TRPCError({ code: "NOT_FOUND", message: "充值紀錄不存在" });
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "wallet.topupDelete",
        targetType: "walletTopup",
        targetId: topup.topupNo,
        detail: `刪除充值紀錄 ${topup.topupNo}：會員「${topup.user?.name ?? topup.userId}」（${topup.user?.phone ?? "—"}）、「${topup.label}」面額 HK$${topup.creditAmount}、實付 HK$${topup.price}、狀態 ${topup.status}、渠道 ${topup.paymentChannel}${topup.approvedBy ? `、批准人 ${topup.approvedBy}` : ""}（只刪紀錄，購物金餘額唔受影響）`,
      });
      return { ok: true as const };
    }),

  /**
   * 後台睇指定會員購物金（supervisor/admin，老闆指令）：餘額＋流水＋充值紀錄。
   */
  memberWallet: supervisorProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const member = await db.query.users.findFirst({
        where: eq(users.id, input.userId),
        columns: { id: true, name: true, phone: true, email: true, storeCredit: true },
      });
      if (!member) throw new TRPCError({ code: "NOT_FOUND", message: "會員不存在" });
      const [ledger, topups] = await Promise.all([
        db.query.walletLedger.findMany({
          where: eq(walletLedger.userId, input.userId),
          orderBy: [desc(walletLedger.createdAt), desc(walletLedger.id)],
          limit: 100,
        }),
        db.query.walletTopups.findMany({
          where: eq(walletTopups.userId, input.userId),
          orderBy: [desc(walletTopups.createdAt), desc(walletTopups.id)],
          limit: 50,
        }),
      ]);
      return {
        member,
        ledger: ledger.map(ledgerPayload),
        topups: topups.map(topupPayload),
      };
    }),
});
