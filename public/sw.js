/**
 * RedCode 直播開播推送 Service Worker（v2.2.2，2026-09-30 老闆指令）
 * 純 vanilla，唔准 import 任何嘢（service worker 獨立 thread）。
 *
 * 職責（得兩樣，通知內容全部後端砌好）：
 * 1. push event → JSON.parse(payload) → showNotification(title, { body, icon, badge, data: { url } })
 *    icon：/push-icon.png（192² 透明底 RedCode logo，Android 大圖示，v2.2.4 起透明）
 *    badge：/push-badge.png（96² 白色剪影，Android 狀態欄小圖）
 *    —— v2.2.1 之前用 /logo.png（1242×698 闊幅），Android 睇唔過直接跌返 Chrome logo。
 * 2. notificationclick → 關通知 → clients.openWindow(data.url)（冇 url 就開 '/'）
 *    data.url 後端已指向 /live-go-v6.html 跳板頁（v2.2.19 新檔名，舊 live-go*.html 係轉址殼）：
 *    入面先試 fb:// 開 Facebook app，開唔到（冇裝 app）先落返 facebook.com 網頁版。
 */

self.addEventListener('push', function (event) {
  if (!event.data) return;

  var payload = {};
  try {
    payload = event.data.json();
  } catch (e) {
    // 唔係 JSON 都唔好炒車：當純文字 body 顯示
    try {
      payload = { body: event.data.text() };
    } catch (e2) {
      payload = {};
    }
  }

  var title = typeof payload.title === 'string' && payload.title
    ? payload.title
    : '🔴 RedCode 直播開始啦！';
  var url = payload.data && typeof payload.data.url === 'string' ? payload.data.url : '/';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof payload.body === 'string' ? payload.body : '',
      icon: '/push-icon.png',
      badge: '/push-badge.png',
      data: { url: url },
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : '/';
  event.waitUntil(clients.openWindow(url));
});
