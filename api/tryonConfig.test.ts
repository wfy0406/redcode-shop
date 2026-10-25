import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRYON_SETTINGS,
  TRYON_CREDITS_PER_GENERATION,
  canUseTryOn,
  evaluateTryOnAdmission,
  findTryOnLineageConflict,
  isTryOnMemberOpen,
  tryOnHongKongPeriods,
  tryOnSettingsSchema,
  type TryOnSettings,
} from "./tryonConfig";

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

const UNUSED = { userUsed: 0, siteUsed: 0, monthReservedCents: 0 };

describe("AI 試穿開放閘口", () => {
  it("預設只准同事內測，會員閘口及品質批准保持關閉", () => {
    expect(DEFAULT_TRYON_SETTINGS.memberEnabled).toBe(false);
    expect(DEFAULT_TRYON_SETTINGS.qualityApproved).toBe(false);
    expect(canUseTryOn("staff", "NONE", DEFAULT_TRYON_SETTINGS)).toBe(true);
    expect(canUseTryOn("member", "GOLD", DEFAULT_TRYON_SETTINGS)).toBe(false);
  });

  it("會員開放必須同時具備品質批准、成本單價及每月預算", () => {
    expect(isTryOnMemberOpen(OPEN_SETTINGS)).toBe(true);
    expect(isTryOnMemberOpen({ ...OPEN_SETTINGS, qualityApproved: false })).toBe(false);
    expect(isTryOnMemberOpen({ ...OPEN_SETTINGS, creditCostCents: 0 })).toBe(false);
    expect(isTryOnMemberOpen({ ...OPEN_SETTINGS, monthlyBudgetCents: 0 })).toBe(false);
    expect(tryOnSettingsSchema.safeParse({ ...OPEN_SETTINGS, qualityApproved: false }).success).toBe(false);
    expect(tryOnSettingsSchema.safeParse({ ...OPEN_SETTINGS, creditCostCents: 0 }).success).toBe(false);
    expect(tryOnSettingsSchema.safeParse({ ...OPEN_SETTINGS, monthlyBudgetCents: 0 }).success).toBe(false);
  });

  it("有效會員級別先可以用；唔會將未達最低級別當有額度", () => {
    expect(canUseTryOn("member", "NONE", OPEN_SETTINGS)).toBe(false);
    expect(canUseTryOn("member", "SILVER", OPEN_SETTINGS)).toBe(true);
    expect(canUseTryOn("member", "GOLD", OPEN_SETTINGS)).toBe(true);
  });
});

describe("AI 試穿額度及成本預留", () => {
  it("固定每件 quality 生成 3 credits，成本按生成時單價估算", () => {
    const result = evaluateTryOnAdmission({
      role: "member",
      effectiveTier: "GOLD",
      settings: OPEN_SETTINGS,
      usage: UNUSED,
    });
    expect(TRYON_CREDITS_PER_GENERATION).toBe(3);
    expect(result).toEqual({ ok: true, dailyLimit: 2, remainingAfterReservation: 1, estimatedCostCents: 30 });
  });

  it("個人每日額度、全站每日額度及每月預算分開拒絕", () => {
    expect(evaluateTryOnAdmission({
      role: "member", effectiveTier: "SILVER", settings: OPEN_SETTINGS,
      usage: { ...UNUSED, userUsed: 1 },
    })).toMatchObject({ ok: false, code: "DAILY_LIMIT" });
    expect(evaluateTryOnAdmission({
      role: "staff", effectiveTier: "NONE", settings: OPEN_SETTINGS,
      usage: { ...UNUSED, siteUsed: 20 },
    })).toMatchObject({ ok: false, code: "SITE_DAILY_LIMIT" });
    expect(evaluateTryOnAdmission({
      role: "staff", effectiveTier: "NONE", settings: OPEN_SETTINGS,
      usage: { ...UNUSED, monthReservedCents: 980 },
    })).toMatchObject({ ok: false, code: "MONTHLY_BUDGET" });
  });

  it("0 次額度回權限未開放，唔係錯報已用完", () => {
    const settings = { ...OPEN_SETTINGS, minimumTier: "NONE" as const };
    expect(evaluateTryOnAdmission({
      role: "member", effectiveTier: "NONE", settings,
      usage: UNUSED,
    })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("已設預算但成本未知時停止生成，唔會當免費", () => {
    expect(evaluateTryOnAdmission({
      role: "staff", effectiveTier: "NONE",
      settings: { ...OPEN_SETTINGS, creditCostCents: 0 },
      usage: UNUSED,
    })).toMatchObject({ ok: false, code: "COST_UNKNOWN" });
  });
});

describe("Mix & Match 有效造型部位", () => {
  const first = { productId: 1, stepNumber: 1, tryOnKind: "top", status: "completed", mediaDeletedAt: null };

  it("第二步失敗後可用新操作編號重試同一商品及部位", () => {
    expect(findTryOnLineageConflict({
      rows: [first, { productId: 2, stepNumber: 2, tryOnKind: "pants", status: "failed", mediaDeletedAt: null }],
      sourceStepNumber: 1,
      productId: 2,
      tryOnKind: "pants",
    })).toBeNull();
  });

  it.each(["queued", "processing", "completed"])("有效下一步狀態 %s 會阻止由舊結果開分叉", (status) => {
    expect(findTryOnLineageConflict({
      rows: [first, { productId: 2, stepNumber: 2, tryOnKind: "pants", status, mediaDeletedAt: null }],
      sourceStepNumber: 1,
      productId: 3,
      tryOnKind: "shoes",
    })).toBe("BRANCH");
  });

  it("成功造型不可重複商品或相同穿著部位；戒指＋耳環可以", () => {
    expect(findTryOnLineageConflict({
      rows: [first], sourceStepNumber: 1, productId: 1, tryOnKind: "top",
    })).toBe("DUPLICATE_PRODUCT");
    expect(findTryOnLineageConflict({
      rows: [first], sourceStepNumber: 1, productId: 9, tryOnKind: "top",
    })).toBe("DUPLICATE_KIND");
    expect(findTryOnLineageConflict({
      rows: [{ ...first, productId: 4, tryOnKind: "ring" }],
      sourceStepNumber: 1, productId: 5, tryOnKind: "earrings",
    })).toBeNull();
  });
});

describe("Mix & Match 已刪除步驟嘅分叉及防重", () => {
  const deletedAt = new Date("2026-10-25T10:00:00.000Z");
  const step1 = { productId: 1, stepNumber: 1, tryOnKind: "top", status: "completed", mediaDeletedAt: null };

  it.each(["completed", "processing"])(
    "已刪除嘅 %s step-2 唔會再阻由 step-1 新建 step-2（BRANCH 解除）",
    (status) => {
      expect(findTryOnLineageConflict({
        rows: [step1, { productId: 2, stepNumber: 2, tryOnKind: "pants", status, mediaDeletedAt: deletedAt }],
        sourceStepNumber: 1,
        productId: 3,
        tryOnKind: "shoes",
      })).toBeNull();
    },
  );

  it("已刪除 step-2 嘅商品及部位可以由 step-1 重新選", () => {
    const rows = [step1, { productId: 2, stepNumber: 2, tryOnKind: "pants", status: "completed", mediaDeletedAt: deletedAt }];
    expect(findTryOnLineageConflict({
      rows, sourceStepNumber: 1, productId: 2, tryOnKind: "pants",
    })).toBeNull();
    expect(findTryOnLineageConflict({
      rows, sourceStepNumber: 1, productId: 8, tryOnKind: "pants",
    })).toBeNull();
  });

  it("未刪除嘅 step-2 仍阻分叉，商品及部位仍不可重複", () => {
    const rows = [step1, { productId: 2, stepNumber: 2, tryOnKind: "pants", status: "completed", mediaDeletedAt: null }];
    expect(findTryOnLineageConflict({
      rows, sourceStepNumber: 1, productId: 3, tryOnKind: "shoes",
    })).toBe("BRANCH");
    expect(findTryOnLineageConflict({
      rows, sourceStepNumber: 1, productId: 2, tryOnKind: "shoes",
    })).toBe("BRANCH");
  });

  it("由 step-3 追加時，已刪除嘅中間 step-2 商品及部位仍要防重（件衫可能仍喺 source 圖）", () => {
    const rows = [
      step1,
      { productId: 2, stepNumber: 2, tryOnKind: "pants", status: "completed", mediaDeletedAt: deletedAt },
      { productId: 3, stepNumber: 3, tryOnKind: "shoes", status: "completed", mediaDeletedAt: null },
    ];
    expect(findTryOnLineageConflict({
      rows, sourceStepNumber: 3, productId: 2, tryOnKind: "dress",
    })).toBe("DUPLICATE_PRODUCT");
    expect(findTryOnLineageConflict({
      rows, sourceStepNumber: 3, productId: 9, tryOnKind: "pants",
    })).toBe("DUPLICATE_KIND");
    expect(findTryOnLineageConflict({
      rows, sourceStepNumber: 3, productId: 9, tryOnKind: "dress",
    })).toBeNull();
  });

  it("已刪除嘅 step-3 唔阻由 step-2 再追加同款，但未刪除嘅 step-2 商品仍防重", () => {
    const rows = [
      step1,
      { productId: 2, stepNumber: 2, tryOnKind: "pants", status: "completed", mediaDeletedAt: null },
      { productId: 3, stepNumber: 3, tryOnKind: "shoes", status: "completed", mediaDeletedAt: deletedAt },
    ];
    expect(findTryOnLineageConflict({
      rows, sourceStepNumber: 2, productId: 3, tryOnKind: "shoes",
    })).toBeNull();
    expect(findTryOnLineageConflict({
      rows, sourceStepNumber: 2, productId: 2, tryOnKind: "shoes",
    })).toBe("DUPLICATE_PRODUCT");
  });
});

describe("香港統計期間", () => {
  it("固定 UTC+8 處理日界及年界", () => {
    expect(tryOnHongKongPeriods(new Date("2026-01-01T15:59:59.000Z"))).toEqual({
      date: "2026-01-01", month: "2026-01", year: "2026",
    });
    expect(tryOnHongKongPeriods(new Date("2025-12-31T16:00:00.000Z"))).toEqual({
      date: "2026-01-01", month: "2026-01", year: "2026",
    });
  });
});
