/**
 * v2.1.0（VIP+免運，2026-09-29）：VIP 會員＋免運＋順豐站點 tRPC API。
 *
 * ─ getMyVip（登入）：我嘅 VIP 狀態＋本年度消費＋距離下一級差幾多（會員中心／導覽列 badge 用）
 * ─ getPublicVipConfig（公開）：VIP＋免運全部規則數值（VIP 介紹頁／結帳顯示用）
 * ─ checkoutQuote（登入）：結帳報價（VIP 折扣＋優惠碼＋免運判定，server 重算唔信前端）
 * ─ listStations（公開）：順豐站點下拉資料（只回 active）
 * ─ adminListStations／upsertStation／deleteStation／reseedDefaultStations（admin）：後台站點管理
 * 規則引擎同註解喺 api/vip.ts。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { sfStations, siteSettings, users } from "@db/schema";
import { createRouter, publicQuery, authedProcedure, adminProcedure } from "./middleware";
import { logAudit } from "./audit";
import { SF_STATIONS } from "./data/sfStations";
import { SF_STATIONS_FULL } from "./data/sfStationsFull"; // v2.1.0：reseed 用全量官方清單（HK 1654／MO 51）；樣例清單留作 fallback
import {
  computeCheckoutQuote,
  effectiveVipTier,
  getShippingRules,
  getVipRules,
  regionInputSchema,
  deliveryMethodInputSchema,
  yearSpendCents,
  type VipTier,
} from "./vip";

/** checkoutQuote 內部錯誤 → 中文 TRPCError（同 orders.create 嘅口吻一致） */
function quoteError(e: unknown): never {
  const msg = e instanceof Error ? e.message : "";
  if (msg === "CART_EMPTY") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "購物車係空嘅" });
  }
  if (msg === "STATION_INVALID") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "站點唔存在或已停用" });
  }
  if (msg === "STATION_REGION_MISMATCH") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "站點同收件地區唔啱，請重新揀過" });
  }
  throw e;
}

const stationInputSchema = z.object({
  id: z.string().trim().min(1).max(64),
  region: z.enum(["HK", "MO"]),
  type: z.enum(["SF_STATION", "SF_LOCKER", "SERVICE_POINT"]),
  name: z.string().trim().min(1, "站點名稱唔可以留空").max(255),
  district: z.string().trim().max(64).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const vipRouter = createRouter({
  /**
   * 我嘅 VIP 狀態（登入）：級別（過期即當 NONE 顯示）＋生效／到期時間＋本年度已付款消費＋
   * 全部門檻／折扣率＋toNextTierCents（已係金就 0；銀就係距離金嘅差額；普通就係距離銀嘅差額）。
   */
  getMyVip: authedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const user = await db.query.users.findFirst({
      where: eq(users.id, ctx.user.userId),
    });
    if (!user) {
      throw new TRPCError({ code: "NOT_FOUND", message: "用戶不存在" });
    }
    const rules = await getVipRules();
    const spend = await yearSpendCents(ctx.user.userId);
    const tier: VipTier = effectiveVipTier(user);
    const toNextTierCents =
      tier === "GOLD"
        ? 0
        : tier === "SILVER"
          ? Math.max(0, rules.goldThresholdCents - spend)
          : Math.max(0, rules.silverThresholdCents - spend);
    return {
      tier,
      effectiveAt: tier === "NONE" ? null : user.vipEffectiveAt,
      expiresAt: tier === "NONE" ? null : user.vipExpiresAt,
      yearSpendCents: spend,
      silverThresholdCents: rules.silverThresholdCents,
      goldThresholdCents: rules.goldThresholdCents,
      silverDiscountBps: rules.silverDiscountBps,
      goldDiscountBps: rules.goldDiscountBps,
      toNextTierCents,
    };
  }),

  /** VIP＋免運全部規則數值（公開）：介紹頁／結帳頁顯示用；金額全部整數仙、折扣率 bps */
  getPublicVipConfig: publicQuery.query(async () => {
    const vip = await getVipRules();
    const shipping = await getShippingRules();
    return { ...vip, ...shipping };
  }),

  /**
   * 結帳報價（登入）：由 server 由購物車重算——
   * VIP 折扣（先）＋優惠碼（後，以 VIP 折後價做基數）＋免運判定；
   * 回契約欄位＋正規化後嘅 region/deliveryMethod/stationName 畀前端顯示。
   */
  checkoutQuote: authedProcedure
    .input(
      z.object({
        region: regionInputSchema,
        deliveryMethod: deliveryMethodInputSchema,
        stationId: z.string().trim().max(64).optional(),
        couponCode: z.string().trim().max(32).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        const q = await computeCheckoutQuote(ctx.user.userId, input);
        return {
          subtotalCents: q.subtotalCents,
          vipDiscountCents: q.vipDiscountCents,
          couponDiscountCents: q.couponDiscountCents,
          totalCents: q.totalCents,
          shippingFree: q.shippingFree,
          shippingLabel: q.shippingLabel,
          remarks: q.remarks,
          region: q.region,
          deliveryMethod: q.deliveryMethod,
          stationId: q.stationId,
          stationName: q.stationName,
          vipTier: q.vipTier,
        };
      } catch (e) {
        quoteError(e);
      }
    }),

  /** 站點清單（公開）：只回 active，按 sortOrder→名稱排；下拉先揀地區再揀類型 */
  listStations: publicQuery
    .input(
      z.object({
        region: z.enum(["HK", "MO"]),
        type: z.enum(["SF_STATION", "SF_LOCKER", "SERVICE_POINT"]).optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();
      return db.query.sfStations.findMany({
        where: and(
          eq(sfStations.region, input.region),
          eq(sfStations.active, true),
          input.type ? eq(sfStations.type, input.type) : undefined,
        ),
        orderBy: [asc(sfStations.sortOrder), asc(sfStations.name)],
      });
    }),

  // ─────────────────────── 後台站點管理（admin 專用） ───────────────────────

  /** 後台站點列表（admin）：連停用嘅都回，俾管理員改 */
  adminListStations: adminProcedure.query(async () => {
    const db = getDb();
    return db.query.sfStations.findMany({
      orderBy: [asc(sfStations.region), asc(sfStations.sortOrder), asc(sfStations.name)],
    });
  }),

  /**
   * 新增／更新站點（admin）：id 存在就 update、唔存在就 insert；
   * undefined 嘅可選欄 update 時唔郁（insert 時用預設）。
   */
  upsertStation: adminProcedure
    .input(stationInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const existing = await db.query.sfStations.findFirst({
        where: eq(sfStations.id, input.id),
      });
      if (existing) {
        await db
          .update(sfStations)
          .set({
            region: input.region,
            type: input.type,
            name: input.name,
            district: input.district === undefined ? existing.district : input.district,
            address: input.address === undefined ? existing.address : input.address,
            active: input.active ?? existing.active,
            sortOrder: input.sortOrder ?? existing.sortOrder,
          })
          .where(eq(sfStations.id, input.id));
      } else {
        await db.insert(sfStations).values({
          id: input.id,
          region: input.region,
          type: input.type,
          name: input.name,
          district: input.district ?? null,
          address: input.address ?? null,
          active: input.active ?? true,
          sortOrder: input.sortOrder ?? 0,
        });
      }
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "station.upsert",
        targetType: "setting",
        targetId: input.id,
        detail: `${existing ? "更新" : "新增"}順豐站點「${input.name}」（${input.region}/${input.type}${input.active === false ? "，已停用" : ""}）`,
      });
      return { ok: true as const, created: !existing };
    }),

  /** 刪除站點（admin）：直接刪 row；歷史訂單有 stationName 快照，唔受影響 */
  deleteStation: adminProcedure
    .input(z.object({ id: z.string().trim().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const existing = await db.query.sfStations.findFirst({
        where: eq(sfStations.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "站點唔存在" });
      }
      await db.delete(sfStations).where(eq(sfStations.id, input.id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "station.delete",
        targetType: "setting",
        targetId: input.id,
        detail: `刪除順豐站點「${existing.name}」（${input.id}）`,
      });
      return { ok: true as const };
    }),

  /**
   * 重新導入預設站點清單（admin）：將 api/data/sfStations.ts 嘅樣例逐個 upsert——
   * 唔會清走後台自加嘅站；同 id 嘅站會被預設資料覆蓋（active 照舊保留而家值）。
   * 正式完整清單整合後，用呢度一掣倒入。
   */
  reseedDefaultStations: adminProcedure.mutation(async ({ ctx }) => {
    const db = getDb();
    const SEED_LIST = (SF_STATIONS_FULL.length > 0 ? SF_STATIONS_FULL : SF_STATIONS.map((x, i) => ({ ...x, sortOrder: i })));
    for (const [i, s] of SEED_LIST.entries()) {
      await db
        .insert(sfStations)
        .values({ ...s, sortOrder: i })
        .onConflictDoUpdate({
          target: sfStations.id,
          set: {
            region: s.region,
            type: s.type,
            name: s.name,
            district: s.district ?? null,
            address: s.address ?? null,
            sortOrder: i,
          },
        });
    }
    void logAudit({
      actorId: ctx.user.userId,
      actorRole: ctx.user.role,
      action: "station.reseed",
      targetType: "setting",
      targetId: "sfStations",
      detail: `重新導入預設順豐站點清單（${SEED_LIST.length} 個站${SF_STATIONS_FULL.length > 0 ? "・全量官方清單" : "・樣例"}）`,
    });
    return { ok: true as const, count: SEED_LIST.length };
  }),

  /**
   * v2.1.1（Wave 2，2026-09-30）：立即同步順豐官方站點（admin 專用）。
   * 即跑一次 api/sfSync.ts 嘅全量同步（同每日排程同一條路），回 stats＋lastSyncAt；
   * 同步本身 never-throw，失敗類別會喺 stats.perTypeFailed 睇到。
   */
  adminSyncStationsNow: adminProcedure.mutation(async ({ ctx }) => {
    const { runSfSync } = await import("./sfSync"); // lazy import：同 boot.ts 嘅模組隔離款一致
    const stats = await runSfSync();
    const db = getDb();
    const lastSyncRow = await db.query.siteSettings.findFirst({
      where: eq(siteSettings.key, "sf.lastSyncAt"),
    });
    void logAudit({
      actorId: ctx.user.userId,
      actorRole: ctx.user.role,
      action: "station.syncNow",
      targetType: "setting",
      targetId: "sfStations",
      detail: `管理員手動即時同步順豐官方站點：新增 ${stats.added}、更新 ${stats.updated}、停用 ${stats.deactivated}${stats.perTypeFailed.length > 0 ? `；失敗類別：${stats.perTypeFailed.join("、")}` : ""}`,
    });
    return { ok: true as const, stats, lastSyncAt: lastSyncRow?.value ?? null };
  }),
});
