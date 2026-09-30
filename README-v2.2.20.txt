redcode.red 網店 v2.2.20（SEO 全面優化）
========================================================================
【今次做咗咩】（派咗 4 個專家 agent 研究＋施工，全部跟 Google 2026 官方文件）
1) index.html 頭部全套：
   ・新 title「RedCode Fashion Design｜香港女裝直播網店」＋關鍵字 description
   ・Open Graph 補齊 og:url / og:image:width / height / alt / og:locale=zh_HK
   ・新 og-image.jpg（1200×630，66KB）——WhatsApp/FB 分享連結即刻有靚預覽
     （WhatsApp 超過約 300KB 會靜靜雞唔顯示圖，舊 logo.png 335KB 一直唔合格）
   ・Twitter card 升級 summary_large_image
   ・Organization＋WebSite 結構化數據（JSON-LD）：品牌名、公司名、logo、
     Facebook 專頁 sameAs 連結，幫 Google 認出品牌
   ・canonical 指 https://redcode.red/
2) robots.txt（新）：放行全部爬蟲＋宣告 sitemap 位置
3) 動態 sitemap.xml（新）：/sitemap.xml 自動列出首頁＋全部上架中產品
   （https://redcode.red/products/{id}），每小時快取；DB 故障都會照出首頁，
   唔會 500。
4) 產品頁 server 注入升級（og.ts）：分享 /products/{id} 時除咗原有 OG，
   新增 Product JSON-LD（名、圖、描述、HKD 價錢、有冇貨），兼修正
   canonical 指返該產品——Google 購物搜尋 rich result 嘅入場券。
5) 19 頁逐頁中文 title/description（src/lib/seo.ts）：客人開幾多個分頁
   都分得到；Google 渲染後亦讀到。產品頁 title 自動帶產品名。
6) 首屏大減磅：18 個頁面改 lazy loading（Admin 後台都唔再打入首屏），
   轉頁先載入；載入中畫面用品牌色。首屏 JS 量大減，Google 渲染成功率
   同上網速度都會好轉。
7) 圖片優化：非首屏圖全部 lazy load；VIP 頁主視覺加高優先載入。

【鐵律確認】HashRouter 無郁、BillPage 無郁、金額邏輯無郁（products 表
係整數港元，JSON-LD 直接出價，無乘除）、push/sw.js 無郁、可見文案無郁。

【點樣放上去】同之前一樣：GitHub 上傳 zip 全部檔案（overwrite），
Render 自己 build 3-5 分鐘。

【放完之後你要做嘅嘢（老細親自做，唔使技術）】
1) 開 https://redcode.red/robots.txt 同 https://redcode.red/sitemap.xml，
   見到內容即成功。
2) Google Search Console（Google 佔香港 91% 搜尋，必做）：
   a. 去 https://search.google.com/search-console 用公司 Google 帳戶登入
   b. 揀「網域」資源，輸入 redcode.red
   c. 佢會畀一串 TXT 記錄碼 → 去你買網域嘅平台 DNS 管理加呢條 TXT
      （主機名填 @）→ 返去撳「驗證」（DNS 要等 15 分鐘至 48 小時）
      ※ 如果想快，可以揀「HTML 標記」方法，將佢畀嘅 meta 碼 send 畀我，
        我幫你貼落 index.html（已經留咗位）
   d. 驗證後：左邊「Sitemap」→ 輸入 sitemap.xml → 提交
3) FB/WhatsApp 舊連結預覽有 cache：去 Facebook Sharing Debugger
   （https://developers.facebook.com/tools/debug/）貼首頁網址撳
   「Scrape Again」；WhatsApp 嗰邊分享時加個 ?v=2 喺網址尾就會重新抓取。
4) Bing Webmaster（10 分鐘順手做，養 Yahoo/DuckDuckGo/ChatGPT 搜尋）：
   https://www.bing.com/webmasters 用 Google 帳戶登入 →「從 Search Console
   匯入」→ 搞掂。

【研究發現嘅大件事（你要決定）】
而家網站用 HashRouter（網址有 #），Google 官方文件確認：# 後面嘅嘢
永遠唔會送上 server，Google 眼中成個網站只有一頁。今次所有優化已經
做到 HashRouter 下嘅極限（首頁＋產品分享頁有全套 meta/結構化數據），
但 19 頁唔可以逐頁上 Google。
根治方法係轉 BrowserRouter（網址無 #）＋ server fallback——你個 server
其實已經有 fallback 機制，遷移風險中低（當年黑屏係因為冇 fallback，
而家有咗）。轉咗之後：19 頁逐頁可以被 Google 收錄、sitemap 可以列晒、
可以再做 build-time prerender。想做就話我知，我派 agent 搞。
