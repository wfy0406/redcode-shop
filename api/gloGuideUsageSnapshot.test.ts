/**
 * gloGuideJob 建立路徑嘅成本 snapshot 測試（唔掂真 DB）：
 * ─ createGloGuideJob：caller 傳 snapshot 就用caller嘅；唔傳就即場讀 siteSettings
 *   （讀取失敗照抛真錯誤，唔會當免費）；snapshot merge 入 payload 內部欄；
 * ─ recordFailedScheduledSlot：未開始 provider 嘅失敗明確 snapshot 0＋costNotStarted；
 * ─ source guard：service generate/regenerate/generateImages 三條路徑都傳 costSnapshot；
 *   orchestrator runFullJob child insert 有 mergeCostSnapshotPayload＋一次過讀單價。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── fake DB：捕捉 insert values；settings select 回固定行 ──
const h = vi.hoisted(() => {
  const state = {
    jobInserts: [] as Record<string, unknown>[],
    articleInserts: [] as Record<string, unknown>[],
    settingsValue: null as string | null,
    failSettings: null as Error | null,
  };
  function settingsChain() {
    const rows = state.settingsValue === null ? [] : [{ value: state.settingsValue }];
    const p = Promise.resolve(rows);
    const node: Record<string, unknown> = {
      from: () => node,
      where: () => node,
      limit: () => {
        if (state.failSettings) return Promise.reject(state.failSettings);
        return p;
      },
      then: p.then.bind(p),
      catch: p.catch.bind(p),
    };
    return node;
  }
  const insert = () => ({
    values: (v: Record<string, unknown>) => {
      if ("kind" in v && "idempotencyKey" in v) state.jobInserts.push(v);
      else state.articleInserts.push(v);
      return { returning: () => Promise.resolve([{ id: 99, publicId: "pub-99", ...v }]) };
    },
  });
  const db = {
    insert,
    transaction: async (fn: (tx: { insert: typeof insert }) => Promise<unknown>) => fn({ insert }),
    select: (selection?: Record<string, unknown>) => {
      if (selection && "value" in selection) return settingsChain();
      return settingsChain();
    },
    query: { gloGuideJobs: { findFirst: async () => null } },
  };
  return { state, db };
});

vi.mock("./queries/connection", () => ({ getDb: () => h.db }));
vi.mock("./audit", () => ({ logAudit: vi.fn(async () => undefined) }));

import { createGloGuideJob, recordFailedScheduledSlot } from "./gloGuideService";

beforeEach(() => {
  h.state.jobInserts = [];
  h.state.articleInserts = [];
  h.state.settingsValue = null;
  h.state.failSettings = null;
});

describe("createGloGuideJob 成本 snapshot", () => {
  it("caller 傳 snapshot → payload 寫 snapshot（唔再讀 settings）", async () => {
    h.state.settingsValue = '{"imageCostCents":999}'; // 若真係再讀就會用呢個
    await createGloGuideJob({
      articleId: 1,
      kind: "image",
      idempotencyKey: "k1",
      payload: { requestedBy: "小明" },
      costSnapshot: { estimatedCostCents: 30 },
    });
    expect(h.state.jobInserts[0]?.payload).toEqual({ requestedBy: "小明", estimatedCostCents: 30 });
  });
  it("唔傳 snapshot → 即場讀 settings；image 用 imageCostCents、article/full 用 textCostCents", async () => {
    h.state.settingsValue = '{"imageCostCents":30,"textCostCents":120}';
    await createGloGuideJob({ articleId: 1, kind: "image", idempotencyKey: "k2" });
    await createGloGuideJob({ articleId: 1, kind: "article", idempotencyKey: "k3" });
    await createGloGuideJob({ articleId: 1, kind: "full", idempotencyKey: "k4" });
    await createGloGuideJob({ articleId: 1, kind: "scheduled", idempotencyKey: "k5" });
    expect(h.state.jobInserts.map((j) => (j.payload as Record<string, unknown>).estimatedCostCents)).toEqual([
      30, 120, 120, 120,
    ]);
  });
  it("單價未設定 → snapshot 明確寫 null（未知），唔會寫 0 扮免費", async () => {
    h.state.settingsValue = null;
    await createGloGuideJob({ articleId: 1, kind: "image", idempotencyKey: "k6" });
    expect(h.state.jobInserts[0]?.payload).toEqual({ estimatedCostCents: null });
  });
  it("settings 讀取失敗 → 照抛真錯誤，job 唔會建立", async () => {
    h.state.failSettings = new Error("db down");
    await expect(
      createGloGuideJob({ articleId: 1, kind: "image", idempotencyKey: "k7" }),
    ).rejects.toThrow("db down");
    expect(h.state.jobInserts).toHaveLength(0);
  });
});

describe("recordFailedScheduledSlot（未開始 provider）", () => {
  it("明確 snapshot 0＋costNotStarted，唔使讀單價，唔當有生成成本", async () => {
    h.state.failSettings = new Error("唔應該讀 settings");
    await recordFailedScheduledSlot("sched:2026-06-15", "本週可選貨唔夠");
    expect(h.state.jobInserts).toHaveLength(1);
    expect(h.state.jobInserts[0]).toMatchObject({
      kind: "scheduled",
      status: "failed",
      idempotencyKey: "sched:2026-06-15",
      payload: { estimatedCostCents: 0, costNotStarted: true },
    });
  });
});

describe("source guard：所有 job 建立路徑都有 snapshot", () => {
  const serviceSrc = readFileSync(path.join(__dirname, "gloGuideService.ts"), "utf8");
  const orchestratorSrc = readFileSync(path.join(__dirname, "gloGuideOrchestrator.ts"), "utf8");

  it("service：generateArticle／regenerateArticle／generateImages 三條路徑都傳 costSnapshot", () => {
    // generateArticle 一次讀取（slug 重試共用）＋傳入 createGloGuideJob
    expect(serviceSrc).toContain("gloGuideJobCostSnapshot(jobParams.jobKind, await getGloGuideUsageSettings())");
    // regenerate（article）＋generateImages（image）都明確傳快照
    expect(serviceSrc).toContain('gloGuideJobCostSnapshot("article", await getGloGuideUsageSettings())');
    expect(serviceSrc).toContain('gloGuideJobCostSnapshot("image", await getGloGuideUsageSettings())');
    // 三個 createGloGuideJob 呼叫點都有 costSnapshot
    const calls = serviceSrc.match(/createGloGuideJob\(\s*\{[\s\S]*?\},\s*(?:tx|)\s*,?\s*\)/g) ?? [];
    const withSnapshot = serviceSrc.match(/costSnapshot/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(withSnapshot.length).toBeGreaterThanOrEqual(3);
  });

  it("orchestrator：runFullJob child image insert 有 snapshot，而且一批 child 共用一次單價讀取", () => {
    const runFull = orchestratorSrc.slice(
      orchestratorSrc.indexOf("async function runFullJob"),
      orchestratorSrc.indexOf("// ──────────────────────────── 入口"),
    );
    expect(runFull).toContain('gloGuideJobCostSnapshot("image", await getGloGuideUsageSettings())');
    expect(runFull).toContain("mergeCostSnapshotPayload({ parentJob: job.publicId }, imageCostSnapshot)");
    // 一次讀取：runFullJob 入面 getGloGuideUsageSettings 只出現一次（loop 外）
    expect(runFull.match(/getGloGuideUsageSettings\(\)/g)).toHaveLength(1);
  });

  it("orchestrator 仲有第二個 image job insert 路徑（recovery）唔建新 job——只有 runFullJob insert gloGuideJobs", () => {
    const inserts = orchestratorSrc.match(/insert\(gloGuideJobs\)/g) ?? [];
    expect(inserts).toHaveLength(1); // 唯一 insert 已喺上個 test 驗咗有 snapshot
  });
});
