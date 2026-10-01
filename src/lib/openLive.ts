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

/**
 * v2.2.30（老闆實測：人哋部 Samsung 睇到，佢部機睇唔到直播條片）：
 * Samsung Internet 嘅「智能防追蹤」（個別機揀咗「總是」）會擋第三方
 * cookie／storage → FB 嵌入播放器喺嗰啲機上直接罷工（撳落去無反應／黑屏）。
 * 偵測到 SamsungBrowser 就唔好 mount FB iframe，全部改用 v6 跳板路線
 * （live-go-v6.html 已內建 Samsung 12s 保底開網頁版），保證睇到。
 */
export function isSamsungInternet(): boolean {
  return /SamsungBrowser/i.test(navigator.userAgent || '');
}

/**
 * v2.2.30（老闆實測：iPhone 原位播放器睇唔到，但放大睇全屏 overlay 播到）：
 * iOS Safari 老牌 bug——iframe 放喺 overflow-hidden＋圓角容器入面，hit-test
 * 會穿唔入 iframe，撳極無反應。iPhone／iPad 原位播放唔可靠，改用全屏 overlay。
 */
export function isAppleMobile(): boolean {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}
