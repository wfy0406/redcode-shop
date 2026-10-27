import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, authedProcedure, createRouter, publicQuery, supervisorProcedure } from "./middleware";
import { env } from "./lib/env";
import { logAudit } from "./audit";
import {
  getTryOnAdminRecordMedia,
  listTryOnAdminRecords,
  TRYON_ADMIN_RECORD_STATUSES,
} from "./tryonAdminRecords";
import {
  TRYON_CREDITS_PER_GENERATION,
  TRYON_MAX_MIX_STEPS,
  isTryOnMemberOpen,
  publicTryOnConfig,
  tryOnSettingsSchema,
} from "./tryonConfig";
import {
  createTryOnGeneration,
  deleteOwnedTryOnMedia,
  getMyTryOnAccess,
  getOwnedTryOnJob,
  getOwnedTryOnShareLink,
  getSharedTryOnRecord,
  getTryOnAdminStats,
  getTryOnSettings,
  listMyTryOnRecords,
  listTryOnProducts,
  saveTryOnSettings,
  tryOnMediaSecretConfigured,
} from "./tryonService";

const publicIdSchema = z.string().uuid("工作編號格式無效");
const createTryOnSchema = z
  .object({
    productId: z.number().int().positive(),
    photoIndex: z.number().int().min(0).max(50),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "操作編號格式無效"),
    modelImage: z.string().max(14_500_000, "圖片資料過大").optional(),
    sourcePublicId: publicIdSchema.optional(),
  })
  .superRefine((input, ctx) => {
    const hasModel = Boolean(input.modelImage);
    const hasSource = Boolean(input.sourcePublicId);
    if (hasModel === hasSource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasSource ? ["sourcePublicId"] : ["modelImage"],
        message: hasSource ? "追加商品只可以用上一步結果" : "請提供一張全身相，或選擇上一步試穿結果",
      });
    }
  });

function providerConfigured(): boolean {
  return Boolean(process.env.FASHN_API_KEY?.trim());
}

function requireProviderConfigured(): void {
  if (!providerConfigured()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "試穿服務尚未配置；請管理員先喺伺服器加入 FASHN_API_KEY，今次未建立工作或預留額度",
    });
  }
}

export const tryonRouter = createRouter({
  getPublicConfig: publicQuery.query(async () => {
    const settings = await getTryOnSettings();
    return {
      ...publicTryOnConfig(settings),
      // API key 或 APP_SECRET 被移除時即刻停止對外宣稱可用；後台原開關仍保留，方便修復後恢復。
      memberEnabled: isTryOnMemberOpen(settings) && providerConfigured() && tryOnMediaSecretConfigured(),
    };
  }),

  getMyAccess: authedProcedure.query(({ ctx }) => getMyTryOnAccess(ctx.user)),

  listProducts: authedProcedure.query(() => listTryOnProducts()),

  create: authedProcedure.input(createTryOnSchema).mutation(async ({ ctx, input }) => {
    requireProviderConfigured();
    return createTryOnGeneration({ ...input, user: ctx.user });
  }),

  getJob: authedProcedure.input(z.object({ publicId: publicIdSchema })).query(({ ctx, input }) =>
    getOwnedTryOnJob(ctx.user, input.publicId),
  ),

  listMyRecords: authedProcedure.query(({ ctx }) => listMyTryOnRecords(ctx.user)),

  getShareLink: authedProcedure.input(z.object({ publicId: publicIdSchema })).query(({ ctx, input }) =>
    getOwnedTryOnShareLink(ctx.user, input.publicId),
  ),

  getShared: publicQuery
    .input(
      z.object({
        publicId: publicIdSchema,
        expires: z.number().int().positive().safe(),
        signature: z.string().min(1).max(128),
      }),
    )
    .query(({ input }) => getSharedTryOnRecord(input)),

  deleteMedia: authedProcedure.input(z.object({ publicId: publicIdSchema })).mutation(({ ctx, input }) =>
    deleteOwnedTryOnMedia(ctx.user, input.publicId),
  ),

  getAdminConfig: adminProcedure.query(async () => {
    const settings = await getTryOnSettings();
    return {
      settings,
      providerConfigured: providerConfigured(),
      mediaProtectionConfigured: Boolean(env.appSecret.trim()),
      memberOpen: isTryOnMemberOpen(settings) && providerConfigured() && tryOnMediaSecretConfigured(),
      creditsPerGeneration: TRYON_CREDITS_PER_GENERATION,
      maxMixSteps: TRYON_MAX_MIX_STEPS,
    };
  }),

  setAdminConfig: adminProcedure.input(tryOnSettingsSchema).mutation(async ({ ctx, input }) => {
    if (input.memberEnabled && !providerConfigured()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "請先配置伺服器 FASHN_API_KEY，先可以開放會員使用",
      });
    }
    if (input.memberEnabled && !env.appSecret.trim()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "請先配置 APP_SECRET 私人圖片保護，先可以開放會員使用",
      });
    }
    await saveTryOnSettings(input);
    void logAudit({
      actorId: ctx.user.userId,
      actorRole: ctx.user.role,
      action: "tryon.settings",
      targetType: "setting",
      targetId: "tryon_rules",
      detail: `更新 AI 試穿規則：會員開關 ${input.memberEnabled ? "開" : "關"}；品質批准 ${input.qualityApproved ? "是" : "否"}；最低級別 ${input.minimumTier}；全站每日 ${input.siteDailyLimit} 次；每月預算 ${input.monthlyBudgetCents} 仙`,
    });
    return { ok: true as const, settings: input };
  }),

  getAdminStats: adminProcedure.query(() => getTryOnAdminStats()),

  // 後台試穿紀錄：supervisor／admin 專用。列表只回公開商品圖 snapshot；
  // 私人原相／生成圖要另按「查看圖片」即場簽發，绝唔批量放入列表。
  listAdminRecords: supervisorProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(50).default(20),
        status: z.enum(TRYON_ADMIN_RECORD_STATUSES).optional(),
        member: z.string().trim().max(100).optional(),
        product: z.string().trim().max(100).optional(),
      }),
    )
    .query(({ input }) => listTryOnAdminRecords(input)),

  getAdminRecordMedia: supervisorProcedure
    .input(z.object({ publicId: publicIdSchema }))
    .query(({ input }) => getTryOnAdminRecordMedia(input.publicId)),
});
