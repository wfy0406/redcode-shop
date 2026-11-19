/**
 * Glo Glo 指南——2026-11-19 起只准人工按「產生」建文：
 * ─ 自動開新文章已停用；舊 GLO_GUIDE_AUTOMATION_ENABLED=true 亦唔可以再開。
 * ─ 每 5 分鐘檢查只恢復人工生成中斷／卡住嘅 job，唔會建立新文章。
 * ─ 舊 slot helper 保留作歷史兼容，但 production tick 會喺自動閘直接返回。
 */
import { eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { gloGuideJobs } from "@db/schema";
import {
  gloGuideSlotKey,
  hkParts,
  isGloGuideSlotDue,
} from "./gloGuideValidation";
import { generateArticle, recordFailedScheduledSlot } from "./gloGuideService";
import { recoverGloGuideJobs, withGloGuideLock } from "./gloGuideOrchestrator";
import { logAudit } from "./audit";

const TICK_MS = 5 * 60 * 1000;

/** 排程 slot 鐘點（0–23；預設 9＝香港 09:00） */
export function gloGuideSlotHour(): number {
  const raw = Number.parseInt(process.env.GLO_GUIDE_SCHEDULE_HOUR ?? "", 10);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 9;
}

export function gloGuideAutomationEnabled(): boolean {
  // 硬閘：無論舊 Render env 係咩值，都唔准自動開新文章；人工 generate 唔經呢個閘。
  return false;
}

/**
 * 同一 slot 嘅開文決策（純函數）：只要 DB 有呢個 slotKey 嘅 job
 * （queued/processing/completed/**failed** 都計）就唔再開——失敗留 DB 畀人睇，唔補跑、唔洗版。
 */
export function shouldCreateScheduledArticle(existingJob: { status: string } | null): boolean {
  return existingJob === null;
}

/** slot 執行依賴（tick 用真 DB；測試注入 in-memory fake 實跑同日重複＋失敗紀錄） */
export interface GloGuideSlotDeps {
  findJobByKey(key: string): Promise<{ status: string } | null>;
  createScheduledArticle(slotKey: string): Promise<void>;
  /** 建文前失敗都要落可見失敗紀錄＋消費 slot（M4b：唔准靜默洗版 retry） */
  recordFailedSlot(slotKey: string, error: string): Promise<void>;
}

/**
 * 跑一個 slot（可注入）：已有 job → "exists"（idempotent，同日重啟／重複 tick 唔會再開文）；
 * 冇 → 建 auto 文章＋scheduled job（idempotencyKey=slotKey 落 DB unique 雙保險）；
 * 建文失敗 → recordFailedSlot 落 failed 紀錄消費 slot，返 "failed"。
 */
export async function runScheduledSlot(
  slotKey: string,
  deps: GloGuideSlotDeps,
): Promise<"created" | "exists" | "failed"> {
  const existing = await deps.findJobByKey(slotKey);
  if (!shouldCreateScheduledArticle(existing)) return "exists";
  try {
    await deps.createScheduledArticle(slotKey);
    return "created";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[glo-guide] 排程建文失敗（slot ${slotKey}）:`, e);
    await deps.recordFailedSlot(slotKey, msg);
    return "failed";
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** 單次檢查（boot 同 interval 共用）：到期 slot → advisory lock 內建 auto 文章＋job；唔會 throw */
export async function gloGuideSchedulerTick(now: Date = new Date()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    // 先 recovery 卡住嘅 job（重開機／超時），再做 slot 檢查
    const recovered = await recoverGloGuideJobs().catch((e) => {
      console.error("[glo-guide] job recovery 失敗:", e);
      return null;
    });
    if (recovered && (recovered.requeued || recovered.resumed || recovered.failed)) {
      console.log(
        `[glo-guide] recovery：重 kick ${recovered.requeued}、resume ${recovered.resumed}、標 failed ${recovered.failed}`,
      );
    }

    // 手動生成嘅 job recovery 永遠要跑；自動開新 slot 已由硬閘永久停止。
    if (!gloGuideAutomationEnabled()) return;
    const parts = hkParts(now);
    if (!isGloGuideSlotDue(parts, gloGuideSlotHour())) return;
    const slotKey = gloGuideSlotKey(parts.ymd);
    const db = getDb();
    // advisory lock 擋多 instance；idempotencyKey unique 擋同日重跑（lock 入面再查一次）
    const ran = await withGloGuideLock(slotKey, () =>
      runScheduledSlot(slotKey, {
        findJobByKey: async (key) => {
          const existing = await db.query.gloGuideJobs.findFirst({
            where: eq(gloGuideJobs.idempotencyKey, key),
          });
          return existing ? { status: existing.status } : null;
        },
        // 系統 actor（auto 生成）；失敗會喺 generateArticle 抛，外層 catch 落 log
        createScheduledArticle: () =>
          generateArticle(
            { id: 0, name: "系統自動排程", role: "admin" },
            {},
            { source: "auto", jobKind: "scheduled", idempotencyKey: slotKey },
          ).then(() => undefined),
        // M4b：建文前失敗（例如本週可選貨<2）都要落 DB failed 紀錄消費 slot
        recordFailedSlot: (key, error) => recordFailedScheduledSlot(key, error),
      }),
    );
    if (ran === "created") {
      console.log(`[glo-guide] 排程生成已觸發（slot ${slotKey}）`);
      void logAudit({
        actorRole: "system",
        action: "gloGuide.scheduledGenerate",
        targetType: "gloGuideJob",
        targetId: slotKey,
        detail: `週一/週五自動排程觸發（${slotKey}）`,
      });
    }
  } catch (e) {
    // 失敗留 log；job 級失敗已由 orchestrator 落 DB
    console.error("[glo-guide] scheduler tick 失敗:", e);
  } finally {
    ticking = false;
  }
}

/** 開動每 5 分鐘人工 job recovery loop；自動開新文章已永久停用。 */
export function startGloGuideScheduler(): void {
  if (timer) return;
  console.log("[glo-guide] 只准人工產生；自動排程已停用，人工生成 job recovery 仍會每 5 分鐘運行");
  void gloGuideSchedulerTick();
  timer = setInterval(() => void gloGuideSchedulerTick(), TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}
