/**
 * WMS 推送 AI 內容（description＋aiTags）共用純邏輯（2026-11 合約 v2）：
 *
 * 合約摘要：
 *   item 可帶 description:string（≤500 字，空字串＝清 AI 描述）、
 *             aiTags:string[]（≤5 個，每個 ≤12 字，空 array 得）、
 *             aiContentApproved:true；
 *   batch.reviewedBy 非空先有資格送 AI 內容。
 *   只要 description 或 aiTags 欄存在，就必須 approved===true 兼 reviewedBy 非空；
 *   未帶呢三件嘅舊批完全向後相容。
 *
 * 清理規則：NFC normalize＋剝控制字元；**唔做 HTML escape 入 DB**（輸出端先 escape）。
 * 呢度全部係純函數，唔掂 DB——wmsListing（寫入閘）、productsRouter（公開 DTO）、
 * og.ts（首口重點）共用同一份規則，測試可以直接抽嚟驗。
 */

export const AI_DESCRIPTION_MAX = 500;
export const AI_TAG_MAX_COUNT = 5;
export const AI_TAG_MAX_LEN = 12;

/** 控制字元：C0（\u0000–\u001F）＋DEL＋C1（\u007F–\u009F）。描述保留 \n／\t，tag 全剝。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const CONTROL_CHARS_STRICT = /[\u0000-\u001F\u007F-\u009F]/g;

/** NFC＋剝控制字元＋trim。唔做 HTML escape——DB 存原文，& < > 留返原樣。 */
export function sanitizeAiDescription(value: string): string {
  return value.normalize("NFC").replace(CONTROL_CHARS, "").trim();
}

export function sanitizeAiTag(value: string): string {
  return value.normalize("NFC").replace(CONTROL_CHARS_STRICT, "").trim();
}

/** 校驗 AI 描述（已清理後計長度）；合格返 null，唔合格返錯誤字串。空字串合法（清描述用）。 */
export function validateAiDescription(value: unknown): string | null {
  if (typeof value !== "string") return "商品描述要係字串";
  if (sanitizeAiDescription(value).length > AI_DESCRIPTION_MAX) {
    return `商品描述最長 ${AI_DESCRIPTION_MAX} 字`;
  }
  return null;
}

/** 校驗 重點標籤；合格返 null。空 array 合法；超長／非字串／清理後變空嘅 tag 一律拒絕。 */
export function validateAiTags(value: unknown): string | null {
  if (!Array.isArray(value)) return "重點標籤要係 array";
  if (value.length > AI_TAG_MAX_COUNT) return `重點標籤最多 ${AI_TAG_MAX_COUNT} 個`;
  for (const tag of value) {
    if (typeof tag !== "string") return "重點標籤逐個都要係字串";
    const clean = sanitizeAiTag(tag);
    if (!clean) return "重點標籤唔可以係空字串";
    if (clean.length > AI_TAG_MAX_LEN) return `重點標籤每個最長 ${AI_TAG_MAX_LEN} 字`;
  }
  return null;
}

/** 件貨有冇帶 AI 內容欄（欄存在就算，空字串／空 array 都計） */
export function itemCarriesAiContent(it: { description?: unknown; aiTags?: unknown }): boolean {
  return it.description !== undefined || it.aiTags !== undefined;
}

/**
 * AI 內容批准閘：有帶 description／aiTags 就一定要 aiContentApproved===true
 * 兼批次 reviewedBy 非空；未帶任何 AI 欄嘅舊批完全放行（向後相容）。
 */
export function aiContentGateError(
  it: { description?: unknown; aiTags?: unknown; aiContentApproved?: unknown },
  reviewedBy: unknown,
): string | null {
  if (!itemCarriesAiContent(it)) return null;
  if (it.aiContentApproved !== true) return "帶 AI 內容（description／aiTags）一定要 aiContentApproved=true";
  if (typeof reviewedBy !== "string" || !reviewedBy.trim()) {
    return "帶 AI 內容嘅批次一定要 reviewedBy（審批人）";
  }
  return null;
}

/** 已過閘嘅 tags → 寫 DB 用嘅 JSON array 字串（清理後；假設 validateAiTags 已通過） */
export function aiTagsToJson(value: string[]): string {
  return JSON.stringify(value.map((tag) => sanitizeAiTag(tag)));
}

/**
 * 公開輸出用：parse DB 入面嘅 aiTags JSON；壞 JSON／非 array／壞 tag 一律當冇。
 * 唔會 throw——公開路徑（products.list/latest/byId、og.ts）絕對唔可以因壞資料炸。
 */
export function parseAiTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const tag of parsed) {
      if (typeof tag !== "string") continue;
      const clean = sanitizeAiTag(tag);
      if (!clean || clean.length > AI_TAG_MAX_LEN) continue;
      out.push(clean);
      if (out.length >= AI_TAG_MAX_COUNT) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** 公開 DTO 唯一入口：後台停用（aiTagsEnabled=false）就永遠回 []，內容存在都唔出。 */
export function publicAiTags(raw: string | null | undefined, enabled: boolean): string[] {
  return enabled ? parseAiTags(raw) : [];
}
