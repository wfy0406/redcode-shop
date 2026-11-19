/**
 * Glo Glo 排程測試（唔掂 DB）：
 * ─ 同日 slot 重複：已有 job（任何狀態，包括 failed）→ 唔再開文（idempotency）；
 * ─ slot 鐘點 env 解析；automation env 閘；
 * ─ source guard：scheduler 真係用 slotKey 做 idempotencyKey 傳入 generateArticle
 *   （回歸防線：之前 generateArticle 忽略 options 導致同日重複開文）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const schedulerRecovery = vi.hoisted(() => ({
  recover: vi.fn(async () => ({ requeued: 0, resumed: 0, failed: 0 })),
}));
const schedulerGuards = vi.hoisted(() => ({
  getDb: vi.fn(),
  generate: vi.fn(),
  recordFailed: vi.fn(),
}));
vi.mock("./gloGuideOrchestrator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gloGuideOrchestrator")>();
  return { ...actual, recoverGloGuideJobs: schedulerRecovery.recover };
});
vi.mock("./queries/connection", () => ({ getDb: schedulerGuards.getDb }));
vi.mock("./gloGuideService", () => ({
  generateArticle: schedulerGuards.generate,
  recordFailedScheduledSlot: schedulerGuards.recordFailed,
}));

import {
  gloGuideAutomationEnabled,
  gloGuideSchedulerTick,
  gloGuideSlotHour,
  runScheduledSlot,
  shouldCreateScheduledArticle,
  startGloGuideScheduler,
} from "./gloGuideScheduler";
import { gloGuideSlotKey, resolveGenerateJobParams } from "./gloGuideValidation";

describe("同日 slot 重複防止", () => {
  it("冇 job 先開；有 job（任何狀態）一律唔再開", () => {
    expect(shouldCreateScheduledArticle(null)).toBe(true);
    for (const status of ["queued", "submitted", "processing", "completed", "failed"]) {
      expect(shouldCreateScheduledArticle({ status })).toBe(false);
    }
  });
  it("slot key 按香港日期唔同；同一日同一 key", () => {
    expect(gloGuideSlotKey("20261116")).not.toBe(gloGuideSlotKey("20261120"));
    expect(gloGuideSlotKey("20261116")).toBe(gloGuideSlotKey("20261116"));
  });
  it("排程生成參數：source auto＋kind scheduled＋key 係 slotKey（真落 DB unique）", () => {
    const slotKey = gloGuideSlotKey("20261116");
    const params = resolveGenerateJobParams("pub-id", {
      source: "auto",
      jobKind: "scheduled",
      idempotencyKey: slotKey,
    });
    expect(params).toEqual({ source: "auto", jobKind: "scheduled", idempotencyKey: slotKey });
  });

  it("實跑：同一 slotKey 連續兩次 tick 只開一次文（in-memory 模擬同日重複 tick）", async () => {
    const slotKey = gloGuideSlotKey("20261116");
    // in-memory「DB」：job 表＋建文次數
    const jobs = new Map<string, { status: string }>();
    let created = 0;
    const deps = {
      findJobByKey: async (key: string) => jobs.get(key) ?? null,
      createScheduledArticle: async (key: string) => {
        created++;
        jobs.set(key, { status: "queued" });
      },
      recordFailedSlot: async (key: string, error: string) => {
        jobs.set(key, { status: "failed" });
      },
    };
    expect(await runScheduledSlot(slotKey, deps)).toBe("created");
    // 同日之後每 5 分鐘 tick：queued/processing/failed 都唔會再開
    expect(await runScheduledSlot(slotKey, deps)).toBe("exists");
    jobs.set(slotKey, { status: "processing" });
    expect(await runScheduledSlot(slotKey, deps)).toBe("exists");
    jobs.set(slotKey, { status: "failed" });
    expect(await runScheduledSlot(slotKey, deps)).toBe("exists");
    expect(created).toBe(1);
    // 下一個 slot（另一日）先再開
    expect(await runScheduledSlot(gloGuideSlotKey("20261120"), deps)).toBe("created");
    expect(created).toBe(2);
  });

  it("實跑：建文前失敗（例如 <2 件貨）→ 落 failed 紀錄消費 slot，唔會每 5 分鐘洗版 retry", async () => {
    const slotKey = gloGuideSlotKey("20261116");
    const jobs = new Map<string, { status: string }>();
    let createAttempts = 0;
    let recorded: string | null = null;
    const deps = {
      findJobByKey: async (key: string) => jobs.get(key) ?? null,
      createScheduledArticle: async () => {
        createAttempts++;
        throw new Error("本週冇足夠可選商品（最少 2 件）");
      },
      recordFailedSlot: async (key: string, error: string) => {
        recorded = error;
        jobs.set(key, { status: "failed" });
      },
    };
    // 第一次 tick：建文失敗 → failed 紀錄消費 slot
    expect(await runScheduledSlot(slotKey, deps)).toBe("failed");
    expect(recorded).toContain("冇足夠可選商品");
    // 之後每 5 分鐘 tick：slot 已消費 → 唔再嘗試建文（唔洗版）
    expect(await runScheduledSlot(slotKey, deps)).toBe("exists");
    expect(await runScheduledSlot(slotKey, deps)).toBe("exists");
    expect(createAttempts).toBe(1);
  });
});

describe("只准人工產生", () => {
  it("自動建文已退役：舊 env 無論 unset／1／true 都一律閂", () => {
    delete process.env.GLO_GUIDE_AUTOMATION_ENABLED;
    expect(gloGuideAutomationEnabled()).toBe(false);
    process.env.GLO_GUIDE_AUTOMATION_ENABLED = "1";
    expect(gloGuideAutomationEnabled()).toBe(false);
    process.env.GLO_GUIDE_AUTOMATION_ENABLED = "true";
    expect(gloGuideAutomationEnabled()).toBe(false);
    delete process.env.GLO_GUIDE_AUTOMATION_ENABLED;
  });
  it("到期週一＋舊 env=true 都只 recovery；唔讀 DB、唔建文、唔記排程失敗", async () => {
    process.env.GLO_GUIDE_AUTOMATION_ENABLED = "true";
    schedulerRecovery.recover.mockClear();
    schedulerGuards.getDb.mockClear();
    schedulerGuards.generate.mockClear();
    schedulerGuards.recordFailed.mockClear();

    // 2026-11-16 01:00 UTC＝香港週一 09:00，舊邏輯本應到期。
    await gloGuideSchedulerTick(new Date("2026-11-16T01:00:00.000Z"));

    expect(schedulerRecovery.recover).toHaveBeenCalledTimes(1);
    expect(schedulerGuards.getDb).not.toHaveBeenCalled();
    expect(schedulerGuards.generate).not.toHaveBeenCalled();
    expect(schedulerGuards.recordFailed).not.toHaveBeenCalled();
    delete process.env.GLO_GUIDE_AUTOMATION_ENABLED;
  });
  it("自動 slot 閂咗都照啟動手動 job recovery loop", async () => {
    delete process.env.GLO_GUIDE_AUTOMATION_ENABLED;
    schedulerRecovery.recover.mockClear();
    startGloGuideScheduler();
    expect(schedulerRecovery.recover).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
  });
  it("slot 鐘點：預設 9；合法 0–23 先用 env", () => {
    delete process.env.GLO_GUIDE_SCHEDULE_HOUR;
    expect(gloGuideSlotHour()).toBe(9);
    process.env.GLO_GUIDE_SCHEDULE_HOUR = "10";
    expect(gloGuideSlotHour()).toBe(10);
    process.env.GLO_GUIDE_SCHEDULE_HOUR = "99";
    expect(gloGuideSlotHour()).toBe(9);
    process.env.GLO_GUIDE_SCHEDULE_HOUR = "abc";
    expect(gloGuideSlotHour()).toBe(9);
    delete process.env.GLO_GUIDE_SCHEDULE_HOUR;
  });
});

describe("scheduler 接線 source guard（防回歸）", () => {
  const src = readFileSync(path.join(__dirname, "gloGuideScheduler.ts"), "utf8");
  it("tick 用 advisory lock＋existing 檢查＋slotKey 傳入 generateArticle", () => {
    expect(src).toContain("withGloGuideLock(slotKey");
    expect(src).toContain("shouldCreateScheduledArticle(");
    expect(src).toContain('source: "auto"');
    expect(src).toContain('jobKind: "scheduled"');
    expect(src).toContain("idempotencyKey: slotKey");
  });
});
