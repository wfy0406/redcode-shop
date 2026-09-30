redcode.red 網店 v2.2.19（iPhone 推播跳轉最終方案：自動淨去網頁版直播）
========================================================================
老細吩咐：「IPHONE唔轉跳APP，跳去網頁版；或者按果粒制就跳去APP指定直播片。
ANDROID繼續唔洗郁。」→ 呢個版本照做，Android 同一個位都無郁。

【點解 iPhone 自動跳轉唔再去 Facebook App】
老細親測證實：就算客人親手撳官方直播連結，Facebook iOS App 都會
「跌去首頁」、唔去條直播片 —— 呢個係 Facebook App 自己嘅行為，
任何網站都控制唔到（研究已確認：fb:// 深鏈喺 iOS 全部失效、
Universal Link 嘅 /watch 路徑會俾 FB App 自己掉咗）。
所以 iPhone 嘅「自動路線」從此唔再碰 App，保證客人一定見到條片。

【今次改咗咩】
1) 新跳板頁 public/live-go-v6.html：
   ・iPhone / iPad：
     ‑ 自動：4 秒內直接開「網頁版」直播條片（m.facebook.com），
       保證落條片，唔會再落 App 首頁。
     ‑ 金色大掣改名「用 Facebook App 睇直播」：係一條真正嘅
       官方 https 連結（新分頁開），客人想入 App 自己撳；
       撳咗去唔去到條片，由 Facebook 決定，我哋管唔到。
     ‑ 副標題講清楚：「幾秒後自動開網頁版直播；想用 Facebook App
       睇，撳下面個金掣」。
   ・Android：同 v2.2.18 一模一樣，一個位都無改
     （開頁自動試一次 FB App；Chrome 6 秒 / Samsung 12 秒保底落網頁；
       撳金掣/撳頁面任何位即刻試 App）。
   ・桌面電腦：照舊直接去 FB 連結。
   ・連結白名單唔變：淨係放行 facebook.com / fb.watch / fb.me，
     其他一律擋返首頁；?u= 內容同之前一樣唔落 log。
2) 五張舊跳板頁（live-go.html / -v2 / -v3 / -v4 / -v5）全部變咗
   「轉址殼」：自動飛去 live-go-v6.html，保留 ?u= 參數。
   舊測試連結、舊推播全部照用，唔使理。
3) 推播同後台「試開」按鈕改用 live-go-v6.html
   （public/ 檔案無快取指紋，唔改名會食到瀏覽器舊快取，
    所以每版跳轉邏輯都換新檔名；sw.js 一齊更新）。

【點樣驗收】
1) 手機開呢條測試連結（同舊條一樣，淨係 v4 改 v6）：
   https://redcode.red/live-go-v6.html?u=https%3A%2F%2Fwww.facebook.com%2Fwatch%2F%3Fv%3D28610528795252808
   ・iPhone：4 秒內自動去網頁版條片（見到條直播片，唔係首頁）；
     撳金掣會開新分頁試入 FB App。
   ・Android Chrome / Samsung：照舊自動試開 FB App，失敗就保底網頁。
2) 後台發一次「測試推播」，手機點推播 → 同上效果。

【點樣放上去（同之前一樣）】
1) GitHub 網站開紅碼網店個 repo。
2) 上傳呢個 zip 入面「全部」檔案（有 public/live-go-v6.html、
   public/live-go.html～-v5 六張頁、api/livePush.ts、public/sw.js、
   src/components/admin/LivePushPanel.tsx），選 overwrite。
3) Render 會自己重新 build；大約 3-5 分鐘。
4) 開一次首頁，再撳上面條測試連結 → 1) 嘅效果。
