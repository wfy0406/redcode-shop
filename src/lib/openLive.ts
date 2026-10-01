/**
 * openFacebookLive（v2.2.21，2026-10-01 老闆指令）
 *
 * 「去 Facebook 睇」一律經 /live-go-v6.html 跳板——推播通知嘅成功例子：
 * ・iPhone：4 秒自動去網頁版**條片**（保證唔落 FB app 首頁）；想用 app 自己撳金掣
 * ・Android：一擊 https-intent 直開 FB app 指定條片；Chrome 6s／Samsung 12s 保底網頁
 * ・桌面：新分頁直接開網頁版（唔使經跳板）
 * 舊 fb:// 深鏈做法已死（iOS 開 app 落首頁、Android Chrome 擋），v2.2.2-v2.2.20 嘅做法停用。
 * ?u= 白名單只放行 FB 系域名：live-go-v6.html 已內建白名單擋 open-redirect，所以呢度唔使再驗。
 */
export function openFacebookLive(url: string): void {
  const ua = navigator.userAgent || '';
  const isMobile = /iPhone|iPad|iPod|Android/i.test(ua);
  if (!isMobile) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  window.location.assign(`/live-go-v6.html?u=${encodeURIComponent(url)}`);
}
