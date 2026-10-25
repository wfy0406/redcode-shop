import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryOnSettingsSchema, type TryOnSettings } from "./tryonConfig";

const mocks = vi.hoisted(() => ({
  getTryOnSettings: vi.fn(),
  mediaSecretConfigured: vi.fn(),
}));

vi.mock("./lib/env", () => ({
  env: { appSecret: "unit-test-secret", appId: "unit-test", databaseUrl: "", isProduction: false },
}));
vi.mock("./audit", () => ({ logAudit: vi.fn() }));
vi.mock("./middleware", () => {
  const proc = {
    query: (fn: unknown) => fn,
    mutation: (fn: unknown) => fn,
    input: () => ({ query: (fn: unknown) => fn, mutation: (fn: unknown) => fn }),
  };
  return {
    createRouter: (routes: unknown) => routes,
    publicQuery: proc,
    publicProcedure: proc,
    authedProcedure: proc,
    staffProcedure: proc,
    supervisorProcedure: proc,
    adminProcedure: proc,
  };
});
vi.mock("./tryonService", () => ({
  createTryOnGeneration: vi.fn(),
  deleteOwnedTryOnMedia: vi.fn(),
  getMyTryOnAccess: vi.fn(),
  getOwnedTryOnJob: vi.fn(),
  getTryOnAdminStats: vi.fn(),
  getTryOnSettings: mocks.getTryOnSettings,
  listTryOnProducts: vi.fn(),
  saveTryOnSettings: vi.fn(),
  tryOnMediaSecretConfigured: mocks.mediaSecretConfigured,
}));

import { tryonRouter } from "./tryonRouter";

const router = tryonRouter as unknown as {
  getPublicConfig: () => Promise<{ memberEnabled: boolean }>;
  getAdminConfig: () => Promise<{
    memberOpen: boolean;
    providerConfigured: boolean;
    mediaProtectionConfigured: boolean;
  }>;
};

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

describe("tryonRouter 對外開放狀態閘口", () => {
  const savedKey = process.env.FASHN_API_KEY;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FASHN_API_KEY = "test-fashn-key";
    mocks.getTryOnSettings.mockResolvedValue(OPEN_SETTINGS);
    mocks.mediaSecretConfigured.mockReturnValue(true);
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.FASHN_API_KEY;
    else process.env.FASHN_API_KEY = savedKey;
  });

  it("getPublicConfig：設定開放＋API key＋APP_SECRET 齊全先對外話已開放", async () => {
    const config = await router.getPublicConfig();
    expect(config.memberEnabled).toBe(true);
  });

  it("getPublicConfig：APP_SECRET 閘口未過時即使後台開咗都唔會對外話已開放", async () => {
    mocks.mediaSecretConfigured.mockReturnValue(false);
    const config = await router.getPublicConfig();
    expect(config.memberEnabled).toBe(false);
  });

  it("getPublicConfig：API key 缺失時一樣唔會對外話已開放", async () => {
    delete process.env.FASHN_API_KEY;
    const config = await router.getPublicConfig();
    expect(config.memberEnabled).toBe(false);
  });

  it("getAdminConfig：memberOpen 同時要求 provider 及 APP_SECRET 閘口，唔會誤顯示開放中", async () => {
    mocks.mediaSecretConfigured.mockReturnValue(false);
    const missing = await router.getAdminConfig();
    expect(missing.providerConfigured).toBe(true);
    expect(missing.memberOpen).toBe(false);

    mocks.mediaSecretConfigured.mockReturnValue(true);
    const ready = await router.getAdminConfig();
    expect(ready.memberOpen).toBe(true);
  });
});
