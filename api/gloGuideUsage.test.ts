/**
 * gloGuideUsage 測試：
 * ─ settings parse：預設 null（未知）、0＝明確免費、壞資料／超上限／非整數 → null，絕對唔估價；
 * ─ job kind mapping：full/scheduled→完整文章（文字價）、article→文字重生（文字價）、image→配搭圖（圖價）；
 * ─ snapshot merge／extract：寫落 payload 嘅係建立當刻嘅價，之後改單價唔影響；
 * ─ 香港時間（固定 UTC+8）年界／月界：唔依賴主機時區；
 * ─ 彙總：各狀態 total/completed/failed/active、active 成本入 reserved、已結束入 finished、
 *   冇 snapshot → unknownCostJobs；deleted image 唔影響歷史 completed image job（彙總根本唔讀圖表）；
 * ─ DB 統計：recent 20 DTO 唔回 payload／秘密；成本嚟自 snapshot。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── fake DB：依次序回應 select（第一次＝今年區間 job 行；第二次＝recent join 行）──
const h = vi.hoisted(() => {
  const state = {
    selectResponses: [] as unknown[][],
    settingsValue: null as string | null,
    saved: [] as { key: string; value: string }[],
  };
  function chain(rows: unknown[]) {
    const p = Promise.resolve(rows);
    const node: Record<string, unknown> = {
      from: () => node,
      where: () => node,
      leftJoin: () => node,
      orderBy: () => node,
      limit: () => p,
      then: p.then.bind(p),
      catch: p.catch.bind(p),
    };
    return node;
  }
  const db = {
    select: (selection?: Record<string, unknown>) => {
      // siteSettings 讀取：select({ value })
      if (selection && "value" in selection) {
        return chain(state.settingsValue === null ? [] : [{ value: state.settingsValue }]);
      }
      return chain(state.selectResponses.shift() ?? []);
    },
    insert: () => ({
      values: (v: { key: string; value: string }) => ({
        onConflictDoUpdate: () => {
          state.saved.push(v);
          return Promise.resolve();
        },
      }),
    }),
  };
  return { state, db };
});

vi.mock("./queries/connection", () => ({ getDb: () => h.db }));

import {
  aggregateGloGuideUsage,
  emptyUsagePeriodBucket,
  estimatedCostForKind,
  extractEstimatedCostCents,
  getGloGuideUsageSettings,
  getGloGuideUsageStats,
  gloGuideJobCostSnapshot,
  gloGuideJobUsageCategory,
  hkPeriodsFor,
  hkYmdFor,
  mergeCostSnapshotPayload,
  notStartedCostSnapshot,
  parseGloGuideUsageSettings,
  saveGloGuideUsageSettings,
  snapshotGloGuideJobCost,
  GLO_GUIDE_USAGE_MAX_CENTS,
  type GloGuideUsageJobRow,
} from "./gloGuideUsage";

beforeEach(() => {
  h.state.selectResponses = [];
  h.state.settingsValue = null;
  h.state.saved = [];
});

describe("settings parse（唔准估價）", () => {
  it("預設：兩樣都 null（未知），唔會默認用任何價錢", () => {
    expect(parseGloGuideUsageSettings(undefined)).toEqual({ imageCostCents: null, textCostCents: null });
    expect(parseGloGuideUsageSettings(null)).toEqual({ imageCostCents: null, textCostCents: null });
    expect(parseGloGuideUsageSettings("唔係 JSON")).toEqual({ imageCostCents: null, textCostCents: null });
    expect(parseGloGuideUsageSettings("{}")).toEqual({ imageCostCents: null, textCostCents: null });
  });
  it("0 係合法值（明確免費），同 null（未知）分得清", () => {
    const s = parseGloGuideUsageSettings('{"imageCostCents":0,"textCostCents":null}');
    expect(s.imageCostCents).toBe(0);
    expect(s.textCostCents).toBeNull();
  });
  it("壞資料：負數／小數／超上限／字串／陣列 → 全部 null，唔會靜默當免費", () => {
    expect(parseGloGuideUsageSettings('{"imageCostCents":-1}').imageCostCents).toBeNull();
    expect(parseGloGuideUsageSettings('{"imageCostCents":12.5}').imageCostCents).toBeNull();
    expect(
      parseGloGuideUsageSettings(`{"imageCostCents":${GLO_GUIDE_USAGE_MAX_CENTS + 1}}`).imageCostCents,
    ).toBeNull();
    expect(parseGloGuideUsageSettings('{"imageCostCents":"30"}').imageCostCents).toBeNull();
    expect(parseGloGuideUsageSettings('[1,2]')).toEqual({ imageCostCents: null, textCostCents: null });
    expect(
      parseGloGuideUsageSettings(`{"imageCostCents":${GLO_GUIDE_USAGE_MAX_CENTS}}`).imageCostCents,
    ).toBe(GLO_GUIDE_USAGE_MAX_CENTS);
  });
  it("getGloGuideUsageSettings：冇行 → 全 null；有 → parse；save 寫 JSON upsert", async () => {
    expect(await getGloGuideUsageSettings()).toEqual({ imageCostCents: null, textCostCents: null });
    h.state.settingsValue = '{"imageCostCents":30,"textCostCents":120}';
    expect(await getGloGuideUsageSettings()).toEqual({ imageCostCents: 30, textCostCents: 120 });
    await saveGloGuideUsageSettings({ imageCostCents: 0, textCostCents: null });
    expect(h.state.saved).toHaveLength(1);
    expect(h.state.saved[0]).toMatchObject({
      key: "glo_guide_usage_rules",
      value: '{"imageCostCents":0,"textCostCents":null}',
    });
  });
});

describe("job kind mapping", () => {
  it("full/scheduled→完整文章（文字價）；article→文字重生（文字價）；image→配搭圖（圖價）；未知 kind→null", () => {
    expect(gloGuideJobUsageCategory("full")).toBe("article");
    expect(gloGuideJobUsageCategory("scheduled")).toBe("article");
    expect(gloGuideJobUsageCategory("article")).toBe("regenerate");
    expect(gloGuideJobUsageCategory("image")).toBe("image");
    expect(gloGuideJobUsageCategory("mystery")).toBeNull();
    const s = { imageCostCents: 30, textCostCents: 120 };
    expect(estimatedCostForKind("full", s)).toBe(120);
    expect(estimatedCostForKind("scheduled", s)).toBe(120);
    expect(estimatedCostForKind("article", s)).toBe(120);
    expect(estimatedCostForKind("image", s)).toBe(30);
    expect(estimatedCostForKind("mystery", s)).toBeNull();
  });
  it("單價未設定 → snapshot 係 null（未知），唔會當 0", () => {
    expect(gloGuideJobCostSnapshot("image", { imageCostCents: null, textCostCents: null })).toEqual({
      estimatedCostCents: null,
    });
    expect(notStartedCostSnapshot()).toEqual({ estimatedCostCents: 0, notStarted: true });
  });
  it("snapshotGloGuideJobCost：讀取失敗照抛真錯誤，唔准靜默當免費", async () => {
    h.state.settingsValue = null;
    const snap = await snapshotGloGuideJobCost("article");
    expect(snap).toEqual({ estimatedCostCents: null });
    const db = h.db;
    const boom = new Error("settings read failed");
    vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw boom;
    });
    await expect(snapshotGloGuideJobCost("image")).rejects.toThrow("settings read failed");
  });
});

describe("snapshot payload（歷史唔受改價影響）", () => {
  it("merge 保留原有欄位＋永遠寫 estimatedCostCents；notStarted 加標記", () => {
    expect(mergeCostSnapshotPayload({ requestedBy: "小明" }, { estimatedCostCents: 30 })).toEqual({
      requestedBy: "小明",
      estimatedCostCents: 30,
    });
    expect(mergeCostSnapshotPayload(null, { estimatedCostCents: null })).toEqual({
      estimatedCostCents: null,
    });
    expect(mergeCostSnapshotPayload(null, notStartedCostSnapshot())).toEqual({
      estimatedCostCents: 0,
      costNotStarted: true,
    });
  });
  it("extract：冇 snapshot／壞 payload → null（成本未知，唔准回填現價）", () => {
    expect(extractEstimatedCostCents(null)).toBeNull();
    expect(extractEstimatedCostCents({})).toBeNull();
    expect(extractEstimatedCostCents({ estimatedCostCents: "30" })).toBeNull();
    expect(extractEstimatedCostCents({ estimatedCostCents: -5 })).toBeNull();
    expect(extractEstimatedCostCents({ estimatedCostCents: 0 })).toBe(0);
    expect(extractEstimatedCostCents({ estimatedCostCents: 45 })).toBe(45);
  });
  it("snapshot 係建立當刻嘅價：之後改單價，彙總照用舊 snapshot", () => {
    // 同一類工作：舊 job snapshot 30，新 job snapshot 80——兩個各自計，唔會統一用現價
    const now = new Date("2026-06-15T04:00:00Z"); // HK 2026-06-15 12:00
    const rows: GloGuideUsageJobRow[] = [
      { kind: "image", status: "completed", createdAt: new Date("2026-06-10T04:00:00Z"), estimatedCostCents: 30 },
      { kind: "image", status: "completed", createdAt: new Date("2026-06-12T04:00:00Z"), estimatedCostCents: 80 },
    ];
    const agg = aggregateGloGuideUsage(rows, now);
    expect(agg.month.image.finishedCostCents).toBe(110);
    expect(agg.month.image.unknownCostJobs).toBe(0);
  });
});

describe("香港時間週期（UTC+8，唔依賴主機時區）", () => {
  it("hkYmdFor：UTC 16:00 界——2025-12-31T16:00Z 已係香港 2026-01-01", () => {
    expect(hkYmdFor(new Date("2025-12-31T15:59:59Z"))).toEqual({
      date: "2025-12-31",
      month: "2025-12",
      year: "2025",
    });
    expect(hkYmdFor(new Date("2025-12-31T16:00:00Z"))).toEqual({
      date: "2026-01-01",
      month: "2026-01",
      year: "2026",
    });
  });
  it("hkPeriodsFor：yearStartUtc＝香港今年 1 月 1 日 00:00（UTC 舊年 12-31 16:00）", () => {
    const p = hkPeriodsFor(new Date("2026-06-15T04:00:00Z"));
    expect(p).toMatchObject({ date: "2026-06-15", month: "2026-06", year: "2026" });
    expect(p.yearStartUtc.toISOString()).toBe("2025-12-31T16:00:00.000Z");
  });
  it("年界：香港除夕 23:59 vs 元旦 00:01 分屬唔同年桶", () => {
    const now = new Date("2026-01-01T16:01:00Z"); // HK 2026-01-02 00:01
    const rows: GloGuideUsageJobRow[] = [
      // HK 2025-12-31 23:59 → 舊年
      { kind: "image", status: "completed", createdAt: new Date("2025-12-31T15:59:00Z"), estimatedCostCents: 10 },
      // HK 2026-01-01 00:01 → 今年今日（相對 now 係噚日）→ 年＋月，唔係今日
      { kind: "image", status: "completed", createdAt: new Date("2025-12-31T16:01:00Z"), estimatedCostCents: 20 },
    ];
    const agg = aggregateGloGuideUsage(rows, now);
    expect(agg.year.image.total).toBe(1); // 2026 嗰個先算今年
    expect(agg.year.image.finishedCostCents).toBe(20);
    expect(agg.month.image.total).toBe(1);
    expect(agg.today.image.total).toBe(0); // 兩個都唔係 1 月 2 日
  });
  it("月界：香港 1 月 31 日 24:00（＝2-01 00:00）之後先入今月", () => {
    const now = new Date("2026-02-01T16:30:00Z"); // HK 2026-02-02 00:30
    const rows: GloGuideUsageJobRow[] = [
      { kind: "article", status: "completed", createdAt: new Date("2026-01-31T15:59:59Z"), estimatedCostCents: 5 }, // HK 1-31
      { kind: "article", status: "completed", createdAt: new Date("2026-01-31T16:00:00Z"), estimatedCostCents: 7 }, // HK 2-01
    ];
    const agg = aggregateGloGuideUsage(rows, now);
    expect(agg.year.regenerate.total).toBe(2); // 同年
    expect(agg.month.regenerate.total).toBe(1); // 得 2 月嗰個
    expect(agg.month.regenerate.finishedCostCents).toBe(7);
  });
});

describe("彙總：狀態／reserved vs finished／unknown", () => {
  const now = new Date("2026-06-15T04:00:00Z"); // HK 2026-06-15 12:00
  const day = (iso: string) => new Date(iso);
  it("queued/submitted/processing → active＋reserved；completed/failed → finished；冇 snapshot → unknown", () => {
    const rows: GloGuideUsageJobRow[] = [
      { kind: "full", status: "completed", createdAt: day("2026-06-15T01:00:00Z"), estimatedCostCents: 120 },
      { kind: "scheduled", status: "failed", createdAt: day("2026-06-15T02:00:00Z"), estimatedCostCents: 120 },
      { kind: "article", status: "processing", createdAt: day("2026-06-15T03:00:00Z"), estimatedCostCents: 120 },
      { kind: "image", status: "queued", createdAt: day("2026-06-15T03:10:00Z"), estimatedCostCents: 30 },
      { kind: "image", status: "submitted", createdAt: day("2026-06-15T03:20:00Z"), estimatedCostCents: 30 },
      { kind: "image", status: "processing", createdAt: day("2026-06-15T03:30:00Z"), estimatedCostCents: 30 },
      { kind: "image", status: "completed", createdAt: day("2026-06-15T03:40:00Z"), estimatedCostCents: 30 },
      { kind: "image", status: "failed", createdAt: day("2026-06-15T03:50:00Z"), estimatedCostCents: null }, // 舊 job 冇 snapshot
      // 未開始 provider 嘅排程失敗：snapshot 0＋notStarted → 已知 0，唔係未知
      { kind: "scheduled", status: "failed", createdAt: day("2026-06-15T04:30:00Z"), estimatedCostCents: 0 },
      { kind: "mystery", status: "completed", createdAt: day("2026-06-15T05:00:00Z"), estimatedCostCents: 999 }, // 未知 kind 唔入統計
    ];
    const agg = aggregateGloGuideUsage(rows, now);
    expect(agg.today.article).toMatchObject({
      total: 3,
      completed: 1,
      failed: 2,
      active: 0,
      finishedCostCents: 240, // 120＋120＋0
      reservedCostCents: 0,
      unknownCostJobs: 0,
    });
    expect(agg.today.regenerate).toMatchObject({
      total: 1,
      active: 1,
      finishedCostCents: 0,
      reservedCostCents: 120,
      unknownCostJobs: 0,
    });
    expect(agg.today.image).toMatchObject({
      total: 5,
      completed: 1,
      failed: 1,
      active: 3,
      finishedCostCents: 30,
      reservedCostCents: 90,
      unknownCostJobs: 1, // 冇 snapshot 嘅 failed job
    });
    // active 工作冇 snapshot 一樣計 unknown
    const agg2 = aggregateGloGuideUsage(
      [{ kind: "image", status: "queued", createdAt: day("2026-06-15T06:00:00Z"), estimatedCostCents: null }],
      now,
    );
    expect(agg2.today.image).toMatchObject({ active: 1, reservedCostCents: 0, unknownCostJobs: 1 });
  });
  it("deleted image 唔影響歷史：彙總淨係讀 job 行，completed image job 永遠計入歷史生成量", () => {
    // 圖之後俾人刪咗，job 行仲喺度——歷史「曾經生成」照計
    const rows: GloGuideUsageJobRow[] = [
      { kind: "image", status: "completed", createdAt: day("2026-06-14T01:00:00Z"), estimatedCostCents: 30 },
      { kind: "image", status: "completed", createdAt: day("2026-06-14T02:00:00Z"), estimatedCostCents: 30 },
    ];
    const agg = aggregateGloGuideUsage(rows, now);
    expect(agg.year.image.completed).toBe(2);
    expect(agg.year.image.finishedCostCents).toBe(60);
  });
  it("空輸入 → 全部 0", () => {
    const agg = aggregateGloGuideUsage([], now);
    expect(agg.today).toEqual(emptyUsagePeriodBucket());
    expect(agg.month).toEqual(emptyUsagePeriodBucket());
    expect(agg.year).toEqual(emptyUsagePeriodBucket());
  });
});

describe("getGloGuideUsageStats（DB 層）", () => {
  it("job payload snapshot → 彙總；recent 20 DTO 唔回 payload，成本嚟自 snapshot", async () => {
    const now = new Date("2026-06-15T04:00:00Z");
    h.state.selectResponses = [
      // 第一條 select：今年區間 job 行
      [
        { kind: "full", status: "completed", createdAt: new Date("2026-06-15T01:00:00Z"), payload: { estimatedCostCents: 120, themeHint: "x" } },
        { kind: "image", status: "completed", createdAt: new Date("2026-06-15T02:00:00Z"), payload: null }, // 舊 job 冇 snapshot
        { kind: "image", status: "processing", createdAt: new Date("2026-06-15T03:00:00Z"), payload: { estimatedCostCents: 30, parentJob: "p" } },
      ],
      // 第二條 select：recent join 行
      [
        {
          publicId: "job-1",
          kind: "image",
          status: "failed",
          error: "PROVIDER_TIMEOUT: boom",
          payload: { estimatedCostCents: 30, parentJob: "secret-internal" },
          createdAt: new Date("2026-06-15T03:00:00Z"),
          articleTitle: "試題文章",
        },
      ],
    ];
    const stats = await getGloGuideUsageStats(now);
    expect(stats.periods.date).toBe("2026-06-15");
    expect(stats.today.article).toMatchObject({ total: 1, completed: 1, finishedCostCents: 120 });
    expect(stats.today.image).toMatchObject({
      total: 2,
      completed: 1,
      active: 1,
      finishedCostCents: 0,
      reservedCostCents: 30,
      unknownCostJobs: 1,
    });
    expect(stats.recentJobs).toEqual([
      {
        publicId: "job-1",
        kind: "image",
        status: "failed",
        articleTitle: "試題文章",
        error: "PROVIDER_TIMEOUT: boom",
        estimatedCostCents: 30,
        createdAt: "2026-06-15T03:00:00.000Z",
      },
    ]);
    // 冇 payload／parentJob 等內部欄位洩漏
    expect(JSON.stringify(stats.recentJobs)).not.toContain("parentJob");
    expect(JSON.stringify(stats.recentJobs)).not.toContain("secret-internal");
  });
  it("recent join 搵唔到文章 → articleTitle null，唔會炸", async () => {
    h.state.selectResponses = [
      [],
      [
        {
          publicId: "job-2",
          kind: "full",
          status: "queued",
          error: null,
          payload: null,
          createdAt: new Date("2026-06-15T03:00:00Z"),
          articleTitle: null,
        },
      ],
    ];
    const stats = await getGloGuideUsageStats(new Date("2026-06-15T04:00:00Z"));
    expect(stats.recentJobs[0]).toMatchObject({ articleTitle: null, estimatedCostCents: null, error: null });
  });
});
