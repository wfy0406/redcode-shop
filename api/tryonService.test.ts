import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { products, siteSettings, tryOnJobs, users, type TryOnJob } from "@db/schema";
import { TryOnProviderError, type TryOnProvider } from "./tryonProvider";
import { TryOnMediaError } from "./tryonMedia";
import { tryOnSettingsSchema, type TryOnSettings } from "./tryonConfig";
import { env } from "./lib/env";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  readTryOnMedia: vi.fn(),
  tryOnProductImageInput: vi.fn(),
  normalizeTryOnModelImage: vi.fn(),
  normalizeTryOnProviderOutput: vi.fn(),
  inspectTryOnModelImage: vi.fn(),
  writeTryOnMedia: vi.fn(),
  deleteTryOnMedia: vi.fn(),
  archiveTryOnMediaCopy: vi.fn(),
  deleteTryOnAdminArchive: vi.fn(),
}));

vi.mock("./queries/connection", () => ({ getDb: mocks.getDb }));
vi.mock("./lib/env", () => ({
  env: { appSecret: "unit-test-secret", appId: "unit-test", databaseUrl: "", isProduction: false },
}));
vi.mock("./vip", () => ({
  effectiveVipTier: (user: { vipTier: string }) => user.vipTier,
}));
vi.mock("./tryonMedia", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tryonMedia")>();
  return {
    ...actual,
    readTryOnMedia: mocks.readTryOnMedia,
    tryOnProductImageInput: mocks.tryOnProductImageInput,
    normalizeTryOnModelImage: mocks.normalizeTryOnModelImage,
    normalizeTryOnProviderOutput: mocks.normalizeTryOnProviderOutput,
    writeTryOnMedia: mocks.writeTryOnMedia,
    deleteTryOnMedia: mocks.deleteTryOnMedia,
  };
});
vi.mock("./tryonPreflight", () => ({ inspectTryOnModelImage: mocks.inspectTryOnModelImage }));
// 後台 30 日 archive：實際寫檔由 tryonAdminArchive.test.ts 覆蓋；呢度用 spy 驗證接線時機。
vi.mock("./tryonAdminArchive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tryonAdminArchive")>();
  return {
    ...actual,
    archiveTryOnMediaCopy: mocks.archiveTryOnMediaCopy,
    deleteTryOnAdminArchive: mocks.deleteTryOnAdminArchive,
  };
});

import {
  TRYON_JOB_TIMEOUT_MS,
  cleanupExpiredTryOnAdminArchive,
  createTryOnGeneration,
  getMyTryOnAccess,
  getOwnedTryOnShareLink,
  getSharedTryOnRecord,
  listMyTryOnRecords,
  processTryOnJob,
} from "./tryonService";
import { TRYON_ADMIN_ARCHIVE_RETENTION_MS } from "./tryonAdminArchive";
import { signTryOnShare } from "./tryonSharing";
import { PgDialect } from "drizzle-orm/pg-core";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeJob(overrides: Partial<TryOnJob> = {}): TryOnJob {
  const now = new Date();
  return {
    id: 1,
    publicId: "123e4567-e89b-42d3-a456-426614174000",
    userId: 7,
    productId: 101,
    lookId: "223e4567-e89b-42d3-a456-426614174000",
    stepNumber: 1,
    sourceJobId: null,
    productName: "測試上衣",
    productSku: "TOP-101",
    productCategory: "top",
    tryOnKind: "top",
    productImagePath: "/uploads/product.png",
    productPrice: 599,
    productDiscountPrice: null,
    inputImagePath: "123e4567-e89b-42d3-a456-426614174000/input.jpg",
    outputImagePath: null,
    status: "processing",
    provider: "fashn",
    providerJobId: "provider-1",
    generationMode: "quality",
    resolution: "1k",
    creditsReserved: 3,
    creditsUsed: 0,
    unitCreditCostCents: 10,
    estimatedCostCents: 30,
    costUncertain: false,
    idempotencyKey: "operation-1",
    requestHash: "a".repeat(64),
    requestDate: "2026-10-25",
    requestMonth: "2026-10",
    requestYear: "2026",
    failureCode: null,
    failureMessage: null,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    mediaDeletedAt: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeDb(job: TryOnJob) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select(selection?: Record<string, unknown>) {
      return {
        from: () => ({
          where: () => ({
            limit: async () => {
              if (!selection) return [{ ...job }];
              const projected = Object.fromEntries(
                Object.keys(selection).map((key) => [key, job[key as keyof TryOnJob]]),
              );
              return [projected];
            },
          }),
        }),
      };
    },
    update() {
      let values: Record<string, unknown> = {};
      return {
        set(next: Record<string, unknown>) {
          values = next;
          return this;
        },
        where() {
          Object.assign(job, values);
          updates.push({ ...values });
          return {
            returning: async () => [{ ...job }],
            then: (resolve: (value?: unknown) => unknown, reject?: (reason?: unknown) => unknown) =>
              Promise.resolve(undefined).then(resolve, reject),
          };
        },
      };
    },
  };
  return { db, updates };
}

function provider(overrides: Partial<TryOnProvider> = {}): TryOnProvider {
  return {
    submit: vi.fn(async () => ({ id: "provider-new" })),
    status: vi.fn(async () => ({ state: "processing" }) as Awaited<ReturnType<TryOnProvider["status"]>>),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readTryOnMedia.mockResolvedValue(PNG);
  mocks.tryOnProductImageInput.mockResolvedValue("https://example.com/product.png");
  mocks.normalizeTryOnModelImage.mockResolvedValue(PNG);
  mocks.normalizeTryOnProviderOutput.mockResolvedValue(PNG);
  mocks.inspectTryOnModelImage.mockResolvedValue({ width: 512, height: 512, meanLuma: 128, faceLuma: 140, faceCount: 1 });
  mocks.writeTryOnMedia.mockResolvedValue("123e4567-e89b-42d3-a456-426614174000/output.png");
  mocks.deleteTryOnMedia.mockResolvedValue(undefined);
});

describe("背景生成失敗結算", () => {
  it("供應商明確失敗：釋放個人額度及未發生預算", async () => {
    const job = makeJob();
    const { db } = makeDb(job);
    mocks.getDb.mockReturnValue(db);
    const p = provider({
      status: vi.fn(async () => ({ state: "failed" as const, code: "PROVIDER_FAILED", message: "失敗" })),
    });
    await processTryOnJob(job.id, p);
    expect(job).toMatchObject({
      status: "failed", failureCode: "PROVIDER_FAILED", creditsUsed: 0,
      estimatedCostCents: 0, costUncertain: false,
    });
    expect(p.submit).not.toHaveBeenCalled();
  });

  it("提交網絡結果不確定：每日額度釋放，但估算成本保留待核實", async () => {
    const job = makeJob({ status: "queued", providerJobId: null, startedAt: null });
    const { db } = makeDb(job);
    mocks.getDb.mockReturnValue(db);
    const p = provider({
      submit: vi.fn(async () => { throw new TryOnProviderError("PROVIDER_NETWORK", "offline", true); }),
    });
    await processTryOnJob(job.id, p);
    expect(p.submit).toHaveBeenCalledTimes(1);
    expect(job).toMatchObject({
      status: "failed", failureCode: "PROVIDER_NETWORK", creditsUsed: 0,
      estimatedCostCents: 30, costUncertain: true,
    });
  });

  it("舊 SUBMITTING 且冇 providerJobId：唔再 submit，兩分鐘後報成本待核實", async () => {
    const job = makeJob({
      providerJobId: null,
      failureCode: "SUBMITTING",
      updatedAt: new Date(Date.now() - 3 * 60 * 1000),
    });
    const { db } = makeDb(job);
    mocks.getDb.mockReturnValue(db);
    const p = provider();
    await processTryOnJob(job.id, p);
    expect(p.submit).not.toHaveBeenCalled();
    expect(p.status).not.toHaveBeenCalled();
    expect(job).toMatchObject({
      status: "failed", failureCode: "PROVIDER_SUBMIT_UNKNOWN",
      creditsUsed: 0, estimatedCostCents: 30, costUncertain: true,
    });
  });

  it("新 SUBMITTING 仲喺確認窗口：保留 processing，唔重複提交", async () => {
    const job = makeJob({ providerJobId: null, failureCode: "SUBMITTING", updatedAt: new Date() });
    const { db } = makeDb(job);
    mocks.getDb.mockReturnValue(db);
    const p = provider();
    await processTryOnJob(job.id, p);
    expect(p.submit).not.toHaveBeenCalled();
    expect(job).toMatchObject({
      status: "processing", failureCode: "SUBMITTING", estimatedCostCents: 30, costUncertain: false,
    });
  });

  it("30 分鐘前尚未提交：終止並釋放額度及預算", async () => {
    const job = makeJob({
      status: "queued", providerJobId: null, startedAt: null,
      createdAt: new Date(Date.now() - TRYON_JOB_TIMEOUT_MS - 1_000),
    });
    const { db } = makeDb(job);
    mocks.getDb.mockReturnValue(db);
    const p = provider();
    await processTryOnJob(job.id, p);
    expect(p.submit).not.toHaveBeenCalled();
    expect(job).toMatchObject({
      status: "failed", failureCode: "JOB_TIMEOUT", creditsUsed: 0,
      estimatedCostCents: 0, costUncertain: false,
    });
  });

  it("30 分鐘前可能已提交：終止但保留估算成本待核實", async () => {
    const job = makeJob({ createdAt: new Date(Date.now() - TRYON_JOB_TIMEOUT_MS - 1_000) });
    const { db } = makeDb(job);
    mocks.getDb.mockReturnValue(db);
    const p = provider();
    await processTryOnJob(job.id, p);
    expect(p.status).not.toHaveBeenCalled();
    expect(job).toMatchObject({
      status: "failed", failureCode: "PROVIDER_TIMEOUT", creditsUsed: 0,
      estimatedCostCents: 30, costUncertain: true,
    });
  });

  it("供應商已完成但私人 output 寫檔失敗：額度釋放、3 credits 及估算成本保留", async () => {
    const job = makeJob();
    const { db } = makeDb(job);
    mocks.getDb.mockReturnValue(db);
    mocks.writeTryOnMedia.mockRejectedValue(new Error("disk full"));
    const p = provider({
      status: vi.fn(async () => ({ state: "completed" as const, imageDataUri: "data:image/png;base64,aGVsbG8=" })),
    });
    await processTryOnJob(job.id, p);
    expect(job).toMatchObject({
      status: "failed", failureCode: "OUTPUT_STORAGE", creditsUsed: 3,
      estimatedCostCents: 30, costUncertain: false,
    });
    // 私人 output 寫唔成功就唔可以有後台副本
    expect(mocks.archiveTryOnMediaCopy).not.toHaveBeenCalled();
  });

  it("成功完成：記錄實際 3 credits、私人 output path，唔標成本不確定", async () => {
    const job = makeJob();
    const { db } = makeDb(job);
    mocks.getDb.mockReturnValue(db);
    const p = provider({
      status: vi.fn(async () => ({ state: "completed" as const, imageDataUri: "data:image/png;base64,aGVsbG8=" })),
    });
    await processTryOnJob(job.id, p);
    expect(job).toMatchObject({
      status: "completed", creditsUsed: 3, estimatedCostCents: 30,
      outputImagePath: "123e4567-e89b-42d3-a456-426614174000/output.png",
      costUncertain: false, failureCode: null,
    });
    // output 寫成功後即刻備一份入 30 日後台 archive
    expect(mocks.archiveTryOnMediaCopy).toHaveBeenCalledTimes(1);
    expect(mocks.archiveTryOnMediaCopy).toHaveBeenCalledWith(job.publicId, "output");
    // 接線順序：先寫私人 output 成功，先至複製去後台 archive
    const writeOrder = mocks.writeTryOnMedia.mock.invocationCallOrder[0]!;
    const archiveOrder = mocks.archiveTryOnMediaCopy.mock.invocationCallOrder[0]!;
    expect(archiveOrder).toBeGreaterThan(writeOrder);
  });

  it("後台 archive 複製失敗唔會反轉已成功嘅完成結算（best-effort）", async () => {
    const job = makeJob();
    const { db } = makeDb(job);
    mocks.getDb.mockReturnValue(db);
    mocks.archiveTryOnMediaCopy.mockRejectedValue(new Error("archive disk full"));
    const p = provider({
      status: vi.fn(async () => ({ state: "completed" as const, imageDataUri: "data:image/png;base64,aGVsbG8=" })),
    });
    await processTryOnJob(job.id, p);
    expect(job).toMatchObject({ status: "completed", creditsUsed: 3, failureCode: null });
  });
});

// ── createTryOnGeneration / getMyTryOnAccess 用嘅 table 路由 mock ──────────────
const OPEN_SETTINGS: TryOnSettings = tryOnSettingsSchema.parse({
  memberEnabled: true,
  qualityApproved: true,
  minimumTier: "SILVER",
  dailyLimitNone: 0,
  dailyLimitSilver: 1,
  dailyLimitGold: 2,
  staffDailyLimit: 5,
  siteDailyLimit: 20,
  creditCostCents: 10,
  monthlyBudgetCents: 1_000,
});

const STAFF_IDENTITY = { role: "staff", vipTier: "NONE", vipExpiresAt: null };
const GOLD_MEMBER_IDENTITY = { role: "member", vipTier: "GOLD", vipExpiresAt: null };

function makeProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    name: "短款外套",
    sku: "TOP-101",
    category: "top",
    image: "/uploads/top-101.png",
    photos: ["/uploads/top-101.png"],
    price: 599,
    discountPrice: null,
    isActive: true,
    delistEnabled: false,
    delistAt: null,
    ...overrides,
  };
}

interface TryOnDbOptions {
  settings?: TryOnSettings;
  identity?: Record<string, unknown>;
  product?: Record<string, unknown> | null;
  createdJob?: TryOnJob;
  sourceJob?: TryOnJob | null;
  lineageRows?: Array<Record<string, unknown>>;
  activeJob?: TryOnJob | null;
}

function makeTryOnDb(options: TryOnDbOptions = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const settings = options.settings ?? OPEN_SETTINGS;
  const identity = options.identity ?? STAFF_IDENTITY;
  const createdJob = options.createdJob ?? makeJob({ id: 99, status: "queued", providerJobId: null, startedAt: null });
  const project = (row: Record<string, unknown>, selection: Record<string, unknown>) =>
    Object.fromEntries(Object.keys(selection).map((key) => [key, row[key]]));
  const rowsFor = (table: unknown, selection: Record<string, unknown> | undefined, fromTx: boolean): unknown[] => {
    if (table === siteSettings) return [{ value: JSON.stringify(settings) }];
    if (table === users) return [identity];
    if (table === products) return options.product ? [options.product] : [];
    // tryOnJobs：db 無 selection 係 sourcePublicId 查找；tx 無 selection 係 idempotency 重複檢查
    if (!selection) return !fromTx && options.sourceJob ? [options.sourceJob] : [];
    if ("value" in selection) return [{ value: 0 }]; // usage count / sum
    if ("activePublicId" in selection) return options.activeJob ? [options.activeJob] : [];
    if (fromTx) return options.lineageRows ?? [];
    return [project(createdJob as unknown as Record<string, unknown>, selection)];
  };
  const chain = (rows: unknown[]): unknown => {
    const result = Promise.resolve(rows);
    return {
      limit: () => ({ for: () => result, then: result.then.bind(result) }),
      orderBy: () => chain(rows),
      then: result.then.bind(result),
    };
  };
  const api = (fromTx: boolean) => ({
    select(selection?: Record<string, unknown>) {
      return { from: (table: unknown) => ({ where: () => chain(rowsFor(table, selection, fromTx)) }) };
    },
    insert(table: unknown) {
      return {
        values: (values: Record<string, unknown>) => {
          if (table === tryOnJobs) inserted.push(values);
          return {
            onConflictDoNothing: async () => undefined,
            returning: async () => [createdJob],
          };
        },
      };
    },
    update() {
      return {
        set() {
          return this;
        },
        where() {
          return {
            returning: async () => [],
            then: (resolve: (value?: unknown) => unknown, reject?: (reason?: unknown) => unknown) =>
              Promise.resolve(undefined).then(resolve, reject),
          };
        },
      };
    },
  });
  const tx = api(true);
  return {
    db: { ...api(false), transaction: async (callback: (tx: unknown) => unknown) => callback(tx) },
    inserted,
  };
}

describe("getMyTryOnAccess APP_SECRET 閘口", () => {
  const savedKey = process.env.FASHN_API_KEY;
  const mutableEnv = env as unknown as { appSecret: string };
  beforeEach(() => {
    process.env.FASHN_API_KEY = "test-fashn-key";
    mutableEnv.appSecret = "unit-test-secret";
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.FASHN_API_KEY;
    else process.env.FASHN_API_KEY = savedKey;
    mutableEnv.appSecret = "unit-test-secret";
  });

  it("APP_SECRET 缺失：staff 見具體配置文案，唔可以提交", async () => {
    mutableEnv.appSecret = "";
    const { db } = makeTryOnDb({ identity: STAFF_IDENTITY });
    mocks.getDb.mockReturnValue(db);
    const access = await getMyTryOnAccess({ userId: 7, role: "staff" });
    expect(access.allowed).toBe(false);
    expect(access.memberEnabled).toBe(false);
    expect(access.providerConfigured).toBe(true);
    expect(access.reason).toBe("私人圖片保護尚未配置，請管理員檢查伺服器 APP_SECRET");
  });

  it("APP_SECRET 缺失：會員只見維護文案，唔會話已開放", async () => {
    mutableEnv.appSecret = "   ";
    const { db } = makeTryOnDb({ identity: GOLD_MEMBER_IDENTITY });
    mocks.getDb.mockReturnValue(db);
    const access = await getMyTryOnAccess({ userId: 8, role: "member" });
    expect(access.allowed).toBe(false);
    expect(access.memberEnabled).toBe(false);
    expect(access.providerConfigured).toBeNull();
    expect(access.reason).toBe("AI 試穿暫時維護中，請稍後再試");
  });

  it("APP_SECRET 及 API key 齊全：staff 及合資格會員都可以提交", async () => {
    const staffDb = makeTryOnDb({ identity: STAFF_IDENTITY });
    mocks.getDb.mockReturnValue(staffDb.db);
    const staffAccess = await getMyTryOnAccess({ userId: 7, role: "staff" });
    expect(staffAccess.allowed).toBe(true);
    expect(staffAccess.reason).toBeNull();

    const memberDb = makeTryOnDb({ identity: GOLD_MEMBER_IDENTITY });
    mocks.getDb.mockReturnValue(memberDb.db);
    const memberAccess = await getMyTryOnAccess({ userId: 8, role: "member" });
    expect(memberAccess.allowed).toBe(true);
    expect(memberAccess.memberEnabled).toBe(true);
    expect(memberAccess.reason).toBeNull();
  });
});

describe("createTryOnGeneration 生成前相片檢查", () => {
  const savedKey = process.env.FASHN_API_KEY;
  beforeEach(() => {
    process.env.FASHN_API_KEY = "test-fashn-key";
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.FASHN_API_KEY;
    else process.env.FASHN_API_KEY = savedKey;
  });

  const baseInput = {
    user: { userId: 7, role: "staff" as const },
    productId: 101,
    photoIndex: 0,
    idempotencyKey: "operation-1",
    modelImage: "data:image/png;base64,iVBORw0KGgo=",
  };

  it.each([
    ["NO_HUMAN_FACE", "偵測唔到清楚人像；請重新拍攝或上載。今次未送 AI 生成，亦未預留或扣除 credits。"],
    ["IMAGE_TOO_DARK", "相片光線太暗；請重新拍攝或上載。今次未送 AI 生成，亦未預留或扣除 credits。"],
  ])("%s：建立工作、DB reservation 及私人暫存之前已即拒", async (code, message) => {
    mocks.inspectTryOnModelImage.mockRejectedValue(new TryOnMediaError(code, message));
    const { db, inserted } = makeTryOnDb({ product: makeProduct() });
    const transaction = vi.spyOn(db, "transaction");
    mocks.getDb.mockReturnValue(db);
    await expect(createTryOnGeneration(baseInput)).rejects.toMatchObject({ code: "BAD_REQUEST", message });
    expect(transaction).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    expect(mocks.writeTryOnMedia).not.toHaveBeenCalled();
  });
});

describe("createTryOnGeneration 商品下架閘口", () => {
  const savedKey = process.env.FASHN_API_KEY;
  beforeEach(() => {
    process.env.FASHN_API_KEY = "test-fashn-key";
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.FASHN_API_KEY;
    else process.env.FASHN_API_KEY = savedKey;
  });

  const baseInput = {
    user: { userId: 7, role: "staff" as const },
    productId: 101,
    photoIndex: 0,
    idempotencyKey: "operation-1",
    modelImage: "data:image/png;base64,iVBORw0KGgo=",
  };

  it("delistEnabled 兼 delistAt 已到：同列表一樣視為已下架，唔可以建立試穿", async () => {
    const { db, inserted } = makeTryOnDb({
      product: makeProduct({ delistEnabled: true, delistAt: new Date(Date.now() - 60_000) }),
    });
    mocks.getDb.mockReturnValue(db);
    await expect(createTryOnGeneration(baseInput)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "商品不存在或已下架，請重新選擇",
    });
    expect(inserted).toHaveLength(0);
    expect(mocks.writeTryOnMedia).not.toHaveBeenCalled();
  });

  it("isActive 係 false 一樣即拒", async () => {
    const { db } = makeTryOnDb({ product: makeProduct({ isActive: false }) });
    mocks.getDb.mockReturnValue(db);
    await expect(createTryOnGeneration(baseInput)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("delistEnabled 但 delistAt 未到：商品仍可試穿", async () => {
    const { db, inserted } = makeTryOnDb({
      product: makeProduct({ delistEnabled: true, delistAt: new Date(Date.now() + 60_000) }),
    });
    mocks.getDb.mockReturnValue(db);
    const result = await createTryOnGeneration(baseInput);
    expect(result).toMatchObject({ stepNumber: 1, status: "queued", tryOnKind: "top" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ productId: 101, tryOnKind: "top", stepNumber: 1 });
  });
});

describe("createTryOnGeneration 同帳號並發防重", () => {
  const savedKey = process.env.FASHN_API_KEY;
  beforeEach(() => {
    process.env.FASHN_API_KEY = "test-fashn-key";
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.FASHN_API_KEY;
    else process.env.FASHN_API_KEY = savedKey;
  });

  it("另一件 queued／processing 未完成：新 idempotency key 都拒絕，唔會雙重預留", async () => {
    const { db, inserted } = makeTryOnDb({
      product: makeProduct(),
      activeJob: makeJob({ id: 88, status: "processing" }),
    });
    mocks.getDb.mockReturnValue(db);
    await expect(createTryOnGeneration({
      user: { userId: 7, role: "staff" },
      productId: 101,
      photoIndex: 0,
      idempotencyKey: "another-operation",
      modelImage: "data:image/png;base64,iVBORw0KGgo=",
    })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "你有另一件試穿仲生成緊；完成或失敗後先可以再提交，今次未預留額度",
    });
    expect(inserted).toHaveLength(0);
    expect(mocks.writeTryOnMedia).not.toHaveBeenCalled();
  });
});

describe("createTryOnGeneration 後台 archive 接線", () => {
  const savedKey = process.env.FASHN_API_KEY;
  beforeEach(() => {
    process.env.FASHN_API_KEY = "test-fashn-key";
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.FASHN_API_KEY;
    else process.env.FASHN_API_KEY = savedKey;
  });

  const baseInput = {
    user: { userId: 7, role: "staff" as const },
    productId: 101,
    photoIndex: 0,
    idempotencyKey: "operation-1",
    modelImage: "data:image/png;base64,iVBORw0KGgo=",
  };

  it("input 寫入私人目錄成功後，即刻用同一 publicId 備一份入 30 日後台 archive", async () => {
    const { db, inserted } = makeTryOnDb({ product: makeProduct() });
    mocks.getDb.mockReturnValue(db);
    const result = await createTryOnGeneration(baseInput);
    expect(result.status).toBe("queued");
    expect(inserted).toHaveLength(1);
    expect(mocks.writeTryOnMedia).toHaveBeenCalledTimes(1);
    const [publicId, kind] = mocks.writeTryOnMedia.mock.calls[0] as [string, string, Buffer];
    expect(kind).toBe("input");
    expect(mocks.archiveTryOnMediaCopy).toHaveBeenCalledTimes(1);
    expect(mocks.archiveTryOnMediaCopy).toHaveBeenCalledWith(publicId, "input");
    // 順序：先寫私人 input 成功，先至複製去後台 archive
    expect(mocks.archiveTryOnMediaCopy.mock.invocationCallOrder[0]!).toBeGreaterThan(
      mocks.writeTryOnMedia.mock.invocationCallOrder[0]!,
    );
  });

  it("私人 input 寫檔失敗：唔會有後台副本，工作標記 PRIVATE_STORAGE", async () => {
    const { db } = makeTryOnDb({ product: makeProduct() });
    mocks.getDb.mockReturnValue(db);
    mocks.writeTryOnMedia.mockRejectedValue(new Error("disk full"));
    await expect(createTryOnGeneration(baseInput)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "私人圖片暫存失敗，請稍後再試",
    });
    expect(mocks.archiveTryOnMediaCopy).not.toHaveBeenCalled();
  });

  it("後台 archive 複製失敗唔會反轉已成立嘅工作（best-effort，照樣起背景生成）", async () => {
    const { db, inserted } = makeTryOnDb({ product: makeProduct() });
    mocks.getDb.mockReturnValue(db);
    mocks.archiveTryOnMediaCopy.mockRejectedValue(new Error("archive disk full"));
    const result = await createTryOnGeneration(baseInput);
    expect(result.status).toBe("queued");
    expect(inserted).toHaveLength(1);
    expect(mocks.archiveTryOnMediaCopy).toHaveBeenCalledTimes(1);
  });
});

describe("cleanupExpiredTryOnAdminArchive 30 日 retention sweeper", () => {
  const FIXED_NOW = 1_760_000_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSweepDb(rows: Array<{ id: number; publicId: string }>) {
    let capturedWhere: unknown;
    const db = {
      select: () => ({
        from: () => ({
          where: (where: unknown) => {
            capturedWhere = where;
            return { limit: async () => rows };
          },
        }),
      }),
    };
    return { db, getWhere: () => capturedWhere };
  }

  it("只按 createdAt ≤ now−30d 刪後台副本；where 絕唔掛 expiresAt／mediaDeletedAt", async () => {
    const rows = [
      { id: 1, publicId: "123e4567-e89b-42d3-a456-426614174000" },
      { id: 2, publicId: "223e4567-e89b-42d3-a456-426614174000" },
    ];
    const { db, getWhere } = makeSweepDb(rows);
    mocks.getDb.mockReturnValue(db);
    const deleted = await cleanupExpiredTryOnAdminArchive();
    expect(deleted).toBe(2);
    expect(mocks.deleteTryOnAdminArchive).toHaveBeenNthCalledWith(1, rows[0]!.publicId);
    expect(mocks.deleteTryOnAdminArchive).toHaveBeenNthCalledWith(2, rows[1]!.publicId);

    const q = new PgDialect().sqlToQuery(getWhere() as any);
    expect(q.sql).toContain("createdAt");
    expect(q.sql).toContain("<=");
    // PgDialect 會將 Date 參數序列化成 ISO string；核對實際 cutoff 時刻，唔綁死驅動嘅參數表示法。
    expect(new Date(q.params[0] as string | Date).getTime()).toBe(
      FIXED_NOW - TRYON_ADMIN_ARCHIVE_RETENTION_MS,
    );
    expect(q.sql).not.toContain("expiresAt");
    expect(q.sql).not.toContain("mediaDeletedAt");
  });

  it("cutoff boundary 同 archiveAvailable helper 一致：啱啱好 30 日（createdAt+30d === now）落入刪除範圍", () => {
    // helper：createdAt + 30d > now 先可睇 → 啱啱好 30 日唔可睇
    // sweeper：lte(createdAt, now − 30d) → 啱啱好 30 日會被刪。兩者 boundary 完全一致。
    const cutoff = new Date(FIXED_NOW - TRYON_ADMIN_ARCHIVE_RETENTION_MS);
    expect(cutoff.getTime() + TRYON_ADMIN_ARCHIVE_RETENTION_MS).toBe(FIXED_NOW);
  });

  it("個別副本刪除失敗唔會阻其他，回報實際刪到嘅數目，留待下一輪重試", async () => {
    const rows = [
      { id: 1, publicId: "123e4567-e89b-42d3-a456-426614174000" },
      { id: 2, publicId: "223e4567-e89b-42d3-a456-426614174000" },
    ];
    const { db } = makeSweepDb(rows);
    mocks.getDb.mockReturnValue(db);
    mocks.deleteTryOnAdminArchive
      .mockRejectedValueOnce(new Error("io error"))
      .mockResolvedValueOnce(undefined);
    const deleted = await cleanupExpiredTryOnAdminArchive();
    expect(deleted).toBe(1);
    expect(mocks.deleteTryOnAdminArchive).toHaveBeenCalledTimes(2);
  });

  it("冇到期工作：唔郁任何副本", async () => {
    const { db } = makeSweepDb([]);
    mocks.getDb.mockReturnValue(db);
    expect(await cleanupExpiredTryOnAdminArchive()).toBe(0);
    expect(mocks.deleteTryOnAdminArchive).not.toHaveBeenCalled();
  });
});

describe("createTryOnGeneration 已刪除步驟嘅混搭分叉", () => {
  const savedKey = process.env.FASHN_API_KEY;
  beforeEach(() => {
    process.env.FASHN_API_KEY = "test-fashn-key";
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.FASHN_API_KEY;
    else process.env.FASHN_API_KEY = savedKey;
  });

  const sourceJob = makeJob({
    id: 50,
    publicId: "323e4567-e89b-42d3-a456-426614174000",
    stepNumber: 1,
    status: "completed",
    outputImagePath: "323e4567-e89b-42d3-a456-426614174000/output.png",
  });
  const step1Row = { productId: 101, stepNumber: 1, tryOnKind: "top", status: "completed", mediaDeletedAt: null };
  const step2Row = { productId: 202, stepNumber: 2, tryOnKind: "pants", status: "completed", mediaDeletedAt: null };
  const input = {
    user: { userId: 7, role: "staff" as const },
    productId: 202,
    photoIndex: 0,
    idempotencyKey: "operation-2",
    sourcePublicId: sourceJob.publicId,
  };
  const step2Job = makeJob({
    id: 99,
    stepNumber: 2,
    sourceJobId: 50,
    productId: 202,
    productName: "高腰長褲",
    productSku: "PANTS-202",
    productCategory: "pants",
    tryOnKind: "pants",
    status: "queued",
    providerJobId: null,
    startedAt: null,
  });
  const pantsProduct = makeProduct({ id: 202, name: "高腰長褲", sku: "PANTS-202", category: "pants" });

  it("已刪除嘅 completed step-2 唔阻由 step-1 用同一商品新建 step-2", async () => {
    const { db, inserted } = makeTryOnDb({
      product: pantsProduct,
      createdJob: step2Job,
      sourceJob,
      lineageRows: [step1Row, { ...step2Row, mediaDeletedAt: new Date() }],
    });
    mocks.getDb.mockReturnValue(db);
    const result = await createTryOnGeneration(input);
    expect(result).toMatchObject({ stepNumber: 2, status: "queued", tryOnKind: "pants" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ stepNumber: 2, sourceJobId: 50, productId: 202 });
  });

  it("未刪除嘅 completed step-2 仍然 BRANCH 阻死", async () => {
    const { db, inserted } = makeTryOnDb({
      product: pantsProduct,
      createdJob: step2Job,
      sourceJob,
      lineageRows: [step1Row, step2Row],
    });
    mocks.getDb.mockReturnValue(db);
    await expect(createTryOnGeneration(input)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "呢套造型已經有下一步，請由最新結果繼續追加",
    });
    expect(inserted).toHaveLength(0);
  });

  it("lookItems 回傳 mediaDeleted 旗標但唔暴露 mediaDeletedAt 時間", async () => {
    const { db } = makeTryOnDb({
      product: pantsProduct,
      createdJob: { ...step2Job, mediaDeletedAt: new Date() },
      sourceJob,
      lineageRows: [step1Row, { ...step2Row, mediaDeletedAt: new Date() }],
    });
    mocks.getDb.mockReturnValue(db);
    const result = await createTryOnGeneration(input);
    expect(result.lookItems).toHaveLength(1);
    expect(result.lookItems[0]).toMatchObject({ mediaDeleted: true });
    expect(result.lookItems[0]).not.toHaveProperty("mediaDeletedAt");
  });
});

describe("客戶試穿紀錄及 24 小時分享 DTO", () => {
  const FIXED_NOW = 1_760_000_000_000;

  function makeHistoryDb(rows: Array<Record<string, unknown>>) {
    const state = { where: undefined as unknown };
    const limit = vi.fn(async () => rows);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn((condition: unknown) => {
      state.where = condition;
      return { limit, orderBy };
    });
    const leftJoin = vi.fn(() => ({ where }));
    const db = {
      select: () => ({
        from: () => ({ where, leftJoin }),
      }),
    };
    return { db, state, limit, orderBy, leftJoin };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("listMyTryOnRecords：server where 強制本人 userId，只回 completed 未刪未到期 output，DTO 無私人路徑", async () => {
    const row = {
      publicId: "123e4567-e89b-42d3-a456-426614174000",
      lookId: "223e4567-e89b-42d3-a456-426614174000",
      stepNumber: 1,
      productId: 101,
      productName: "測試上衣",
      productSku: "TOP-101",
      productPrice: 599,
      productDiscountPrice: 499,
      listedDate: new Date(FIXED_NOW - 1000),
      outputImagePath: "private/output.png",
      expiresAt: new Date(FIXED_NOW + 60_000),
      createdAt: new Date(FIXED_NOW - 1000),
      userId: 7,
    };
    const h = makeHistoryDb([row]);
    mocks.getDb.mockReturnValue(h.db);

    const result = await listMyTryOnRecords({ userId: 7, role: "member" });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ productName: "測試上衣", productSku: "TOP-101", productPrice: 599 });
    expect(result[0]?.outputUrl).toContain("/api/tryon/media/123e4567-e89b-42d3-a456-426614174000/output?");
    expect(result[0]).not.toHaveProperty("userId");
    expect(result[0]).not.toHaveProperty("outputImagePath");
    expect(JSON.stringify(result)).not.toContain("private/output.png");
    expect(h.limit).toHaveBeenCalledWith(60);
    expect(h.orderBy).toHaveBeenCalledTimes(1);

    const q = new PgDialect().sqlToQuery(h.state.where as any);
    expect(q.sql).toContain("userId");
    expect(q.sql).toContain("status");
    expect(q.sql).toContain("mediaDeletedAt");
    expect(q.sql).toContain("expiresAt");
    expect(q.params).toContain(7);
    expect(q.params).toContain("completed");
  });

  it("getOwnedTryOnShareLink：owner scope 綁 publicId＋userId，分享期限同 DB expiresAt 完全一致", async () => {
    const job = makeJob({
      status: "completed",
      outputImagePath: "private/output.png",
      expiresAt: new Date(FIXED_NOW + 3_600_000),
    });
    const h = makeHistoryDb([job as unknown as Record<string, unknown>]);
    mocks.getDb.mockReturnValue(h.db);

    const result = await getOwnedTryOnShareLink({ userId: 7, role: "member" }, job.publicId);
    expect(result.expiresAt.getTime()).toBe(job.expiresAt.getTime());
    const url = new URL(result.url, "https://redcode.example");
    expect(url.pathname).toBe(`/try-on/shared/${job.publicId}`);
    expect(Number(url.searchParams.get("e"))).toBe(job.expiresAt.getTime());
    expect(url.searchParams.get("s")).toBeTruthy();
    expect(url.searchParams.get("u")).toBeNull();

    const q = new PgDialect().sqlToQuery(h.state.where as any);
    expect(q.params).toContain(job.publicId);
    expect(q.params).toContain(7);
  });

  it("getOwnedTryOnShareLink：非 owner 或已刪都唔簽", async () => {
    const missing = makeHistoryDb([]);
    mocks.getDb.mockReturnValue(missing.db);
    await expect(
      getOwnedTryOnShareLink({ userId: 99, role: "member" }, "123e4567-e89b-42d3-a456-426614174000"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const deleted = makeJob({ status: "completed", outputImagePath: "private/output.png", mediaDeletedAt: new Date() });
    const h = makeHistoryDb([deleted as unknown as Record<string, unknown>]);
    mocks.getDb.mockReturnValue(h.db);
    await expect(
      getOwnedTryOnShareLink({ userId: 7, role: "member" }, deleted.publicId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("getSharedTryOnRecord：有效凭证只回生成圖同公開商品資料，唔回原相、userId、DB 狀態或私人路徑", async () => {
    const publicId = "123e4567-e89b-42d3-a456-426614174000";
    const expiresAt = new Date(FIXED_NOW + 3_600_000);
    const share = signTryOnShare({ publicId, expiresAt, secret: env.appSecret });
    const url = new URL(share.url, "https://redcode.example");
    const row = {
      publicId,
      status: "completed",
      outputImagePath: "private/output.png",
      mediaDeletedAt: null,
      expiresAt,
      productId: 101,
      productName: "測試上衣",
      productSku: "TOP-101",
      productPrice: 599,
      productDiscountPrice: null,
      listedDate: new Date(FIXED_NOW - 1000),
      userId: 7,
      inputImagePath: "private/input.jpg",
    };
    const h = makeHistoryDb([row]);
    mocks.getDb.mockReturnValue(h.db);

    const result = await getSharedTryOnRecord({
      publicId,
      expires: expiresAt.getTime(),
      signature: url.searchParams.get("s")!,
    });
    expect(result.outputUrl).toContain(`/api/tryon/shared-media/${publicId}?`);
    expect(Object.keys(result).sort()).toEqual([
      "expiresAt",
      "listedDate",
      "outputUrl",
      "productDiscountPrice",
      "productId",
      "productName",
      "productPrice",
      "productSku",
    ].sort());
    expect(JSON.stringify(result)).not.toContain("private/");
    expect(JSON.stringify(result)).not.toContain("userId");
  });

  it("getSharedTryOnRecord：篡改凭证唔會查 DB；DB 期限唔一致都拒絕", async () => {
    const publicId = "123e4567-e89b-42d3-a456-426614174000";
    const expiresAt = new Date(FIXED_NOW + 3_600_000);
    await expect(
      getSharedTryOnRecord({ publicId, expires: expiresAt.getTime(), signature: "tampered" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.getDb).not.toHaveBeenCalled();

    const share = signTryOnShare({ publicId, expiresAt, secret: env.appSecret });
    const url = new URL(share.url, "https://redcode.example");
    const row = {
      publicId,
      status: "completed",
      outputImagePath: "private/output.png",
      mediaDeletedAt: null,
      expiresAt: new Date(FIXED_NOW + 7_200_000),
      productId: 101,
      productName: "測試上衣",
      productSku: "TOP-101",
      productPrice: 599,
      productDiscountPrice: null,
      listedDate: null,
    };
    const h = makeHistoryDb([row]);
    mocks.getDb.mockReturnValue(h.db);
    await expect(
      getSharedTryOnRecord({ publicId, expires: expiresAt.getTime(), signature: url.searchParams.get("s")! }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
