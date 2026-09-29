/**
 * openFacebookLive（v2.2.2，2026-09-30 老闆指令）
 *
 * 手機入直播要直接開 Facebook app；冇裝 app 先落網頁版。
 * - 手機：先試 fb://facewebmodal/f?href={url}（FB app 內置瀏覽器開任意 https 連結）；
 *   1.6s 內頁面冇入背景（即係開唔到 app）→ 自動落返 facebook.com 網頁版。
 * - iOS 用隱形 iframe 靜音試開（避免 Safari 彈「打唔開」警告）；Android 直接 location 撞。
 * - 桌面機：直接新分頁開網頁版。
 */
export function openFacebookLive(url: string): void {
  const ua = navigator.userAgent || '';
  const isMobile = /iPhone|iPad|iPod|Android/i.test(ua);

  if (!isMobile) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  const deep = `fb://facewebmodal/f?href=${encodeURIComponent(url)}`;
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const started = Date.now();

  // FB app 成功開咗 → 頁面入背景（document.hidden）→ fallback 唔觸發
  window.setTimeout(() => {
    if (!document.hidden && Date.now() - started < 4000) {
      window.location.href = url;
    }
  }, 1600);

  try {
    if (isIOS) {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.src = deep;
      document.body.appendChild(iframe);
      window.setTimeout(() => {
        if (document.body.contains(iframe)) document.body.removeChild(iframe);
      }, 1500);
    } else {
      window.location.href = deep;
    }
  } catch {
    window.location.href = url;
  }
}
