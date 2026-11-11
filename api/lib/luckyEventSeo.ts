import { and, desc, eq } from "drizzle-orm";
import { luckyDrawEvents } from "@db/schema";
import { getDb } from "../queries/connection";
import type { RouteMeta } from "./og";
import { isLuckyAnnouncementPublic, luckyAnnouncementVisible } from "./luckyAnnouncementVisibility";

export interface PublicLuckyEventSeo {
  id: number;
  name: string;
  scheduledDrawDate: string | null;
}

/* v2026.11.11.2：關閉專用首口 meta／無 JS 內容由主線 publicSeo.ts 嘅
 * LUCKY_ANNOUNCEMENT_CLOSED_SEO／injectLuckyAnnouncementClosedContent 提供（唔好喺度重複造字）。 */

/** v2026.11.11.2（老闆指令）：對外公告總開關關閉（或未明確開啟）時，首口 HTML 一律唔注入
 *  活動／公告內容——同未公開／唔存在一樣回 null（caller 出 noindex 404），唔查活動表。
 *  DB 錯誤（包括總開關讀取失敗）會 throw 交 caller 用中性 503＋noindex，唔好誤報 404 或出公告內容。 */
export async function getPublicLuckyEventSeo(eventId: number): Promise<PublicLuckyEventSeo | null> {
  if (!(await isLuckyAnnouncementPublic())) return null;
  const [event] = await getDb()
    .select({
      id: luckyDrawEvents.id,
      name: luckyDrawEvents.name,
      scheduledDrawDate: luckyDrawEvents.scheduledDrawDate,
    })
    .from(luckyDrawEvents)
    .where(and(eq(luckyDrawEvents.id, eventId), eq(luckyDrawEvents.winnersPublic, true)))
    .limit(1);
  return event ?? null;
}

/** 公告總頁首口內部連結：同 publicEvents 一樣只列 winnersPublic=true，最多 50 場。
 *  v2026.11.11.2：總開關關閉 → 空陣列（唔注入任何活動連結，唔查活動表）。 */
export async function listPublicLuckyEventSeo(limit = 50): Promise<PublicLuckyEventSeo[]> {
  if (!(await isLuckyAnnouncementPublic())) return [];
  const cap = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 50;
  return getDb()
    .select({
      id: luckyDrawEvents.id,
      name: luckyDrawEvents.name,
      scheduledDrawDate: luckyDrawEvents.scheduledDrawDate,
    })
    .from(luckyDrawEvents)
    .where(eq(luckyDrawEvents.winnersPublic, true))
    .orderBy(desc(luckyDrawEvents.id))
    .limit(cap);
}

/** 單場公告首口 SEO 可見性規則同 API 對齊：總開關開 AND 該場 winnersPublic。
 *  （vite.ts 透過上面兩個 gated 查詢套用呢條規則；呢個 export 主要畀測試鎖口径。） */
export function luckyEventSeoVisible(announcementPublic: boolean, winnersPublic: boolean): boolean {
  return luckyAnnouncementVisible(announcementPublic, winnersPublic);
}

export function luckyEventRouteMeta(event: PublicLuckyEventSeo): RouteMeta {
  return {
    title: `《${event.name}》中獎名單｜RedCode Fashion Design`,
    description: `RedCode《${event.name}》直播抽獎公告——查閱公開活動資料、預定抽獎日同已公佈嘅真實中獎結果。`,
    path: `/lucky-results/${event.id}`,
  };
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function drawDateLabel(value: string | null): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

/** 公告總頁唔再只有通用摘要：無 JS 都可以見到真公開活動同逐場連結。 */
export function injectLuckyEventIndexContent(
  html: string,
  events: readonly PublicLuckyEventSeo[],
): string {
  try {
    if (events.length === 0 || html.includes('id="redcode-lucky-event-index"')) return html;
    const rows = events
      .map((event) => {
        const date = drawDateLabel(event.scheduledDrawDate);
        return `<li><a href="/lucky-results/${event.id}">《${esc(event.name)}》中獎公告</a>${date ? `（預定抽獎日 ${esc(date)}）` : ""}</li>`;
      })
      .join("");
    const block = `<section id="redcode-lucky-event-index"><h2>公開抽獎活動</h2><ul>${rows}</ul></section>`;
    return html.replace('<nav aria-label="相關公開頁面">', `${block}<nav aria-label="相關公開頁面">`);
  } catch {
    return html;
  }
}

/** 只注入公開活動 metadata；winner 名單仍由公開 API 按同一 visibility 規則提供。 */
export function injectLuckyEventSeoContent(html: string, event: PublicLuckyEventSeo): string {
  try {
    if (html.includes('id="redcode-public-seo"')) return html;
    const date = drawDateLabel(event.scheduledDrawDate);
    const block =
      `<main id="redcode-public-seo" data-redcode-prerender style="max-width:56rem;margin:0 auto;padding:4rem 1.5rem;color:#fff;background:#0a0614;line-height:1.8">` +
      `<h1>《${esc(event.name)}》中獎公告</h1>` +
      `<p>RedCode《${esc(event.name)}》直播抽獎活動公開公告。已公佈內容只包括活動資料、對外顯示名同獎品，唔公開電話、電郵、地址或會員編號。</p>` +
      `<p>${date ? `預定抽獎日：${esc(date)}` : "抽獎日待公佈"}</p>` +
      `<nav aria-label="相關公開頁面"><ul><li><a href="/lucky-results">全部中獎公告</a></li><li><a href="/live">直播重溫</a></li><li><a href="/products">全部貨品</a></li></ul></nav></main>`;
    return html.replace("</body>", `    ${block}\n  </body>`);
  } catch {
    return html;
  }
}
