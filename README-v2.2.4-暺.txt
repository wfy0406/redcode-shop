RedCode 官網 v2.2.4 — 點放（2026-09-30）
================================================

今次改咗咩（老闆 3 個問題）
------------------------------------------------
1) 「推播個 logo 唔係透明底既？」
   → push-icon.png 已重新出圖：紅粉 RedCode logo + 透明底，
     推播大圖示（右邊嗰個）會襯返系統底色，冇晒深色方塊感。

2) 「點解仲係用緊 Chrome 個 logo？」（推播左邊個圓圈）
   → 講解：左邊圓圈係 Android 話你知「邊個 app 發出通知」，
     因為而家推播係經 Chrome 瀏覽器發出，所以永遠係 Chrome icon，
     呢個係 Android 系統規矩，逐條通知改唔到。
   → 解決方法：將網站「加至主畫面」（安裝做 app）。
     今次整好咗 manifest：加咗 192/512 方形 icon（any + maskable），
     而家 Chrome 會畀你裝 RedCode 做獨立 app。
     裝咗之後，推播左邊就會變返 RedCode 自己個 icon！
     點裝：手機 Chrome 開 redcode.red → 右上角 ⋮ → 「加至主畫面」／
           「安裝應用程式」→ 之後用主畫面個 RedCode icon 入網站，
           通知就會以 RedCode app 身份出現。

3) 「按入去仲係彈網頁版，無導向手機 app」
   → 原因：舊版跳板頁用 fb:// 深鏈，但 Chrome 規定冇用戶手勢就
     會靜音擋住（推播撳入嚟嗰吓唔算手勢），所以 1.6 秒後跌返網頁版。
   → 而家 Android 改用 intent:// 深鏈：
       · Chrome 原生支持，唔使手勢都會直接交畀 Facebook app
       · 冇裝 FB app？唔使猜 —— intent 內置 browser_fallback_url，
         Chrome 自己會落返 facebook.com 網頁版，百分百可靠
   → iPhone 維持用 fb://facewebmodal 靜音試開，失敗先落網頁版。
   → 跳板頁保留「立即入直播」大手掣：Android 個掣都係 intent://，
     撳實得。

改動文件一覽
------------------------------------------------
public/push-icon.png            重出：192² 透明底
public/pwa-icon-192.png         新增：192² 方形（透明底，PWA icon）
public/pwa-icon-512.png         新增：512² 方形（透明底，PWA icon）
public/pwa-icon-maskable-192.png  新增：192² maskable（深底 #0B1020）
public/pwa-icon-maskable-512.png  新增：512² maskable（深底 #0B1020）
public/manifest.webmanifest     icons 加方形 + maskable 四件
public/live-go.html             Android 改 intent:// + fallback；
                                iOS 維持 iframe fb://；註釋更新
public/sw.js                    註釋更新（icon 改透明底說明）

點放（同之前一樣）
------------------------------------------------
1. GitHub web 上傳成個 repo（或者 Render 連住個倉就 push 上去）
2. Render 會自己 build + 起
3. 冇新環境變數要加（VAPID／SITE_URL 沿用）

放完點驗收
------------------------------------------------
A. 透明 icon：
   後台推播測試 → 通知右邊大圖係透明底 RedCode logo。
B. 左邊 Chrome 圈：
   未裝 PWA 之前仲會係 Chrome（正常，系統規矩）；
   跟上面步驟「加至主畫面」之後再收推播，左邊會變 RedCode。
   注意：要重新訂閱推播先會用新身份 —— 裝咗 app 之後，
   用主畫面 icon 開網站，後台再發一次測試推播。
C. 跳 app：
   Android 手機撳推播 → 應該即刻彈 Facebook app；
   冇裝 FB 嘅機 → 自動落 facebook.com 網頁版。
   iPhone → 有裝就入 app，冇就網頁版。

注意事項
------------------------------------------------
· JWT_SECRET、VAPID 三條 key 千祈唔好改。
· 推播訂閱資料（endpoint／p256dh／auth）永不回前端、永不落 log。
· 今次冇 DB schema 改動，boot-migrate 冇新嘢要行。
