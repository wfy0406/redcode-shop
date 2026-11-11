/**
 * v2026.11.11.2（老闆指令）：對外抽獎公告「總開關」嘅前端 helper。
 *
 * 兩個職責：
 * 1. holdClosedAnnouncementSeo()——總開關關閉時守住頁面 SEO：
 *    - 即刻寫 title/description/robots=noindex,nofollow＋清 canonical＋清 og:url；
 *    - 用 MutationObserver 守住成個 <head>：SeoManager（掛喺 App root，parent effect
 *      後跑）每次路由／search 變化都會將 /lucky-results* 嘅 title/description/robots/
 *      canonical/og:url 重設做公開版本——關閉期間一翻轉即刻還原，保證 server 首口嘅
 *      noindex 同「公告已關閉」文案唔會喺 client 俾人翻轉；
 *    - **寫入前一律先檢查現值**（值啱就唔寫）：observer 回調自己都係 mutation 來源，
 *      冇呢個檢查會構成無限 observer loop；
 *    - 回傳 stop 函數（組件 unmount／總開關重開時 call）。
 * 2. resetLuckyAnnouncementPublicQueries(utils)——後台切換總開關後即時清對外快取：
 *    - publicEvents.reset()：總覽／Navbar 即刻收（唔只 invalidate，係連舊 data 都清）；
 *    - publicEventResults.reset() **唔帶 input**＝成個 procedure 所有 eventId 嘅
 *      單場名單快取一齊清（唔只係而家揀中嗰場）——resetQueries 用 queryKey 前綴
 *      partial match，`[['luckyDraw','publicEventResults']]` 會中晒
 *      `[['luckyDraw','publicEventResults'],{input:{eventId:N}}]` 全部；
 *    - publicAnnouncementStatus.invalidate()：公告頁下一次渲染即刻知道最新開關。
 *    測試 src/lib/luckyAnnouncementVisibility.test.ts 用真 QueryClient＋真 tRPC utils
 *    實證多個 eventId 快取一齊清。
 */

export const LUCKY_ANNOUNCEMENT_CLOSED_TITLE = '中獎公告已關閉｜RedCode Fashion Design';
export const LUCKY_ANNOUNCEMENT_CLOSED_DESCRIPTION =
  'RedCode 對外抽獎公告功能暫時關閉；持有抽獎劵嘅客人可繼續用店家提供嘅專屬查劵連結自助查詢。';
export const LUCKY_ANNOUNCEMENT_NOINDEX = 'noindex, nofollow';

/** head 元素嘅最小介面（測試可以用假元素，唔使真 DOM） */
export interface ClosedSeoElementLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

export interface ClosedSeoDocLike {
  title: string;
  querySelector(selector: string): ClosedSeoElementLike | null;
  /** MutationObserver observe 目標（真 DOM＝document.head）；冇就淨係 apply 一次唔守 */
  head?: unknown;
}

/** meta content 寫入前檢查現值——observer 回調安全（唔會自己觸發自己）。 */
function setMetaContentOnce(doc: ClosedSeoDocLike, selector: string, value: string): void {
  const el = doc.querySelector(selector);
  if (el && el.getAttribute('content') !== value) el.setAttribute('content', value);
}

/** 寫一次關閉公告 SEO：title/description/robots=noindex＋移除 canonical＋移除 og:url。
 *  全部寫入前先檢查現值（值啱唔寫），俾 MutationObserver 回調重入都唔會 loop。 */
export function applyClosedAnnouncementSeo(
  doc: ClosedSeoDocLike = document,
): void {
  if (doc.title !== LUCKY_ANNOUNCEMENT_CLOSED_TITLE) doc.title = LUCKY_ANNOUNCEMENT_CLOSED_TITLE;
  setMetaContentOnce(doc, 'meta[name="description"]', LUCKY_ANNOUNCEMENT_CLOSED_DESCRIPTION);
  setMetaContentOnce(doc, 'meta[name="robots"]', LUCKY_ANNOUNCEMENT_NOINDEX);
  // 關閉期間唔准有 canonical／og:url 指返公告頁（同 setCanonicalPath(null) 同等效果，doc-driven 方便測試）
  doc.querySelector('link[rel="canonical"]')?.remove();
  doc.querySelector('meta[property="og:url"]')?.remove();
}

type MutationObserverLike = {
  observe(target: unknown, options: unknown): void;
  disconnect(): void;
};
type MutationObserverCtor = new (callback: () => void) => MutationObserverLike;

/** 關閉期間守住完整 head SEO（title/description/robots/canonical/og:url，見檔頭）。
 *  冇 DOM／冇 MutationObserver／冇 head（SSR／node test）就只 apply 一次。 */
export function holdClosedAnnouncementSeo(
  doc: ClosedSeoDocLike | undefined = typeof document === 'undefined' ? undefined : document,
  ObserverImpl: MutationObserverCtor | undefined =
    typeof MutationObserver === 'undefined' ? undefined : MutationObserver,
): () => void {
  if (!doc) return () => {};
  applyClosedAnnouncementSeo(doc);
  if (!ObserverImpl || !doc.head) return () => {};
  // 任何 head mutation 都重檢一次五項（apply 內部值啱唔寫，唔會 observer loop）：
  // - attributes(content/href)：robots/description/og:url 俾人翻轉
  // - childList：canonical link／og:url meta 俾人加返、<title> 被替換
  // - characterData：document.title 改 <title> 文字節點
  const observer = new ObserverImpl(() => applyClosedAnnouncementSeo(doc));
  observer.observe(doc.head, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
    attributeFilter: ['content', 'href'],
  });
  return () => observer.disconnect();
}

/** 公告資料嘅準出閘（基礎版）：只有總開關 status data 明確 `true` 先算開——
 *  undefined（初次 loading／讀取失敗冇 data）一律關。 */
export function luckyAnnouncementGateOpen(enabled: boolean | undefined): boolean {
  return enabled === true;
}

/** status query 嘅最小介面（TanStack UseQueryResult 結構相容） */
export interface LuckyAnnouncementStatusQueryLike {
  isSuccess: boolean;
  isError: boolean;
  isRefetching: boolean;
}

/** 「當次 fresh success」閘（v2026.11.11.2 加強）：舊快取 true 喺背景重查（isRefetching）／
 *  重查失敗（isError，TanStack 會保留舊 data）期間一律唔算數——只有今次新鮮成功先准出公告。
 *  配合 refetchOnMount:'always'＋staleTime:0：轉頁返嚟嗰下 TanStack 會帶住舊 data 重查，
 *  呢個閘擋住嘅正正係嗰段窗口。 */
export function luckyAnnouncementStatusFresh(q: LuckyAnnouncementStatusQueryLike): boolean {
  return q.isSuccess === true && !q.isRefetching && !q.isError;
}

/** 結構型別（同 trpc.useUtils() 相容；測試用 createTRPCQueryUtils 真實例都得） */
interface LuckyPublicQueryUtils {
  luckyDraw: {
    publicAnnouncementStatus: { invalidate: () => unknown };
    publicEvents: { reset: () => unknown };
    publicEventResults: { reset: () => unknown };
  };
}

/** 後台總開關切換後即時清對外快取（見檔頭）。 */
export function resetLuckyAnnouncementPublicQueries(utils: LuckyPublicQueryUtils): void {
  void utils.luckyDraw.publicAnnouncementStatus.invalidate();
  void utils.luckyDraw.publicEvents.reset();
  void utils.luckyDraw.publicEventResults.reset();
}
