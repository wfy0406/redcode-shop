import { z } from "zod";
import type { TryOnProductKind } from "@contracts/tryon";

/** AI 試穿唯一成本及件數契約；畫面不得自行估另一套數。 */
export const TRYON_SETTING_KEY = "tryon_rules";
export const TRYON_CREDITS_PER_GENERATION = 3;
export const TRYON_MAX_MIX_STEPS = 3;
export const TRYON_MEDIA_RETENTION_MS = 24 * 60 * 60 * 1000;
export const TRYON_ACTIVE_STATUSES = ["queued", "processing"] as const;
export const TRYON_USAGE_STATUSES = ["queued", "processing", "completed"] as const;
export const TRYON_WEARABLE_CATEGORIES = ["top", "pants", "dress", "shoes", "accessory"] as const;

export type TryOnRole = "member" | "staff" | "supervisor" | "admin";
export type TryOnTier = "NONE" | "SILVER" | "GOLD";
export type TryOnStatus = "queued" | "processing" | "completed" | "failed";

export const tryOnSettingsSchema = z
  .object({
    memberEnabled: z.boolean().default(false),
    qualityApproved: z.boolean().default(false),
    minimumTier: z.enum(["NONE", "SILVER", "GOLD"]).default("NONE"),
    dailyLimitNone: z.number().int().min(0).max(100).default(0),
    dailyLimitSilver: z.number().int().min(0).max(100).default(1),
    dailyLimitGold: z.number().int().min(0).max(100).default(2),
    staffDailyLimit: z.number().int().min(1).max(100).default(5),
    siteDailyLimit: z.number().int().min(1).max(1000).default(20),
    creditCostCents: z.number().int().min(0).max(1_000_000).default(0),
    monthlyBudgetCents: z.number().int().min(0).max(1_000_000_000).default(0),
  })
  .superRefine((settings, ctx) => {
    if (!settings.memberEnabled) return;
    if (!settings.qualityApproved) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["qualityApproved"],
        message: "開放會員前，必須先完成真人及真商品品質驗收",
      });
    }
    if (settings.creditCostCents <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["creditCostCents"],
        message: "開放會員前，必須填寫每 credit 估算成本",
      });
    }
    if (settings.monthlyBudgetCents <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["monthlyBudgetCents"],
        message: "開放會員前，必須設定每月預算上限",
      });
    }
    const eligible =
      settings.minimumTier === "NONE"
        ? Math.max(settings.dailyLimitNone, settings.dailyLimitSilver, settings.dailyLimitGold)
        : settings.minimumTier === "SILVER"
          ? Math.max(settings.dailyLimitSilver, settings.dailyLimitGold)
          : settings.dailyLimitGold;
    if (eligible <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minimumTier"],
        message: "合資格會員級別至少要有一次每日額度",
      });
    }
  });

export type TryOnSettings = z.infer<typeof tryOnSettingsSchema>;

export const DEFAULT_TRYON_SETTINGS: TryOnSettings = tryOnSettingsSchema.parse({});

/** DB JSON 壞咗／舊版缺欄時安全落入「會員關閉」，唔會因缺新欄而誤開。 */
export function parseTryOnSettings(raw: string | null | undefined): TryOnSettings {
  if (!raw) return DEFAULT_TRYON_SETTINGS;
  try {
    const parsed = tryOnSettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_TRYON_SETTINGS;
  } catch {
    return DEFAULT_TRYON_SETTINGS;
  }
}

export function isTryOnStaff(role: TryOnRole): boolean {
  return role === "staff" || role === "supervisor" || role === "admin";
}

export function tryOnTierRank(tier: TryOnTier): number {
  return tier === "GOLD" ? 2 : tier === "SILVER" ? 1 : 0;
}

/** 除 admin 旗標外再核對品質及成本閘口，避免手改 DB JSON 令未準備好嘅功能曝光。 */
export function isTryOnMemberOpen(settings: TryOnSettings): boolean {
  return (
    settings.memberEnabled &&
    settings.qualityApproved &&
    settings.creditCostCents > 0 &&
    settings.monthlyBudgetCents > 0
  );
}

export function canUseTryOn(
  role: TryOnRole,
  effectiveTier: TryOnTier,
  settings: TryOnSettings,
): boolean {
  if (isTryOnStaff(role)) return true;
  return (
    isTryOnMemberOpen(settings) &&
    tryOnTierRank(effectiveTier) >= tryOnTierRank(settings.minimumTier)
  );
}

export function tryOnDailyLimit(
  role: TryOnRole,
  effectiveTier: TryOnTier,
  settings: TryOnSettings,
): number {
  if (isTryOnStaff(role)) return settings.staffDailyLimit;
  if (effectiveTier === "GOLD") return settings.dailyLimitGold;
  if (effectiveTier === "SILVER") return settings.dailyLimitSilver;
  return settings.dailyLimitNone;
}

export function isTryOnWearable(category: string): boolean {
  return (TRYON_WEARABLE_CATEGORIES as readonly string[]).includes(category);
}

export function countsTowardTryOnUsage(status: string): status is TryOnStatus {
  return (TRYON_USAGE_STATUSES as readonly string[]).includes(status);
}

export type TryOnLineageConflict = "BRANCH" | "DUPLICATE_PRODUCT" | "DUPLICATE_KIND" | null;

/**
 * 分叉同防重複係兩層閘口：
 * - BRANCH 只睇「媒體未刪除」嘅有效後續步；刪除咗最新一步之後，由上一步再追加唔會被已刪 row 永久阻死。
 * - 商品／部位防重複睇 source 已實際沿用到嘅步（stepNumber <= sourceStepNumber）：
 *   即使中間某步嘅私人媒體已刪，只要而家係由更後嘅步追加，件商品仍可能出現喺 source 圖入面，所以仍要防重。
 * 失敗 attempt 兩層都唔佔造型部位；usage/quota 計數唔受此影響。
 */
export function findTryOnLineageConflict(args: {
  rows: ReadonlyArray<{
    productId: number;
    stepNumber: number;
    tryOnKind: string;
    status: string;
    mediaDeletedAt: Date | null;
  }>;
  sourceStepNumber: number;
  productId: number;
  tryOnKind: TryOnProductKind;
}): TryOnLineageConflict {
  const active = args.rows.filter((row) => countsTowardTryOnUsage(row.status));
  if (active.some((row) => !row.mediaDeletedAt && row.stepNumber > args.sourceStepNumber)) return "BRANCH";
  const worn = active.filter((row) => row.stepNumber <= args.sourceStepNumber);
  if (worn.some((row) => row.productId === args.productId)) return "DUPLICATE_PRODUCT";
  if (worn.some((row) => row.tryOnKind === args.tryOnKind)) return "DUPLICATE_KIND";
  return null;
}

export interface TryOnUsageSnapshot {
  userUsed: number;
  siteUsed: number;
  monthReservedCents: number;
}

export type TryOnAdmission =
  | {
      ok: true;
      dailyLimit: number;
      remainingAfterReservation: number;
      estimatedCostCents: number | null;
    }
  | {
      ok: false;
      code: "FORBIDDEN" | "DAILY_LIMIT" | "SITE_DAILY_LIMIT" | "MONTHLY_BUDGET" | "COST_UNKNOWN";
      message: string;
    };

/**
 * 同一個純函數供 getMyAccess 同 transaction 內落單使用。
 * queued/processing/completed 先會傳入 usage；failed 已在查詢層排除。
 */
export function evaluateTryOnAdmission(args: {
  role: TryOnRole;
  effectiveTier: TryOnTier;
  settings: TryOnSettings;
  usage: TryOnUsageSnapshot;
}): TryOnAdmission {
  const { role, effectiveTier, settings, usage } = args;
  if (!canUseTryOn(role, effectiveTier, settings)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: isTryOnStaff(role)
        ? "需要同事或管理員權限"
        : "AI 試穿暫時未開放畀你嘅會員級別",
    };
  }
  if (usage.siteUsed >= settings.siteDailyLimit) {
    return {
      ok: false,
      code: "SITE_DAILY_LIMIT",
      message: "今日全站試穿額度已用完，請聽日再試",
    };
  }
  const dailyLimit = tryOnDailyLimit(role, effectiveTier, settings);
  if (dailyLimit <= 0) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "你嘅會員級別暫時未有試穿額度，請留意會員頁嘅開放安排",
    };
  }
  if (usage.userUsed >= dailyLimit) {
    return {
      ok: false,
      code: "DAILY_LIMIT",
      message: `你今日嘅 ${dailyLimit} 次試穿額度已用完；失敗生成唔會扣次數`,
    };
  }
  const estimatedCostCents =
    settings.creditCostCents > 0
      ? settings.creditCostCents * TRYON_CREDITS_PER_GENERATION
      : null;
  if (settings.monthlyBudgetCents > 0) {
    if (estimatedCostCents === null) {
      return {
        ok: false,
        code: "COST_UNKNOWN",
        message: "已設每月預算但未填成本單價，為免超支已暫停生成",
      };
    }
    if (usage.monthReservedCents + estimatedCostCents > settings.monthlyBudgetCents) {
      return {
        ok: false,
        code: "MONTHLY_BUDGET",
        message: "本月試穿預算已用完（處理中用量亦會預留），請下月再試或聯絡管理員",
      };
    }
  }
  return {
    ok: true,
    dailyLimit,
    remainingAfterReservation: Math.max(0, dailyLimit - usage.userUsed - 1),
    estimatedCostCents,
  };
}

/** 香港固定 UTC+8，唔依賴 Render 主機時區。 */
export function tryOnHongKongPeriods(now = new Date()): {
  date: string;
  month: string;
  year: string;
} {
  const hk = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();
  return { date: hk.slice(0, 10), month: hk.slice(0, 7), year: hk.slice(0, 4) };
}

export function publicTryOnConfig(settings: TryOnSettings) {
  const memberEnabled = isTryOnMemberOpen(settings);
  return {
    memberEnabled,
    minimumTier: settings.minimumTier,
    dailyLimitNone: settings.dailyLimitNone,
    dailyLimitSilver: settings.dailyLimitSilver,
    dailyLimitGold: settings.dailyLimitGold,
    maxMixSteps: TRYON_MAX_MIX_STEPS,
    creditsPerGeneration: TRYON_CREDITS_PER_GENERATION,
  };
}
