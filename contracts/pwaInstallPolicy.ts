/**
 * Android WebAPK 瀏覽器相容政策（2026-11-17）。
 *
 * 保留 Google Chrome Android 嘅 WebAPK 生成路線；其他可識別 Android 瀏覽器／WebView
 * 攞到非 installable manifest，再由 FAQ／banner 引導去 Chrome。
 * 呢個係相容性政策，唔係身份驗證或保安邊界；UA 可偽造，所以不能取代權限控制。
 * Brave Android 預設使用 Chrome-identical UA，單憑 UA 無法可靠分辨。
 */
export function isAndroidUserAgent(userAgent: string | null | undefined): boolean {
  return /Android/i.test(userAgent ?? "");
}

/** 只接受可識別嘅 Chrome Android；常見 Chromium 分支及新舊 WebView 都唔當 Chrome。 */
export function isChromeAndroidUserAgent(userAgent: string | null | undefined): boolean {
  const ua = userAgent ?? "";
  if (!isAndroidUserAgent(ua) || !/Chrome\/\d+/i.test(ua)) return false;
  if (/Version\/4\.0|;\s*wv\)/i.test(ua)) return false;
  return !/(SamsungBrowser|EdgA|Edge|OPR|Opera|Firefox|UCBrowser|MiuiBrowser|HuaweiBrowser|VivoBrowser|HeyTapBrowser|YaBrowser|DuckDuckGo|MQQBrowser|QQBrowser|Puffin|Whale|AlohaBrowser|Maxthon|OppoBrowser|SogouMobileBrowser|2345Browser|LBBROWSER|HeadlessChrome)/i.test(ua);
}

/** 非 Android（包括 iPhone／iPad／桌面）完全沿用原有 PWA 政策。 */
export function shouldDisableAndroidWebApk(userAgent: string | null | undefined): boolean {
  return isAndroidUserAgent(userAgent) && !isChromeAndroidUserAgent(userAgent);
}
