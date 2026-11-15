/**
 * Glo Glo 精選文章——官網 /admin 後台 tRPC adapter（router 名 gloGuideAdmin）。
 *
 * 同公開 `gloGuide` router 完全分開：呢度全部要員工 JWT（staffProcedure），
 * approve／reject／archive／逐圖審批（imageReview）再加 supervisorProcedure（主管／管理員）
 * ——service.reviewImage 本身冇 role 閘，權限一定要喺呢度收緊。
 *
 * 信任模型（同 WMS 線唔同）：actor 永遠由 ctx.user server-side 建立——
 * id／role 來自己覆核 DB 嘅 JWT 身份（middleware requireStaff／requireSupervisor），
 * name 即場以 PK 查 users 表；client 傳入嘅 role／name 一律唔信（input 根本冇呢啲欄位）。
 *
 * 錯誤映射：service 層 throw GloGuideError（httpStatus＋中文訊息）→ 呢度轉正確 tRPC code；
 * 未識別錯誤落 INTERNAL_SERVER_ERROR＋server log，唔洩內部細節。
 *
 * 內部未發布圖預覽：imageRead 行 service readImageForPreview（員工 JWT 閘＋audit），
 * base64 回傳，唔會繞過公開 media gate（嗰條線只放行 published）。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { createRouter, staffProcedure, supervisorProcedure, type AuthUser } from "./middleware";
import { getDb } from "./queries/connection";
import { users } from "@db/schema";
import * as service from "./gloGuideService";
import { GloGuideError } from "./gloGuideService";
import { defaultGloGuideProviders } from "./gloGuideProviders";
import { GLO_GUIDE_ACTOR_ROLES, type GloGuideActor } from "./gloGuideValidation";

/** GloGuideError httpStatus → tRPC code（白名單；其他一律 INTERNAL） */
function mapGloGuideError(e: unknown): TRPCError {
  if (e instanceof TRPCError) return e;
  if (e instanceof GloGuideError) {
    const code =
      e.httpStatus === 400
        ? "BAD_REQUEST"
        : e.httpStatus === 401
          ? "UNAUTHORIZED"
          : e.httpStatus === 403
            ? "FORBIDDEN"
            : e.httpStatus === 404
              ? "NOT_FOUND"
              : e.httpStatus === 409
                ? "CONFLICT"
                : "INTERNAL_SERVER_ERROR";
    return new TRPCError({ code, message: e.message });
  }
  console.error("[glo-guide-admin] 意外錯誤:", e);
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "內部錯誤，請稍後再試" });
}

/**
 * 由 ctx.user 砌 service actor：role 用 middleware 覆核後嘅 DB role；
 * name 以 PK 即場查 users 表（唔信 JWT／client）。查唔到用兜底名，唔會因此 500。
 */
export async function actorFromAuthUser(user: AuthUser): Promise<GloGuideActor> {
  if (!GLO_GUIDE_ACTOR_ROLES.includes(user.role as GloGuideActor["role"])) {
    throw new TRPCError({ code: "FORBIDDEN", message: "需要員工權限" });
  }
  let name = "";
  try {
    const db = getDb();
    const [row] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, user.userId))
      .limit(1);
    name = (row?.name ?? "").trim();
  } catch (e) {
    console.error("[glo-guide-admin] 查員工名失敗（用兜底名）:", e);
  }
  return {
    id: user.userId,
    name: (name || `員工 #${user.userId}`).slice(0, 64),
    role: user.role as GloGuideActor["role"],
  };
}

// ── 輸入 schema（zod 只擋形狀／極端長度；業務硬閘留返 service 用中文真錯誤）──
const idSchema = z.number().int().positive();
const articleIdInput = z.object({ id: idSchema });
const productIdsSchema = z.array(z.number().int().positive()).max(3).optional();

// SPEC 第 3 輪凍結 contract：商品查詢 filter／生成 selection（形狀閘；
// weekStart 要星期一、liveDate 要真實日期、productIds 歸屬／歷史等業務閘喺 service 重查）
const productFilterSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto") }),
  z.object({ mode: z.literal("week"), weekStart: z.string().max(16) }),
  z.object({
    mode: z.literal("session"),
    liveDate: z.string().max(16),
    liveSession: z.string().min(1).max(16),
  }),
  z.object({ mode: z.literal("search"), query: z.string().min(1).max(60) }),
]);

const generateSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto") }),
  z.object({
    mode: z.literal("week"),
    weekStart: z.string().max(16),
    productIds: productIdsSchema,
  }),
  z.object({
    mode: z.literal("session"),
    liveDate: z.string().max(16),
    liveSession: z.string().min(1).max(16),
    productIds: productIdsSchema,
  }),
  z.object({
    mode: z.literal("products"),
    productIds: z.array(z.number().int().positive()).max(3),
  }),
]);

export const gloGuideAdminRouter = createRouter({
  /** 商品查詢（SPEC 第 3 輪）：input 直接係 filter（{mode,...}，同 WMS products.list payload 一樣）；回 { items: GloGuideProductRef[] } */
  products: staffProcedure
    .input(productFilterSchema.optional())
    .query(async ({ input }) => {
      try {
        return { items: await service.listGloGuideProducts(input) };
      } catch (e) {
        throw mapGloGuideError(e);
      }
    }),

  /** 選貨來源概覽（SPEC productSources）：星期／場次選項＋total/eligible 數 */
  productSources: staffProcedure.query(async () => {
    try {
      return await service.listGloGuideProductSources();
    } catch (e) {
      throw mapGloGuideError(e);
    }
  }),

  /** 本週可選商品（兼容 alias；新介面用 products query） */
  weeklyProducts: staffProcedure.query(async () => {
    try {
      return { items: await service.listWeeklyProducts() };
    } catch (e) {
      throw mapGloGuideError(e);
    }
  }),

  /** 後台文章列表（全部狀態；系統自動稿同手動稿共用 DB 同一 list） */
  articles: staffProcedure
    .input(
      z
        .object({
          status: z
            .enum(["draft", "pending_review", "published", "rejected", "archived"])
            .optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      try {
        return { items: await service.listArticleSummaries(input ?? {}) };
      } catch (e) {
        throw mapGloGuideError(e);
      }
    }),

  /** 單篇完整 bundle（商品＋圖＋job 摘要） */
  article: staffProcedure.input(articleIdInput).query(async ({ input }) => {
    try {
      return service.toInternalArticle(await service.getArticleBundle(input.id));
    } catch (e) {
      throw mapGloGuideError(e);
    }
  }),

  /** 手動產生完整文章＋相（SPEC 第 3 輪：selection 四模式；舊 productIds ＝ products 模式；唔揀就 auto 逐週 fallback） */
  generate: staffProcedure
    .input(
      z.object({
        selection: generateSelectionSchema.optional(),
        productIds: productIdsSchema,
        themeHint: z.string().max(120).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const actor = await actorFromAuthUser(ctx.user);
        return await service.generateArticle(actor, {
          selection: input.selection,
          productIds: input.productIds,
          themeHint: input.themeHint,
        });
      } catch (e) {
        throw mapGloGuideError(e);
      }
    }),

  /** 重新生成文章文字（圖片審批會重置 pending） */
  regenerate: staffProcedure
    .input(z.object({ id: idSchema, themeHint: z.string().max(120).optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const actor = await actorFromAuthUser(ctx.user);
        return await service.regenerateArticle(actor, {
          id: input.id,
          themeHint: input.themeHint,
        });
      } catch (e) {
        throw mapGloGuideError(e);
      }
    }),

  /** 編輯標題／主題／內文（富文本 tokens 由 service 驗證）；可順手改商品 */
  update: staffProcedure
    .input(
      z.object({
        id: idSchema,
        title: z.string().max(500),
        body: z.string().max(4000),
        theme: z.string().max(500),
        productIds: productIdsSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const actor = await actorFromAuthUser(ctx.user);
        return await service.updateArticle(actor, input);
      } catch (e) {
        throw mapGloGuideError(e);
      }
    }),

  /** 提交審批（draft/rejected → pending_review） */
  submit: staffProcedure.input(articleIdInput).mutation(async ({ ctx, input }) => {
    try {
      const actor = await actorFromAuthUser(ctx.user);
      return await service.submitArticle(actor, input.id);
    } catch (e) {
      throw mapGloGuideError(e);
    }
  }),

  /** 批准即上架（只主管／管理員；service 會喺 transaction 重驗全部發布閘） */
  approve: supervisorProcedure.input(articleIdInput).mutation(async ({ ctx, input }) => {
    try {
      const actor = await actorFromAuthUser(ctx.user);
      return await service.approveArticle(actor, input.id);
    } catch (e) {
      throw mapGloGuideError(e);
    }
  }),

  /** 拒絕（只主管／管理員；原因必填留底） */
  reject: supervisorProcedure
    .input(z.object({ id: idSchema, reason: z.string().max(1000) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const actor = await actorFromAuthUser(ctx.user);
        return await service.rejectArticle(actor, { id: input.id, reason: input.reason });
      } catch (e) {
        throw mapGloGuideError(e);
      }
    }),

  /** 落架（只主管／管理員；published → archived，公開即時停） */
  archive: supervisorProcedure.input(articleIdInput).mutation(async ({ ctx, input }) => {
    try {
      const actor = await actorFromAuthUser(ctx.user);
      return await service.archiveArticle(actor, input.id);
    } catch (e) {
      throw mapGloGuideError(e);
    }
  }),

  /** 逐圖重生（傳 imageId）或按已選商品補齊生成 */
  imageGenerate: staffProcedure
    .input(
      z.object({
        id: idSchema,
        imageId: idSchema.optional(),
        productId: idSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const actor = await actorFromAuthUser(ctx.user);
        return await service.generateImages(actor, input);
      } catch (e) {
        throw mapGloGuideError(e);
      }
    }),

  /** 人工上傳圖（base64 ≤10MB；service sharp 驗真圖＋re-encode 持久化） */
  imageUpload: staffProcedure
    .input(
      z.object({
        id: idSchema,
        productId: idSchema,
        filename: z.string().max(120),
        mime: z.string().max(64),
        // base64 字串：10MB 二進制 ≈ 13.4M chars，頂到盡收 14M 由 service 再精準擋
        dataBase64: z.string().min(1).max(14_000_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const actor = await actorFromAuthUser(ctx.user);
        return await service.uploadImage(actor, input, defaultGloGuideProviders());
      } catch (e) {
        throw mapGloGuideError(e);
      }
    }),

  /** 軟刪圖（歷史審批留底） */
  imageDelete: staffProcedure
    .input(z.object({ id: idSchema, imageId: idSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        const actor = await actorFromAuthUser(ctx.user);
        return await service.deleteImage(actor, input);
      } catch (e) {
        throw mapGloGuideError(e);
      }
    }),

  /** 逐圖人工審批（approved／rejected；rejected 要 note）——審批係主管權限 */
  imageReview: supervisorProcedure
    .input(
      z.object({
        id: idSchema,
        imageId: idSchema,
        decision: z.enum(["approved", "rejected"]),
        note: z.string().max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const actor = await actorFromAuthUser(ctx.user);
        return await service.reviewImage(actor, input);
      } catch (e) {
        throw mapGloGuideError(e);
      }
    }),

  /** 內部審批預覽：base64 讀圖（員工 JWT 閘；未發布圖唔會經公開 media gate 流出） */
  imageRead: staffProcedure
    .input(z.object({ id: idSchema, imageId: idSchema }))
    .query(async ({ ctx, input }) => {
      try {
        const actor = await actorFromAuthUser(ctx.user);
        return await service.readImageForPreview(actor, input);
      } catch (e) {
        throw mapGloGuideError(e);
      }
    }),

  // ── 模特兒原圖管理（真實授權相；絕不公開，預覽行 JWT base64）──
  // Fashn 每次淨係用預設嗰一張；其他係備用。新建文章用當刻預設做快照，
  // 舊文章保留當初快照——呢度任何改動都唔會回寫舊文章。

  /** 模特兒原圖列表＋而家生效預設（DB 冇相會標示 ENV／內建 fallback） */
  modelImages: staffProcedure.query(async () => {
    try {
      return await service.listModelImages();
    } catch (e) {
      throw mapGloGuideError(e);
    }
  }),

  /** 上傳模特兒原圖（base64 ≤10MB；service sharp 驗真圖＋re-encode 持久化，最多 8 張） */
  modelImageUpload: staffProcedure
    .input(
      z.object({
        filename: z.string().max(200),
        mime: z.string().max(64),
        // base64 字串：10MB 二進制 ≈ 13.4M chars，頂到盡收 14M 由 service 再精準擋
        dataBase64: z.string().min(1).max(14_000_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const actor = await actorFromAuthUser(ctx.user);
        return await service.uploadModelImage(actor, input);
      } catch (e) {
        throw mapGloGuideError(e);
      }
    }),

  /** 設定預設模特兒原圖（之後新建文章先用；舊文章快照唔變） */
  modelImageSetDefault: staffProcedure
    .input(z.object({ id: idSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        const actor = await actorFromAuthUser(ctx.user);
        return await service.setDefaultModelImage(actor, input);
      } catch (e) {
        throw mapGloGuideError(e);
      }
    }),

  /** 軟刪模特兒原圖（留審計；預設被刪會自動升最早備用相；舊文章快照唔變） */
  modelImageDelete: staffProcedure
    .input(z.object({ id: idSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        const actor = await actorFromAuthUser(ctx.user);
        return await service.deleteModelImage(actor, input);
      } catch (e) {
        throw mapGloGuideError(e);
      }
    }),

  /** 模特兒原圖預覽：base64 讀圖（員工 JWT 閘；目錄唔公開，冇公開路由） */
  modelImageRead: staffProcedure
    .input(z.object({ id: idSchema }))
    .query(async ({ ctx, input }) => {
      try {
        const actor = await actorFromAuthUser(ctx.user);
        return await service.readModelImageForPreview(actor, input);
      } catch (e) {
        throw mapGloGuideError(e);
      }
    }),
});

export type GloGuideAdminRouter = typeof gloGuideAdminRouter;
