import { createHash, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sum } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { products, siteSettings, tryOnJobs, users, type TryOnJob } from "@db/schema";
import {
  latestTryOnAttemptsByStep,
  resolveTryOnProductKind,
  type TryOnProductKind,
} from "@contracts/tryon";
import { effectiveVipTier } from "./vip";
import { env } from "./lib/env";
import {
  DEFAULT_TRYON_SETTINGS,
  TRYON_CREDITS_PER_GENERATION,
  TRYON_MAX_MIX_STEPS,
  TRYON_MEDIA_RETENTION_MS,
  TRYON_SETTING_KEY,
  TRYON_USAGE_STATUSES,
  evaluateTryOnAdmission,
  findTryOnLineageConflict,
  isTryOnMemberOpen,
  isTryOnStaff,
  parseTryOnSettings,
  tryOnDailyLimit,
  tryOnHongKongPeriods,
  type TryOnRole,
  type TryOnSettings,
} from "./tryonConfig";
import {
  configuredTryOnProvider,
  TryOnProviderError,
  type TryOnProvider,
} from "./tryonProvider";
import {
  TryOnMediaError,
  assertTryOnMediaSecret,
  bufferToDataUri,
  deleteTryOnMedia,
  detectTryOnImageMime,
  normalizeTryOnModelImage,
  normalizeTryOnProviderOutput,
  readTryOnMedia,
  signTryOnMediaUrl,
  tryOnMediaRelativePath,
  tryOnProductImageInput,
  writeTryOnMedia,
} from "./tryonMedia";
import { inspectTryOnModelImage } from "./tryonPreflight";
import {
  TRYON_ADMIN_ARCHIVE_RETENTION_MS,
  archiveTryOnMediaCopy,
  deleteTryOnAdminArchive,
} from "./tryonAdminArchive";
import { signTryOnShare, verifyTryOnShare } from "./tryonSharing";
import type { AuthUser } from "./middleware";

const USAGE_STATUS_LIST = [...TRYON_USAGE_STATUSES] as string[];
const runningJobs = new Set<number>();
export const TRYON_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const TRYON_SUBMIT_UNCERTAIN_MS = 2 * 60 * 1000;
const TRYON_STALE_AFTER_MS = 15 * 1000;

function admissionError(result: { code: string; message: string }): TRPCError {
  if (result.code === "FORBIDDEN") return new TRPCError({ code: "FORBIDDEN", message: result.message });
  if (result.code === "DAILY_LIMIT" || result.code === "SITE_DAILY_LIMIT" || result.code === "MONTHLY_BUDGET") {
    return new TRPCError({ code: "TOO_MANY_REQUESTS", message: result.message });
  }
  return new TRPCError({ code: "BAD_REQUEST", message: result.message });
}

export async function getTryOnSettings(): Promise<TryOnSettings> {
  const db = getDb();
  const [row] = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, TRYON_SETTING_KEY))
    .limit(1);
  return parseTryOnSettings(row?.value);
}

export async function saveTryOnSettings(settings: TryOnSettings): Promise<void> {
  const db = getDb();
  await db
    .insert(siteSettings)
    .values({ key: TRYON_SETTING_KEY, value: JSON.stringify(settings), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: siteSettings.key,
      set: { value: JSON.stringify(settings), updatedAt: new Date() },
    });
}

async function ensureTryOnSettingsRow(): Promise<void> {
  const db = getDb();
  await db
    .insert(siteSettings)
    .values({ key: TRYON_SETTING_KEY, value: JSON.stringify(DEFAULT_TRYON_SETTINGS) })
    .onConflictDoNothing();
}

async function currentUserAccess(userId: number) {
  const db = getDb();
  const [row] = await db
    .select({ role: users.role, vipTier: users.vipTier, vipExpiresAt: users.vipExpiresAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new TRPCError({ code: "UNAUTHORIZED", message: "帳號已不存在，請重新登入" });
  return {
    role: row.role as TryOnRole,
    tier: effectiveVipTier(row),
  };
}

/**
 * 對外開放狀態必須同 create 嘅 assertTryOnMediaSecret 閘口一致：
 * APP_SECRET 缺失時唔可以對外宣稱已開放／可提交。只回 boolean，絕唔 expose secret 內容。
 */
export function tryOnMediaSecretConfigured(): boolean {
  try {
    assertTryOnMediaSecret(env.appSecret);
    return true;
  } catch {
    return false;
  }
}

export async function getMyTryOnAccess(user: AuthUser) {
  const [settings, identity] = await Promise.all([getTryOnSettings(), currentUserAccess(user.userId)]);
  const db = getDb();
  const periods = tryOnHongKongPeriods();
  const [[usedRow], [siteRow], [monthCostRow]] = await Promise.all([
    db
      .select({ value: count() })
      .from(tryOnJobs)
      .where(
        and(
          eq(tryOnJobs.userId, user.userId),
          eq(tryOnJobs.requestDate, periods.date),
          inArray(tryOnJobs.status, USAGE_STATUS_LIST),
        ),
      ),
    db
      .select({ value: count() })
      .from(tryOnJobs)
      .where(and(eq(tryOnJobs.requestDate, periods.date), inArray(tryOnJobs.status, USAGE_STATUS_LIST))),
    db.select({ value: sum(tryOnJobs.estimatedCostCents) }).from(tryOnJobs).where(eq(tryOnJobs.requestMonth, periods.month)),
  ]);
  const dailyLimit = tryOnDailyLimit(identity.role, identity.tier, settings);
  const providerReady = Boolean(process.env.FASHN_API_KEY?.trim());
  const mediaSecretReady = tryOnMediaSecretConfigured();
  const serviceReady = providerReady && mediaSecretReady;
  const memberOpen = isTryOnMemberOpen(settings) && serviceReady;
  const used = Number(usedRow?.value ?? 0);
  const admission = evaluateTryOnAdmission({
    role: identity.role,
    effectiveTier: identity.tier,
    settings,
    usage: {
      userUsed: used,
      siteUsed: Number(siteRow?.value ?? 0),
      monthReservedCents: Number(monthCostRow?.value ?? 0),
    },
  });
  const allowed = serviceReady && admission.ok;
  return {
    allowed,
    role: identity.role,
    effectiveTier: identity.tier,
    memberEnabled: memberOpen,
    minimumTier: settings.minimumTier,
    dailyLimit,
    usedToday: used,
    remainingToday: Math.max(0, dailyLimit - used),
    siteRemainingToday: Math.max(0, settings.siteDailyLimit - Number(siteRow?.value ?? 0)),
    maxMixSteps: TRYON_MAX_MIX_STEPS,
    creditsPerGeneration: TRYON_CREDITS_PER_GENERATION,
    providerConfigured: isTryOnStaff(identity.role) ? providerReady : null,
    reason: !serviceReady
      ? isTryOnStaff(identity.role)
        ? !providerReady
          ? "試穿服務尚未配置，請管理員先加入伺服器 API key"
          : "私人圖片保護尚未配置，請管理員檢查伺服器 APP_SECRET"
        : "AI 試穿暫時維護中，請稍後再試"
      : admission.ok
        ? null
        : admission.message,
  };
}

export async function listTryOnProducts() {
  const db = getDb();
  const rows = await db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      category: products.category,
      image: products.image,
      photos: products.photos,
      price: products.price,
      discountPrice: products.discountPrice,
      listedDate: products.listedDate,
      stock: products.stock,
      // 公開直播場次 metadata（2026-10-28 節目冊篩選）：只係日期＋場次編號，唔含任何私人資料。
      liveDate: products.liveDate,
      liveSession: products.liveSession,
    })
    .from(products)
    .where(
      and(
        eq(products.isActive, true),
        or(eq(products.delistEnabled, false), isNull(products.delistAt), gt(products.delistAt, new Date())),
      ),
    )
    .orderBy(desc(products.listedDate));
  return rows.flatMap((row) => {
    const tryOnKind = resolveTryOnProductKind(row.category, row.name);
    return tryOnKind ? [{ ...row, tryOnKind }] : [];
  });
}

function requestDigest(args: {
  userId: number;
  productId: number;
  photoIndex: number;
  sourcePublicId: string | null;
  input: Buffer;
}): string {
  return createHash("sha256")
    .update(`${args.userId}|${args.productId}|${args.photoIndex}|${args.sourcePublicId ?? "root"}|`)
    .update(args.input)
    .digest("hex");
}

/** 後台副本係獨立審計資料；寫失敗要留警示，但唔令已成功的客戶生成流程反轉。 */
async function archiveTryOnMediaBestEffort(publicId: string, kind: "input" | "output"): Promise<void> {
  try {
    await archiveTryOnMediaCopy(publicId, kind);
  } catch {
    console.warn(`[tryon] admin archive ${kind} copy unavailable for job ${publicId}`);
  }
}

export async function createTryOnGeneration(args: {
  user: AuthUser;
  productId: number;
  photoIndex: number;
  idempotencyKey: string;
  modelImage?: string;
  sourcePublicId?: string;
}): Promise<Awaited<ReturnType<typeof serializeTryOnJob>>> {
  if (
    !Number.isInteger(args.productId) ||
    args.productId <= 0 ||
    !Number.isInteger(args.photoIndex) ||
    args.photoIndex < 0 ||
    args.photoIndex > 50 ||
    !/^[A-Za-z0-9_-]{8,64}$/.test(args.idempotencyKey) ||
    Boolean(args.modelImage) === Boolean(args.sourcePublicId)
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "試穿請求資料無效，請重新選擇全身相及商品" });
  }
  if (!process.env.FASHN_API_KEY?.trim()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "試穿服務尚未配置，今次未建立工作或預留額度",
    });
  }
  try {
    assertTryOnMediaSecret(env.appSecret);
  } catch {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "私人圖片保護尚未配置，請管理員檢查伺服器 APP_SECRET；今次未建立生成工作",
    });
  }
  const db = getDb();
  const source = args.sourcePublicId
    ? (
        await db
          .select()
          .from(tryOnJobs)
          .where(and(eq(tryOnJobs.publicId, args.sourcePublicId), eq(tryOnJobs.userId, args.user.userId)))
          .limit(1)
      )[0]
    : null;
  if (args.sourcePublicId && !source) {
    throw new TRPCError({ code: "NOT_FOUND", message: "搵唔到上一步試穿結果，請由第一件衣服重新開始" });
  }
  if (source && (source.status !== "completed" || !source.outputImagePath || source.mediaDeletedAt)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "上一步結果未成功或圖片已刪除，未能追加商品" });
  }
  if (source && !mediaAvailable(source)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "上一步結果已過 24 小時保留期，請由第一件衣服重新開始" });
  }
  if (source && source.stepNumber >= TRYON_MAX_MIX_STEPS) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `每套造型最多 ${TRYON_MAX_MIX_STEPS} 件，請重新開始一套` });
  }

  // 昂貴圖像處理放喺 DB lock 外；之後 transaction 只處理名額及寫紀錄。
  let inputBytes: Buffer;
  try {
    inputBytes = source
      ? await readTryOnMedia(source.publicId, "output")
      : await normalizeTryOnModelImage(args.modelImage ?? "");
    // 首張客戶原相必須先通過本地亮度＋人像檢查，先至可以進入任何 DB reservation。
    // Mix & Match 重用已通過首關嘅乾淨 output，唔會將展示水印或二次檢查帶入下一步。
    if (!source) await inspectTryOnModelImage(inputBytes);
  } catch (error) {
    if (error instanceof TryOnMediaError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    }
    if (source) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "上一步私人結果已不可用，請由第一件衣服重新開始" });
    }
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "相片檢查暫時未能完成；今次未建立工作或預留額度，請稍後再試",
    });
  }
  const requestHash = requestDigest({
    userId: args.user.userId,
    productId: args.productId,
    photoIndex: args.photoIndex,
    sourcePublicId: source?.publicId ?? null,
    input: inputBytes,
  });
  const publicId = randomUUID();
  const now = new Date();
  const periods = tryOnHongKongPeriods(now);
  await ensureTryOnSettingsRow();

  const reserved = await db.transaction(async (tx) => {
    // 所有試穿建立都先鎖同一設定列；並發雙擊／不同分頁都要排隊核對 quota + budget。
    const [settingRow] = await tx
      .select({ value: siteSettings.value })
      .from(siteSettings)
      .where(eq(siteSettings.key, TRYON_SETTING_KEY))
      .limit(1)
      .for("update");
    const settings = parseTryOnSettings(settingRow?.value);

    const [existing] = await tx
      .select()
      .from(tryOnJobs)
      .where(and(eq(tryOnJobs.userId, args.user.userId), eq(tryOnJobs.idempotencyKey, args.idempotencyKey)))
      .limit(1);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new TRPCError({ code: "CONFLICT", message: "同一操作編號已用於另一張相或另一件商品，請重新提交" });
      }
      return { job: existing, deduped: true };
    }

    // 設定列鎖令不同分頁都串行核對：同一帳號同一時間只跑一件，避免兩個新 key 雙重預留額度。
    const [activeJob] = await tx
      .select({ activePublicId: tryOnJobs.publicId })
      .from(tryOnJobs)
      .where(and(eq(tryOnJobs.userId, args.user.userId), inArray(tryOnJobs.status, ["queued", "processing"])))
      .limit(1);
    if (activeJob) {
      throw new TRPCError({ code: "CONFLICT", message: "你有另一件試穿仲生成緊；完成或失敗後先可以再提交，今次未預留額度" });
    }

    const [identity] = await tx
      .select({ role: users.role, vipTier: users.vipTier, vipExpiresAt: users.vipExpiresAt })
      .from(users)
      .where(eq(users.id, args.user.userId))
      .limit(1);
    if (!identity) throw new TRPCError({ code: "UNAUTHORIZED", message: "帳號已不存在" });
    const role = identity.role as TryOnRole;
    const tier = effectiveVipTier(identity);

    const [product] = await tx
      .select({
        id: products.id,
        name: products.name,
        sku: products.sku,
        category: products.category,
        image: products.image,
        photos: products.photos,
        price: products.price,
        discountPrice: products.discountPrice,
        isActive: products.isActive,
        delistEnabled: products.delistEnabled,
        delistAt: products.delistAt,
      })
      .from(products)
      .where(eq(products.id, args.productId))
      .limit(1);
    // 同 listTryOnProducts 一致：isActive 之外，到咗時間嘅自動下架商品一樣唔可以建立試穿。
    if (
      !product ||
      !product.isActive ||
      (product.delistEnabled && product.delistAt !== null && product.delistAt.getTime() <= now.getTime())
    ) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "商品不存在或已下架，請重新選擇" });
    }
    const tryOnKind = resolveTryOnProductKind(product.category, product.name);
    if (!tryOnKind) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          product.category === "accessory"
            ? "飾品品名必須清楚標明戒指、頸鏈、耳環或手鏈其中一類；套裝、收納用品及分唔清類別嘅商品暫不支援"
            : "只支援上衣、褲、裙、鞋及明確分類嘅飾品；生活用品、護膚品及其他非穿著商品不能試穿",
      });
    }
    const gallery = product.photos?.length ? product.photos : [product.image];
    const productImagePath = gallery[args.photoIndex];
    if (!productImagePath) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "商品原圖選擇無效，請重新揀相簿圖片" });
    }
    if (source) {
      const previous = await tx
        .select({
          productId: tryOnJobs.productId,
          stepNumber: tryOnJobs.stepNumber,
          tryOnKind: tryOnJobs.tryOnKind,
          status: tryOnJobs.status,
          mediaDeletedAt: tryOnJobs.mediaDeletedAt,
        })
        .from(tryOnJobs)
        .where(and(eq(tryOnJobs.lookId, source.lookId), eq(tryOnJobs.userId, args.user.userId)));
      const conflict = findTryOnLineageConflict({
        rows: previous,
        sourceStepNumber: source.stepNumber,
        productId: args.productId,
        tryOnKind,
      });
      if (conflict === "BRANCH") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "呢套造型已經有下一步，請由最新結果繼續追加" });
      }
      if (conflict === "DUPLICATE_PRODUCT") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "呢件商品已經喺呢套造型，請揀另一件" });
      }
      if (conflict === "DUPLICATE_KIND") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "同一套造型唔可以重複相同穿著部位，請揀另一類商品" });
      }
    }

    const [userUsedRow] = await tx
      .select({ value: count() })
      .from(tryOnJobs)
      .where(
        and(
          eq(tryOnJobs.userId, args.user.userId),
          eq(tryOnJobs.requestDate, periods.date),
          inArray(tryOnJobs.status, USAGE_STATUS_LIST),
        ),
      );
    const [siteUsedRow] = await tx
      .select({ value: count() })
      .from(tryOnJobs)
      .where(and(eq(tryOnJobs.requestDate, periods.date), inArray(tryOnJobs.status, USAGE_STATUS_LIST)));
    const [monthCostRow] = await tx
      .select({ value: sum(tryOnJobs.estimatedCostCents) })
      .from(tryOnJobs)
      .where(eq(tryOnJobs.requestMonth, periods.month));
    const admission = evaluateTryOnAdmission({
      role,
      effectiveTier: tier,
      settings,
      usage: {
        userUsed: Number(userUsedRow?.value ?? 0),
        siteUsed: Number(siteUsedRow?.value ?? 0),
        monthReservedCents: Number(monthCostRow?.value ?? 0),
      },
    });
    if (!admission.ok) throw admissionError(admission);

    const [job] = await tx
      .insert(tryOnJobs)
      .values({
        publicId,
        userId: args.user.userId,
        productId: product.id,
        lookId: source?.lookId ?? randomUUID(),
        stepNumber: (source?.stepNumber ?? 0) + 1,
        sourceJobId: source?.id ?? null,
        productName: product.name,
        productSku: product.sku,
        productCategory: product.category,
        tryOnKind,
        productImagePath,
        productPrice: product.price,
        productDiscountPrice: product.discountPrice,
        inputImagePath: tryOnMediaRelativePath(publicId, "input"),
        creditsReserved: TRYON_CREDITS_PER_GENERATION,
        creditsUsed: 0,
        unitCreditCostCents: settings.creditCostCents > 0 ? settings.creditCostCents : null,
        estimatedCostCents: admission.estimatedCostCents,
        costUncertain: false,
        idempotencyKey: args.idempotencyKey,
        requestHash,
        requestDate: periods.date,
        requestMonth: periods.month,
        requestYear: periods.year,
        expiresAt: new Date(now.getTime() + TRYON_MEDIA_RETENTION_MS),
      })
      .returning();
    return { job, deduped: false };
  });

  if (reserved.deduped) return serializeTryOnJob(reserved.job);
  try {
    await writeTryOnMedia(publicId, "input", inputBytes);
  } catch {
    await markTryOnFailed(reserved.job, "PRIVATE_STORAGE", "私人圖片暫存失敗，今次唔會扣額度", {
      releaseBudget: true,
      charged: false,
    });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "私人圖片暫存失敗，請稍後再試" });
  }
  // 客戶原相寫成功即刻備一份入 30 日後台 archive（best-effort；失敗只留警示，唔反轉已成立嘅工作）。
  // 之後客戶刪除／24 小時到期清理都郁唔到呢份副本。
  await archiveTryOnMediaBestEffort(publicId, "input");
  void processTryOnJob(reserved.job.id);
  return serializeTryOnJob(reserved.job);
}

async function markTryOnFailed(
  job: TryOnJob,
  code: string,
  message: string,
  options: { releaseBudget: boolean; charged: boolean; uncertain?: boolean },
): Promise<void> {
  const db = getDb();
  await db
    .update(tryOnJobs)
    .set({
      status: "failed",
      failureCode: code.slice(0, 64),
      failureMessage: message.slice(0, 255),
      creditsUsed: options.charged ? job.creditsReserved : 0,
      estimatedCostCents: options.releaseBudget ? 0 : job.estimatedCostCents,
      costUncertain: options.uncertain ?? false,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(tryOnJobs.id, job.id), inArray(tryOnJobs.status, ["queued", "processing"])));
}

async function expireTryOnJob(job: TryOnJob): Promise<void> {
  const submissionMayHaveStarted = Boolean(job.providerJobId) || job.failureCode === "SUBMITTING";
  await markTryOnFailed(
    job,
    submissionMayHaveStarted ? "PROVIDER_TIMEOUT" : "JOB_TIMEOUT",
    submissionMayHaveStarted
      ? "生成逾 30 分鐘已停止；額度已釋放，估算成本保留待核實"
      : "工作未能在限期內開始，今次唔會扣額度或預算",
    submissionMayHaveStarted
      ? { releaseBudget: false, charged: false, uncertain: true }
      : { releaseBudget: true, charged: false },
  );
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 背景執行；getJob 會喺重開／超時後喚返。供應商 completed 同品質合格係兩回事。 */
export async function processTryOnJob(jobId: number, injectedProvider?: TryOnProvider): Promise<void> {
  if (runningJobs.has(jobId)) return;
  runningJobs.add(jobId);
  try {
    const db = getDb();
    let [job] = await db.select().from(tryOnJobs).where(eq(tryOnJobs.id, jobId)).limit(1);
    if (!job || job.status === "completed" || job.status === "failed" || job.mediaDeletedAt) return;
    if (Date.now() - job.createdAt.getTime() >= TRYON_JOB_TIMEOUT_MS) {
      await expireTryOnJob(job);
      return;
    }
    if (job.status === "processing" && !job.providerJobId && job.failureCode === "SUBMITTING") {
      // 另一 process 可能已提交但未嚟得切記低供應商 id；絕對唔好貿然再 submit。
      if (Date.now() - job.updatedAt.getTime() >= TRYON_SUBMIT_UNCERTAIN_MS) {
        await markTryOnFailed(job, "PROVIDER_SUBMIT_UNKNOWN", "提交結果未能確認；額度已釋放，估算成本保留待核實", {
          releaseBudget: false,
          charged: false,
          uncertain: true,
        });
      }
      return;
    }
    if (!job.providerJobId && job.status === "queued") {
      const [claimed] = await db
        .update(tryOnJobs)
        .set({ status: "processing", startedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(tryOnJobs.id, job.id), eq(tryOnJobs.status, "queued"), isNull(tryOnJobs.providerJobId)))
        .returning();
      if (!claimed) return;
      job = claimed;
    } else {
      await db.update(tryOnJobs).set({ status: "processing", updatedAt: new Date() }).where(eq(tryOnJobs.id, job.id));
    }

    const provider = injectedProvider ?? configuredTryOnProvider();
    if (!provider) {
      await markTryOnFailed(job, "PROVIDER_NOT_CONFIGURED", "試穿服務尚未配置；請管理員喺 Render 加返伺服器 API key", {
        releaseBudget: true,
        charged: false,
      });
      return;
    }

    let modelImage: string;
    let productImage: string;
    try {
      const input = await readTryOnMedia(job.publicId, "input");
      modelImage = bufferToDataUri(input, detectTryOnImageMime(input));
      productImage = await tryOnProductImageInput(job.productImagePath);
    } catch {
      await markTryOnFailed(job, "INPUT_NOT_AVAILABLE", "原相或商品原圖已不可用，今次唔會扣額度", {
        releaseBudget: true,
        charged: false,
      });
      return;
    }

    if (!job.providerJobId) {
      // DB 佔位先於外部提交：只有攞到 SUBMITTING 嘅 process 可以 submit。
      // 若 crash 發生喺供應商回應前後，恢復者只會報成本待核實，唔會再提交一次。
      const [submitClaim] = await db
        .update(tryOnJobs)
        .set({ failureCode: "SUBMITTING", failureMessage: null, updatedAt: new Date() })
        .where(
          and(
            eq(tryOnJobs.id, job.id),
            eq(tryOnJobs.status, "processing"),
            isNull(tryOnJobs.providerJobId),
            isNull(tryOnJobs.failureCode),
          ),
        )
        .returning();
      if (!submitClaim) return;
      job = submitClaim;

      let submitted: { id: string };
      try {
        submitted = await provider.submit({ modelImage, productImage, productKind: job.tryOnKind as TryOnProductKind });
      } catch (error) {
        const uncertain = error instanceof TryOnProviderError && error.retryable;
        await markTryOnFailed(
          job,
          error instanceof TryOnProviderError ? error.code : "PROVIDER_SUBMIT",
          uncertain
            ? "提交結果未能確認；額度已釋放，但估算成本會保留待管理員核實"
            : "試穿請求未被接受，今次唔會扣額度",
          { releaseBudget: !uncertain, charged: false, uncertain },
        );
        return;
      }

      try {
        const [withProvider] = await db
          .update(tryOnJobs)
          .set({ providerJobId: submitted.id, status: "processing", failureCode: null, updatedAt: new Date() })
          .where(
            and(
              eq(tryOnJobs.id, job.id),
              eq(tryOnJobs.status, "processing"),
              eq(tryOnJobs.failureCode, "SUBMITTING"),
              isNull(tryOnJobs.providerJobId),
            ),
          )
          .returning();
        if (!withProvider) return;
        job = withProvider;
      } catch {
        await markTryOnFailed(job, "PROVIDER_SUBMIT_UNKNOWN", "供應商已回應但本站未能記錄；額度已釋放，估算成本保留待核實", {
          releaseBudget: false,
          charged: false,
          uncertain: true,
        });
        return;
      }
    }

    let transientErrors = 0;
    for (let poll = 0; poll < 80; poll++) {
      if (Date.now() - job.createdAt.getTime() >= TRYON_JOB_TIMEOUT_MS) {
        await expireTryOnJob(job);
        return;
      }
      try {
        const result = await provider.status(job.providerJobId!);
        transientErrors = 0;
        if (result.state === "processing") {
          await db
            .update(tryOnJobs)
            .set({ status: "processing", failureCode: null, failureMessage: null, updatedAt: new Date() })
            .where(eq(tryOnJobs.id, job.id));
          await sleep(3000);
          continue;
        }
        if (result.state === "failed") {
          await markTryOnFailed(job, result.code, result.message, { releaseBudget: true, charged: false });
          return;
        }
        try {
          const output = await normalizeTryOnProviderOutput(result.imageDataUri);
          const outputPath = await writeTryOnMedia(job.publicId, "output", output);
          // 乾淨 output 寫成功即刻備一份入 30 日後台 archive（best-effort）。
          // 就算下面完成更新同客戶刪除競爭而要清走私人檔，後台副本仍按 createdAt＋30 日獨立保留。
          await archiveTryOnMediaBestEffort(job.publicId, "output");
          const [completed] = await db
            .update(tryOnJobs)
            .set({
              status: "completed",
              outputImagePath: outputPath,
              creditsUsed: job.creditsReserved,
              costUncertain: false,
              failureCode: null,
              failureMessage: null,
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(tryOnJobs.id, job.id),
                eq(tryOnJobs.status, "processing"),
                isNull(tryOnJobs.mediaDeletedAt),
              ),
            )
            .returning({ id: tryOnJobs.id });
          if (!completed) {
            const [current] = await db
              .select({ status: tryOnJobs.status, mediaDeletedAt: tryOnJobs.mediaDeletedAt })
              .from(tryOnJobs)
              .where(eq(tryOnJobs.id, job.id))
              .limit(1);
            if (!current || current.status !== "completed" || current.mediaDeletedAt) {
              // 刪除同完成競爭時，再清一次剛寫入嘅 output，避免留下孤立私人檔。
              await deleteTryOnMedia(job.publicId);
            }
          }
        } catch {
          // 供應商已完成但本站寫圖失敗：會員額度釋放，成本仍如實保留。
          await markTryOnFailed(job, "OUTPUT_STORAGE", "生成已完成，但結果暫存失敗；額度已釋放，估算成本保留", {
            releaseBudget: false,
            charged: true,
          });
        }
        return;
      } catch (error) {
        if (error instanceof TryOnProviderError && !error.retryable) {
          const knownChargedOutput = error.code === "PROVIDER_BAD_OUTPUT";
          await markTryOnFailed(
            job,
            error.code,
            knownChargedOutput
              ? "供應商已完成但結果格式無效；額度已釋放，估算成本保留"
              : "供應商工作狀態未能核實；額度已釋放，估算成本保留待核實",
            knownChargedOutput
              ? { releaseBudget: false, charged: true }
              : { releaseBudget: false, charged: false, uncertain: true },
          );
          return;
        }
        transientErrors++;
        await db
          .update(tryOnJobs)
          .set({
            status: "processing",
            failureCode: error instanceof TryOnProviderError ? error.code : "PROVIDER_STATUS",
            failureMessage: "網絡短暫不穩，會繼續查詢生成結果",
            updatedAt: new Date(),
          })
          .where(eq(tryOnJobs.id, job.id));
        if (transientErrors >= 5) return; // 保留 processing 及預算；下一次 getJob 會恢復 poll。
        await sleep(3000);
      }
    }
    // 超過約 4 分鐘唔當失敗、唔釋放預算；避免供應商其實已完成卻被當免費。
    await db
      .update(tryOnJobs)
      .set({ failureCode: "PROVIDER_PENDING", failureMessage: "生成時間較長，會繼續查詢；請勿重複提交", updatedAt: new Date() })
      .where(eq(tryOnJobs.id, job.id));
  } catch (error) {
    console.error("[tryon] background job failed:", error instanceof Error ? error.message : "unknown");
  } finally {
    runningJobs.delete(jobId);
  }
}

function mediaAvailable(job: TryOnJob): boolean {
  return !job.mediaDeletedAt && job.expiresAt.getTime() > Date.now();
}

async function serializeTryOnJob(job: TryOnJob) {
  const db = getDb();
  const lookItemRows = await db
    .select({
      id: tryOnJobs.id,
      publicId: tryOnJobs.publicId,
      stepNumber: tryOnJobs.stepNumber,
      productId: tryOnJobs.productId,
      productName: tryOnJobs.productName,
      productSku: tryOnJobs.productSku,
      productCategory: tryOnJobs.productCategory,
      tryOnKind: tryOnJobs.tryOnKind,
      productImagePath: tryOnJobs.productImagePath,
      productPrice: tryOnJobs.productPrice,
      productDiscountPrice: tryOnJobs.productDiscountPrice,
      status: tryOnJobs.status,
      mediaDeletedAt: tryOnJobs.mediaDeletedAt,
    })
    .from(tryOnJobs)
    .where(and(eq(tryOnJobs.lookId, job.lookId), eq(tryOnJobs.userId, job.userId)))
    .orderBy(asc(tryOnJobs.stepNumber), asc(tryOnJobs.id));
  // DTO 只暴露 boolean 刪除狀態，唔會將私人媒體時間戳外傳。
  const lookItems = latestTryOnAttemptsByStep(lookItemRows).map(({ mediaDeletedAt, ...item }) => ({
    ...item,
    mediaDeleted: Boolean(mediaDeletedAt),
  }));
  let original: TryOnJob | undefined = job;
  if (job.stepNumber > 1) {
    [original] = await db
      .select()
      .from(tryOnJobs)
      .where(and(eq(tryOnJobs.lookId, job.lookId), eq(tryOnJobs.userId, job.userId), eq(tryOnJobs.stepNumber, 1)))
      .orderBy(asc(tryOnJobs.id))
      .limit(1);
  }
  const available = mediaAvailable(job);
  const sign = (target: TryOnJob, kind: "input" | "output") =>
    signTryOnMediaUrl({ publicId: target.publicId, kind, userId: target.userId, secret: env.appSecret });
  return {
    publicId: job.publicId,
    lookId: job.lookId,
    stepNumber: job.stepNumber,
    sourcePublicId: lookItemRows.find((item) => item.id === job.sourceJobId)?.publicId ?? null,
    status: job.status,
    productId: job.productId,
    productName: job.productName,
    productSku: job.productSku,
    productCategory: job.productCategory,
    tryOnKind: job.tryOnKind,
    productImagePath: job.productImagePath,
    productPrice: job.productPrice,
    productDiscountPrice: job.productDiscountPrice,
    credits: job.status === "queued" || job.status === "processing" ? job.creditsReserved : job.creditsUsed,
    failureCode: job.failureCode,
    failureMessage: job.failureMessage,
    inputUrl: available ? sign(job, "input") : null,
    outputUrl: available && job.status === "completed" && job.outputImagePath ? sign(job, "output") : null,
    lookOriginalUrl: original && mediaAvailable(original) ? sign(original, "input") : null,
    lookItems,
    expiresAt: job.expiresAt,
    mediaDeleted: Boolean(job.mediaDeletedAt) || !available,
    canDelete: (job.status === "completed" || job.status === "failed") && available,
  };
}

export async function getOwnedTryOnJob(user: AuthUser, publicId: string) {
  const db = getDb();
  const [job] = await db
    .select()
    .from(tryOnJobs)
    .where(and(eq(tryOnJobs.publicId, publicId), eq(tryOnJobs.userId, user.userId)))
    .limit(1);
  if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "搵唔到呢次試穿紀錄" });
  if (!mediaAvailable(job) && !job.mediaDeletedAt && (job.status === "completed" || job.status === "failed")) {
    try {
      await deleteTryOnMedia(job.publicId);
      await db.update(tryOnJobs).set({ mediaDeletedAt: new Date(), updatedAt: new Date() }).where(eq(tryOnJobs.id, job.id));
      job.mediaDeletedAt = new Date();
    } catch {
      // 刪除失敗唔可以假裝已刪；route 仍會因到期而拒絕存取，留待 sweeper 重試。
    }
  }
  if (
    (job.status === "queued" || job.status === "processing") &&
    Date.now() - job.updatedAt.getTime() > 10_000
  ) {
    void processTryOnJob(job.id);
  }
  return serializeTryOnJob(job);
}

/** 客戶自己嘅完成紀錄：server 端強制 userId scope，絕唔靠瀏覽器 sessionStorage 砌歷史。 */
export async function listMyTryOnRecords(user: AuthUser) {
  const db = getDb();
  const rows = await db
    .select({
      publicId: tryOnJobs.publicId,
      lookId: tryOnJobs.lookId,
      stepNumber: tryOnJobs.stepNumber,
      productId: tryOnJobs.productId,
      productName: tryOnJobs.productName,
      productSku: tryOnJobs.productSku,
      productPrice: tryOnJobs.productPrice,
      productDiscountPrice: tryOnJobs.productDiscountPrice,
      listedDate: products.listedDate,
      outputImagePath: tryOnJobs.outputImagePath,
      expiresAt: tryOnJobs.expiresAt,
      createdAt: tryOnJobs.createdAt,
      userId: tryOnJobs.userId,
    })
    .from(tryOnJobs)
    .leftJoin(products, eq(products.id, tryOnJobs.productId))
    .where(
      and(
        eq(tryOnJobs.userId, user.userId),
        eq(tryOnJobs.status, "completed"),
        isNull(tryOnJobs.mediaDeletedAt),
        isNotNull(tryOnJobs.outputImagePath),
        gt(tryOnJobs.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(tryOnJobs.id))
    .limit(60);

  return rows.map(({ outputImagePath: _outputImagePath, userId, ...row }) => ({
    ...row,
    outputUrl: signTryOnMediaUrl({ publicId: row.publicId, kind: "output", userId, secret: env.appSecret }),
  }));
}

/** 只有 owner 可以簽發；分享期限直接綁呢個 job 原本嘅 24 小時到期，不會重新延長。 */
export async function getOwnedTryOnShareLink(user: AuthUser, publicId: string) {
  const db = getDb();
  const [job] = await db
    .select()
    .from(tryOnJobs)
    .where(and(eq(tryOnJobs.publicId, publicId), eq(tryOnJobs.userId, user.userId)))
    .limit(1);
  if (!job || job.status !== "completed" || !job.outputImagePath || !mediaAvailable(job)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "呢次試穿已刪除、到期或未能分享" });
  }
  const share = signTryOnShare({ publicId: job.publicId, expiresAt: job.expiresAt, secret: env.appSecret });
  return { url: share.url, expiresAt: share.expiresAt };
}

/** 公開分享頁 DTO：只回生成圖同公開商品資料，唔回 userId、inputUrl 或任何 storage path。 */
export async function getSharedTryOnRecord(args: { publicId: string; expires: number; signature: string }) {
  if (
    !verifyTryOnShare({
      publicId: args.publicId,
      expires: args.expires,
      supplied: args.signature,
      secret: env.appSecret,
    })
  ) {
    throw new TRPCError({ code: "NOT_FOUND", message: "分享連結無效或已過期" });
  }
  const db = getDb();
  const [row] = await db
    .select({
      publicId: tryOnJobs.publicId,
      status: tryOnJobs.status,
      outputImagePath: tryOnJobs.outputImagePath,
      mediaDeletedAt: tryOnJobs.mediaDeletedAt,
      expiresAt: tryOnJobs.expiresAt,
      productId: tryOnJobs.productId,
      productName: tryOnJobs.productName,
      productSku: tryOnJobs.productSku,
      productPrice: tryOnJobs.productPrice,
      productDiscountPrice: tryOnJobs.productDiscountPrice,
      listedDate: products.listedDate,
    })
    .from(tryOnJobs)
    .leftJoin(products, eq(products.id, tryOnJobs.productId))
    .where(eq(tryOnJobs.publicId, args.publicId))
    .limit(1);
  if (
    !row ||
    row.status !== "completed" ||
    !row.outputImagePath ||
    row.mediaDeletedAt ||
    row.expiresAt.getTime() !== args.expires ||
    row.expiresAt.getTime() <= Date.now()
  ) {
    throw new TRPCError({ code: "NOT_FOUND", message: "分享內容已過期或唔再可用" });
  }
  const share = signTryOnShare({ publicId: row.publicId, expiresAt: row.expiresAt, secret: env.appSecret });
  return {
    productId: row.productId,
    productName: row.productName,
    productSku: row.productSku,
    productPrice: row.productPrice,
    productDiscountPrice: row.productDiscountPrice,
    listedDate: row.listedDate,
    outputUrl: share.mediaUrl,
    expiresAt: row.expiresAt,
  };
}

export async function deleteOwnedTryOnMedia(user: AuthUser, publicId: string): Promise<{ ok: true }> {
  const db = getDb();
  const [job] = await db
    .select()
    .from(tryOnJobs)
    .where(and(eq(tryOnJobs.publicId, publicId), eq(tryOnJobs.userId, user.userId)))
    .limit(1);
  if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "搵唔到呢次試穿紀錄" });
  if (job.status === "queued" || job.status === "processing") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "生成未完成，暫時唔可以刪除；請等成功或失敗後再刪" });
  }
  await deleteTryOnMedia(job.publicId);
  await db.update(tryOnJobs).set({ mediaDeletedAt: new Date(), updatedAt: new Date() }).where(eq(tryOnJobs.id, job.id));
  return { ok: true };
}

interface StatsBucket {
  total: number;
  completed: number;
  failed: number;
  processing: number;
  creditsUsed: number;
  reservedCredits: number;
  estimatedCostCents: number;
  reservedCostCents: number;
  unknownCostJobs: number;
  costUncertainJobs: number;
}

function emptyStats(): StatsBucket {
  return {
    total: 0,
    completed: 0,
    failed: 0,
    processing: 0,
    creditsUsed: 0,
    reservedCredits: 0,
    estimatedCostCents: 0,
    reservedCostCents: 0,
    unknownCostJobs: 0,
    costUncertainJobs: 0,
  };
}

export async function getTryOnAdminStats() {
  const db = getDb();
  const periods = tryOnHongKongPeriods();
  const rows = await db
    .select({
      status: tryOnJobs.status,
      creditsReserved: tryOnJobs.creditsReserved,
      creditsUsed: tryOnJobs.creditsUsed,
      estimatedCostCents: tryOnJobs.estimatedCostCents,
      costUncertain: tryOnJobs.costUncertain,
      requestDate: tryOnJobs.requestDate,
      requestMonth: tryOnJobs.requestMonth,
    })
    .from(tryOnJobs)
    .where(eq(tryOnJobs.requestYear, periods.year));
  const buckets = { today: emptyStats(), month: emptyStats(), year: emptyStats() };
  for (const row of rows) {
    const targets = [buckets.year];
    if (row.requestMonth === periods.month) targets.push(buckets.month);
    if (row.requestDate === periods.date) targets.push(buckets.today);
    for (const bucket of targets) {
      bucket.total++;
      const active = row.status === "queued" || row.status === "processing";
      if (active) {
        bucket.processing++;
        bucket.reservedCredits += row.creditsReserved;
        bucket.reservedCostCents += row.estimatedCostCents ?? 0;
      } else {
        if (row.status === "completed") bucket.completed++;
        if (row.status === "failed") bucket.failed++;
        bucket.creditsUsed += row.creditsUsed;
        bucket.estimatedCostCents += row.estimatedCostCents ?? 0;
      }
      const needsKnownCost = active || row.creditsUsed > 0 || row.costUncertain;
      if (row.estimatedCostCents === null && needsKnownCost) bucket.unknownCostJobs++;
      if (row.costUncertain) bucket.costUncertainJobs++;
    }
  }
  const recentJobs = await db
    .select({
      publicId: tryOnJobs.publicId,
      userId: tryOnJobs.userId,
      productName: tryOnJobs.productName,
      stepNumber: tryOnJobs.stepNumber,
      status: tryOnJobs.status,
      creditsReserved: tryOnJobs.creditsReserved,
      creditsUsed: tryOnJobs.creditsUsed,
      estimatedCostCents: tryOnJobs.estimatedCostCents,
      costUncertain: tryOnJobs.costUncertain,
      failureCode: tryOnJobs.failureCode,
      createdAt: tryOnJobs.createdAt,
    })
    .from(tryOnJobs)
    .orderBy(desc(tryOnJobs.id))
    .limit(20);
  return { periods, ...buckets, recentJobs };
}

export async function recoverStaleTryOnJobs(): Promise<{ resumed: number; finalized: number }> {
  const db = getDb();
  const now = Date.now();
  const stale = await db
    .select()
    .from(tryOnJobs)
    .where(
      and(
        inArray(tryOnJobs.status, ["queued", "processing"]),
        lt(tryOnJobs.updatedAt, new Date(now - TRYON_STALE_AFTER_MS)),
      ),
    )
    .orderBy(asc(tryOnJobs.id))
    .limit(50);
  let resumed = 0;
  let finalized = 0;
  for (const job of stale) {
    if (!job.providerJobId && job.failureCode === "SUBMITTING") {
      if (now - job.updatedAt.getTime() >= TRYON_SUBMIT_UNCERTAIN_MS) {
        await markTryOnFailed(job, "PROVIDER_SUBMIT_UNKNOWN", "提交結果未能確認；額度已釋放，估算成本保留待核實", {
          releaseBudget: false,
          charged: false,
          uncertain: true,
        });
        finalized++;
      }
      continue;
    }
    if (now - job.createdAt.getTime() >= TRYON_JOB_TIMEOUT_MS) {
      await expireTryOnJob(job);
      finalized++;
      continue;
    }
    resumed++;
    void processTryOnJob(job.id);
  }
  return { resumed, finalized };
}

export async function cleanupExpiredTryOnMedia(): Promise<number> {
  const db = getDb();
  const expired = await db
    .select({ id: tryOnJobs.id, publicId: tryOnJobs.publicId })
    .from(tryOnJobs)
    .where(
      and(
        lt(tryOnJobs.expiresAt, new Date()),
        isNull(tryOnJobs.mediaDeletedAt),
        inArray(tryOnJobs.status, ["completed", "failed"]),
      ),
    )
    .limit(100);
  let deleted = 0;
  for (const job of expired) {
    try {
      await deleteTryOnMedia(job.publicId);
      await db.update(tryOnJobs).set({ mediaDeletedAt: new Date(), updatedAt: new Date() }).where(eq(tryOnJobs.id, job.id));
      deleted++;
    } catch {
      // 保留 mediaDeletedAt=null，下一輪再試；唔好將仍然存在嘅私人圖片報成已刪。
    }
  }
  return deleted;
}

/**
 * 30 日後台 archive 清理：只按 tryOnJobs.createdAt 判斷（createdAt + 30 日 ≤ now 即刪），
 * 完全唔睇客戶嘅 expiresAt／mediaDeletedAt——後台副本係獨立審計資料，
 * 客戶刪除或 24 小時到期都唔會提早清走，30 日一到就唔會因客戶媒體仍在而多留。
 * boundary 同 tryOnAdminArchiveAvailable 一致：啱啱好 30 日嗰刻已唔再可睇，所以呢批要刪。
 */
export async function cleanupExpiredTryOnAdminArchive(): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - TRYON_ADMIN_ARCHIVE_RETENTION_MS);
  const expired = await db
    .select({ id: tryOnJobs.id, publicId: tryOnJobs.publicId })
    .from(tryOnJobs)
    .where(lte(tryOnJobs.createdAt, cutoff))
    .limit(200);
  let deleted = 0;
  for (const job of expired) {
    try {
      await deleteTryOnAdminArchive(job.publicId);
      deleted++;
    } catch {
      // 刪唔到留待下一輪重試；唔會標記任何客戶欄位。
    }
  }
  return deleted;
}

let mediaSweeperStarted = false;
export function startTryOnMediaSweeper(): void {
  if (mediaSweeperStarted) return;
  mediaSweeperStarted = true;
  const recover = () => void recoverStaleTryOnJobs().catch(() => console.error("[tryon] stale job recovery failed"));
  const clean = () => void cleanupExpiredTryOnMedia().catch(() => console.error("[tryon] media cleanup failed"));
  const cleanArchive = () =>
    void cleanupExpiredTryOnAdminArchive().catch(() => console.error("[tryon] admin archive cleanup failed"));
  recover();
  clean();
  cleanArchive();
  const recoveryTimer = setInterval(recover, 60 * 1000);
  const mediaTimer = setInterval(clean, 6 * 60 * 60 * 1000);
  // 後台 archive 30 日 retention：每 6 小時同客戶媒體清理一齊掃（兩者標準獨立，互不影響）。
  const archiveTimer = setInterval(cleanArchive, 6 * 60 * 60 * 1000);
  recoveryTimer.unref();
  mediaTimer.unref();
  archiveTimer.unref();
}
