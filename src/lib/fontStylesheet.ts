export const REDCODE_FONT_STYLESHEET_ID = "redcode-font-stylesheet";

/**
 * index.html 先用 rel=preload 提早下載品牌字體 CSS，避免 parser-render blocking。
 * JS 開機時重用同一個 link，唔會重複下載，亦保留原本字體 URL 同 display=swap。
 */
export function activatePreloadedFontStylesheet(doc: Document): void {
  const link = doc.getElementById(REDCODE_FONT_STYLESHEET_ID);
  if (!(link instanceof HTMLLinkElement) || link.rel === "stylesheet") return;
  if (link.rel !== "preload" || link.as !== "style") return;
  link.rel = "stylesheet";
  link.removeAttribute("as");
}
