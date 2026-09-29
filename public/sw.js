/**
 * RedCode 直播開播推送 Service Worker（v2.2.0，2026-09-30 老闆指令）
 * 純 vanilla，唔准 import 任何嘢（service worker 獨立 thread）。
 *
 * 職責（得兩樣，通知內容全部後端砌好）：
 * 1. push event → JSON.parse(payload) → showNotification(title, { body, icon, data: { url } })
 * 2. notificationclick → 關通知 → clients.openWindow(data.url)（冇 url 就開 '/'）
 *    facebook.com 連結喺手機會由系統 universal links 自動開 FB app，唔使自己寫 fb://
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
      icon: '/logo.png',
      badge: '/logo.png',
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
