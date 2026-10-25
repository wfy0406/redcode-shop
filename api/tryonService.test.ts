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

import { TRYON_JOB_TIMEOUT_MS, createTryOnGeneration, getMyTryOnAccess, processTryOnJob } from "./tryonService";

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
