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

/**
 * ─── v2.3 PWA 化（2026-10，以下全部係新增，上面 push／notificationclick 逐字保留）───
 *
 * 3. install：precache 離線頁＋核心圖示（核心殼層，唔 precache HTML，避免舊版卡住）
 * 4. activate：清走舊版本 cache；clients.claim() 即刻接管已開分頁
 *    —— ⚠ 唔喺度做強制 reload（唔准嚇親開緊直播嘅客人）
 * 5. fetch 快取策略：
 *    - /api/*        → 完全唔攔截（落單／付款／登入一定要行真網絡）
 *    - HTML 導航      → network-first：網絡攞到就用兼更新快取；
 *                      斷網先用快取過嘅頁，冇快取先落 /offline.html
 *                      （⚠ 唔准 cache-first HTML——會令部署後白屏／舊版卡住惡化）
 *    - /assets/*     → cache-first（Vite 檔名帶 hash，immutable 安全）
 *    - 其他同域 GET（圖片等）→ stale-while-revalidate，上限 80 項（簡單 trim）
 *    - 非 GET／cross-origin（Facebook SDK、字體 CDN 等）→ 完全唔攔截
 *
 * 更新安全：push subscription 跟 origin＋scope，唔跟 SW 版本，
 * 換新 SW 唔會令舊客人嘅開播通知 subscription 失效。
 */

var RC_VERSION = 'v2';
var RC_SHELL_CACHE = 'rc-shell-' + RC_VERSION;   // 離線頁＋核心圖示
var RC_PAGES_CACHE = 'rc-pages-' + RC_VERSION;   // network-first 快取過嘅 HTML
var RC_ASSETS_CACHE = 'rc-assets-' + RC_VERSION; // /assets/* hash 檔
var RC_MEDIA_CACHE = 'rc-media-' + RC_VERSION;   // 其他靜態（SWR）
var RC_ALL_CACHES = [RC_SHELL_CACHE, RC_PAGES_CACHE, RC_ASSETS_CACHE, RC_MEDIA_CACHE];
var RC_MEDIA_LIMIT = 80;

var RC_SHELL_URLS = [
  '/offline.html',
  '/manifest.webmanifest',
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
  '/logo.png',
];

/** 簡單 cache trim：超過上限就刪最舊嗰啲（FIFO，cache.put 次序≈寫入次序） */
function rcTrimCache(cacheName, maxItems) {
  caches.open(cacheName).then(function (cache) {
    cache.keys().then(function (keys) {
      if (keys.length <= maxItems) return;
      var excess = keys.slice(0, keys.length - maxItems);
      Promise.all(excess.map(function (key) { return cache.delete(key); }));
    });
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(RC_SHELL_CACHE).then(function (cache) {
      // addAll 有一個失敗會成個 install 失敗；逐個 add 兼容錯，離線頁以外失敗唔阻塞
      return cache.add('/offline.html').then(function () {
        return Promise.all(
          RC_SHELL_URLS.slice(1).map(function (url) {
            return cache.add(url).catch(function () { return null; });
          })
        );
      });
    }).then(function () {
      // 新 SW 即刻頂上（舊 SW 只有 push 職責，被取代唔影響通知）；
      // 已開分頁由 activate 嘅 clients.claim() 接管，唔強制刷新
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.map(function (name) {
          // 只清 rc-* 開頭但唔屬於現版本嘅舊 cache，其他來源嘅 cache 唔郁
          if (name.indexOf('rc-') === 0 && RC_ALL_CACHES.indexOf(name) === -1) {
            return caches.delete(name);
          }
          return null;
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;

  // 非 GET／cross-origin 完全唔攔截
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // /api 同 /api/* 完全唔攔截（交易／登入／推送 API 一定要行真網絡）
  if (url.pathname === '/api' || url.pathname.indexOf('/api/') === 0) return;

  // SW 檔本身唔快取（等瀏覽器 byte-check 更新機制正常運作）
  if (url.pathname === '/sw.js') return;

  // HTML 導航：network-first
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(function (response) {
        // 成功先更新快取（下次斷網可以返到呢頁）
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(RC_PAGES_CACHE).then(function (cache) {
            cache.put(request, copy);
          });
        }
        return response;
      }).catch(function () {
        // 斷網：先用呢頁嘅快取（客人返到已睇過嘅頁），冇先落離線頁
        return caches.match(request).then(function (cached) {
          if (cached) return cached;
          return caches.match('/offline.html');
        });
      })
    );
    return;
  }

  // /assets/*（Vite hash 產物）：cache-first＋immutable
  if (url.pathname.indexOf('/assets/') === 0) {
    event.respondWith(
      caches.match(request).then(function (cached) {
        if (cached) return cached;
        return fetch(request).then(function (response) {
          if (response && response.ok) {
            var copy = response.clone();
            caches.open(RC_ASSETS_CACHE).then(function (cache) {
              cache.put(request, copy);
            });
          }
          return response;
        });
      })
    );
    return;
  }

  // 其他同域 GET（圖片、icon、靜態頁）：stale-while-revalidate，上限 80 項
  event.respondWith(
    caches.match(request).then(function (cached) {
      var networkFetch = fetch(request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(RC_MEDIA_CACHE).then(function (cache) {
            cache.put(request, copy).then(function () {
              rcTrimCache(RC_MEDIA_CACHE, RC_MEDIA_LIMIT);
            });
          });
        }
        return response;
      }).catch(function () {
        return cached;
      });
      return cached || networkFetch;
    })
  );
});
