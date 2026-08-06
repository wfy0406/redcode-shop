/**
 * RedCode 官網 → Red Code WMS 會員同步（B-2 做法 A，2026-08-06 跟 WMS《官網→WMS對接需求》）
 *
 * 會員註冊／資料更新（自己改資料、員工後台改、促銷同意變更）時，
 * fire-and-forget POST 去 WMS `order.receiveMember`
 * （tRPC HTTP：body 包 { json: { apiKey, ... } }；同訂單 webhook 同一条 API key）。
 * WMS 用 phone 做 key upsert（有就更新、冇就新增）。
 *
 * 注意：
 * - 失敗淨係 log，唔阻註冊／更新（同訂單 forward 一樣 best-effort）。
 * - Google 開戶嘅會員 phone 係 `g-xxx` 佔位 → 唔推（WMS 用電話做 key，佔位冇意思）；
 *   等佢哋 updateProfile 補返真電話嗰次自然會推。
 * - Env 同 wmsSync 共用：WMS_API_KEY／WMS_BASE_URL；WMS_SYNC_DISABLED=1 一樣停埋呢度。
 */
import { eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { siteSettings, users } from "@db/schema";

const MEMBER_SYNC_TIMEOUT_MS = 30_000; // 會員同步冇截圖 base64，30s 夠（WMS 冷啟動都頂得順）

function wmsBaseUrl(): string {
  return (process.env.WMS_BASE_URL || "https://red-code-wms.onrender.com").replace(/\/$/, "");
}

/** HKT（UTC+8）YYYY-MM-DD（同 wmsSync 嘅 hktDate 一致） */
function hktDate(d: Date): string {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 推送一個會員去 WMS。
 * 用法（fire-and-forget）：void forwardMemberToWms(userId).catch((e) => console.error(...));
 */
export async function forwardMemberToWms(userId: number): Promise<void> {
  if (!process.env.WMS_API_KEY || process.env.WMS_SYNC_DISABLED === "1") return;
  const db = getDb();
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || user.role !== "member") return;
  // Google 開戶佔位電話（g-xxx）唔推——WMS 用電話做 key，補咗真電話先有意義
  if (user.phone.startsWith("g-")) return;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MEMBER_SYNC_TIMEOUT_MS);
  try {
    // 可選欄位（email/age）有先送：WMS 個 zod schema 係 optional 但唔接受 null，
    // 送 null 會俾佢擋（2026-08-06 Render log 實測 "Invalid input: expected string, received null"）
    const payload: Record<string, unknown> = {
      apiKey: process.env.WMS_API_KEY,
      phone: user.phone,
      name: user.name,
      registeredAt: hktDate(user.createdAt),
      marketingOptIn: user.marketingOptIn ?? false,
    };
    if (user.email) payload.email = user.email;
    if (user.age != null) payload.age = user.age;
    const resp = await fetch(`${wmsBaseUrl()}/api/trpc/order.receiveMember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: payload }),
      signal: ctrl.signal,
    });
    const data = (await resp.json().catch(() => null)) as {
      error?: { json?: { message?: string } };
    } | null;
    const errMsg = data?.error?.json?.message;
    if (errMsg || !resp.ok) {
      console.error(`[wms] 會員同步失敗（user ${userId}）:`, errMsg ?? `HTTP ${resp.status}`);
    }
  } catch (e) {
    console.error(
      `[wms] 會員同步出錯（user ${userId}）:`,
      e instanceof Error && e.name === "AbortError" ? `timeout ${MEMBER_SYNC_TIMEOUT_MS / 1000}s` : e,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 初次接駁一次性回填（2026-08-06 WMS 建議：現有會員逐個 call 一次，phone upsert 唔會重複）。
 * Server 開機時跑：siteSettings 有 wmsMemberBackfillV2At 旗標 → 做過就 skip；
 * 冇就將全部 role=member 會員逐個推落 WMS，做完落旗標。
 * 推嘅邏輯共用 forwardMemberToWms（自動 skip g- 佔位電話；失敗淨 log 唔阻下一個），
 * 所以成個回填係 best-effort＋idempotent，就算中途冧，下次開機會再試晒全部（upsert 唔怕重複）。
 */
export async function backfillMembersToWmsOnce(): Promise<void> {
  if (!process.env.WMS_API_KEY || process.env.WMS_SYNC_DISABLED === "1") return;
  const db = getDb();
  // 旗標 v2（2026-08-06）：舊版回填過一次，但嗰版 payload 會送 null email/age，
  // 被 WMS zod 擋咗一批；改咗 payload 之後要用新旗標再回填一次，補返嗰批失敗嘅會員
  const done = await db.query.siteSettings.findFirst({
    where: eq(siteSettings.key, "wmsMemberBackfillV2At"),
  });
  if (done) return; // 已經回填過，開機直接 skip
  const members = await db.query.users.findMany({
    where: eq(users.role, "member"),
    columns: { id: true },
  });
  console.log(`[wms] 會員初次回填開始：共 ${members.length} 位`);
  let count = 0;
  for (const m of members) {
    await forwardMemberToWms(m.id);
    count++;
    // 每 20 位抖半秒，唔好一次過打晒落 WMS（佢免費 plan 冷啟動會慢）
    if (count % 20 === 0) {
      console.log(`[wms] 會員回填進度：${count}/${members.length}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await db
    .insert(siteSettings)
    .values({ key: "wmsMemberBackfillV2At", value: new Date().toISOString() })
    .onConflictDoNothing();
  console.log(`[wms] 會員初次回填完成：${count} 位已推（失敗嘅睇上面 log）`);
}
