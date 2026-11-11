/**
 * v2026.11.11.2（老闆指令）：對外抽獎公告「總開關」——成個對外公告功能一掣收埋，
 * 只保留獨立查劵 link／查劵 API。
 *
 * 設計要点：
 * - 持久化用現有 siteSettings（key＝LUCKY_ANNOUNCEMENT_PUBLIC_SETTING_KEY），唔使新 DB migration。
 * - **預設關閉**：設定行唔存在／值唔係 "true" 一律當關閉（用戶 2026-11-11 明確要關）；
 *   日後管理員喺後台「直播抽獎 → 抽獎劵活動（開獎舞台）」明確開啟先恢復。
 * - 對外可見＝總開關開 AND 該場 winnersPublic=true（每場開關照舊各自把關，
 *   luckyAnnouncementVisible 係兩層規則嘅唯一組合入口）。
 * - 關閉時一刀切：publicEvents 空陣列、publicEventResults NOT_FOUND（唔執行 winner query）、
 *   首口 HTML（luckyEventSeo）唔注入活動／公告內容、sitemap 唔列 /lucky-results*；
 *   查劵路徑（publicTicketEvent／publicLookupEventTicket／/lucky-tickets/:id）完全唔經呢度。
 * - 讀取有 60 秒 in-memory TTL（同 vip/airwallex 同款）；後台 adminSetAnnouncementPublic
 *   寫入後即時 resetLuckyAnnouncementPublicCache()，同一 process 即刻生效。
 * - DB 讀取失敗會 throw（唔好靜默當開／當關）：公開 API 由 tRPC 變 500（零資料外洩）、
 *   首口 HTML 由 vite.ts 回中性 503＋noindex（唔出公告宣傳，亦唔虛構已關閉）、
 *   sitemap caller 自行 catch 當關閉（fail-closed，鐵律唔准 500）。
 */
import { eq } from "drizzle-orm";
import { siteSettings } from "@db/schema";
import { getDb } from "../queries/connection";

export const LUCKY_ANNOUNCEMENT_PUBLIC_SETTING_KEY = "lucky_announcement_public";

const CACHE_TTL_MS = 60_000;
let cache: { at: number; enabled: boolean } | null = null;

/** 後台切換後即時調用（同一 process 即時生效；TTL 只係兜底）。 */
export function resetLuckyAnnouncementPublicCache(): void {
  cache = null;
}

/** 總開關而家係咪開：只有 siteSettings 真係存在兼 value.trim()==="true" 先算開。
 *  設定唔存在／垃圾值 → false（預設關閉）。DB 出錯會 throw（見檔頭說明）。 */
export async function isLuckyAnnouncementPublic(): Promise<boolean> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.enabled;
  const row = await getDb().query.siteSettings.findFirst({
    where: eq(siteSettings.key, LUCKY_ANNOUNCEMENT_PUBLIC_SETTING_KEY),
  });
  const enabled = row?.value?.trim() === "true";
  cache = { at: Date.now(), enabled };
  return enabled;
}

/** 兩層規則唯一組合入口：對外可見＝總開關開 AND 該場公告公開（winnersPublic）。 */
export function luckyAnnouncementVisible(announcementPublic: boolean, winnersPublic: boolean): boolean {
  return announcementPublic && winnersPublic;
}

/** 後台寫入（adminSetAnnouncementPublic 用）：upsert siteSettings＋即時 reset 快取。 */
export async function setLuckyAnnouncementPublic(enabled: boolean): Promise<void> {
  const db = getDb();
  const value = enabled ? "true" : "false";
  await db
    .insert(siteSettings)
    .values({ key: LUCKY_ANNOUNCEMENT_PUBLIC_SETTING_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: siteSettings.key,
      set: { value, updatedAt: new Date() },
    });
  resetLuckyAnnouncementPublicCache();
}
