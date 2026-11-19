/**
 * Glo Guide 首口 prerender 生命周期收口（2026-11-19 R01）。
 *
 * 背景：server 首口 HTML 會注入完整真文章（data-redcode-prerender="glo-guide"，
 * 見 api/gloGuideSeo.ts）。舊流程用 inline <script> 首次繪畫前收起佢，再喺 App mount
 * 即刻移除——inline script 唔喺 CSP script-src 白名單（violation＋被擋），而 mount
 * 即移除令慢網絡下「全版文章消失」（實測 CLS ≈1.0）。
 *
 * 新生命周期（統一喺呢度，頁面／App 唔准各自再寫 querySelector 邏輯）：
 * 1. App mount：只移除非 glo-guide 嘅其他首口注入（首頁／公開頁摘要等 eager 內容）；
 *    glo-guide 文章區塊**保持可見**。
 * 2. glo-guide route chunk 未返／tRPC 資料未返：對應頁面或 GuideRouteLoading 用
 *    adoptGloGuidePrerender 將文章區塊搬入 outlet 原位——客人由第一幀起可以照讀，
 *    SSR→CSR H1 連續，唔會被全屏 loading 冚住。
 * 3. 真資料＋真 H1 commit（或明確 NOT_FOUND／非 NOT_FOUND 錯誤態 commit）後，
 *    對應頁面先 discardGloGuidePrerender 移除區塊——唔會有兩份 visible DOM。
 * 4. SPA 轉頁（離開入口路徑）App 會 discard 剩餘區塊：notFound／其他頁唔會留舊文。
 *
 * 區塊被搬入 React 容器後，若容器 unmount（Suspense 交接／轉頁），DOM 會隨容器脫離，
 * 但呢度 hold 住節點 ref，下個 pending 容器可以原樣再領養（圖片唔會重新下載）。
 */

const PRERENDER_ATTR = 'data-redcode-prerender';
const GUIDE_VALUE = 'glo-guide';

/** 已被領養（或曾被領養、暫時脫離文件）嘅 glo-guide prerender 節點 */
let heldNode: HTMLElement | null = null;

/** 搵到 glo-guide prerender 節點（被領養中嘅用 held ref；否則查 document）。 */
export function findGloGuidePrerender(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  if (heldNode) return heldNode;
  return document.querySelector<HTMLElement>(`[${PRERENDER_ATTR}="${GUIDE_VALUE}"]`);
}

export function hasGloGuidePrerender(): boolean {
  return findGloGuidePrerender() !== null;
}

/**
 * 將 prerender 區塊搬入指定容器（頁面 pending 時嘅 outlet 原位）。
 * 節點已經喺容器入面就 no-op；重複呼叫安全。
 */
export function adoptGloGuidePrerender(container: HTMLElement): void {
  const node = findGloGuidePrerender();
  if (!node) return;
  if (node.parentElement !== container) container.appendChild(node);
  heldNode = node;
}

/** 真內容 commit／NOT_FOUND／轉頁後永久移除 prerender 區塊（幂等）。 */
export function discardGloGuidePrerender(): void {
  const node = findGloGuidePrerender();
  heldNode = null;
  node?.remove();
}

/** App mount 用：移除非 glo-guide 嘅其他首口注入（舊行為），glo-guide 文章留低。 */
export function removeNonGuidePrerenderBlocks(): void {
  if (typeof document === 'undefined') return;
  document.querySelectorAll(`[${PRERENDER_ATTR}]`).forEach((node) => {
    if (node.getAttribute(PRERENDER_ATTR) !== GUIDE_VALUE) node.remove();
  });
}
