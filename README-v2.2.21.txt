redcode.red 網店 v2.2.21（註冊搵最近站＋首頁四掣＋縮圖根治＋去FB直達條片＋#根治＋Google購物 feed）
=================================================================================
八個專家 agent 聯合施工＋獨立驗收全 PASS。

【1）註冊／結帳／會員中心 順豐站揀選升級】
揀站介面新增「用我位置搵最近」（撳一次，電話定位即刻列最近 5 個站，
顯示「約 X.X 公里」）同「打地址搵附近」（打屋邨／屋苑／大廈名都得，
用香港政府地址識別服務＋兩個後備源）。三個用嘅地方一次過受惠。

【2）首頁四粒新掣（高度美化＋GPU 動態，唔會整慢電話）】
即睇商品（去商品頁）／追蹤我地 Facebook 專頁（直達專頁）／
直播重溫（去直播頁兼自動碌落回顧區）／接收直播開播通知（原功能保留）。
四粒有跟手光暈、逐粒入場、主掣掃光——全部只係 GPU 嘅 opacity/transform，
舊電話都唔會 lag。關於我地同頁底嘅追蹤掣本來就係直達專頁，保持不變。

【3）直播重溫縮圖根治】
以前係客人部機直載 Facebook 嘅圖床（會過期、會擋），所以成日睇唔到。
而家改做我哋 server 摷到真縮圖之後自己儲自己播（/api/live-thumb/影片id），
兼加多個 oEmbed 官方來源做雙保險。摷唔到先跌落設計 poster。

【4）「去 Facebook 睇」直達指定條片】
回顧卡底同全屏播放器底嘅「去 Facebook 睇」，以前彈 FB 但落唔到條片。
而家全部行推播嗰條成功路線（live-go-v6 跳板）：iPhone 自動去網頁版條片
＋金掣試 app；Android 自動開 FB app 條片。同推播一模一樣。

【5）網址 # 根治（你批准咗嘅 BrowserRouter 遷移）】
網址唔再有 #（/#/products/1 → /products/1）。舊書籤、舊分享連結、
舊推播全部自動跳轉照用（內建兼容跳轉）。Google 而家可以逐頁收錄：
公開頁逐頁有獨立標題/描述/canonical；私人頁（購物車/結帳/帳戶/後台等）
自動 noindex；產品頁加埋麵包屑結構化數據。

【6）Google 購物 feed（上 Google 購物嘅入場券）】
新網址 https://redcode.red/merchant-feed.xml 自動列出全部上架產品
（名、描述、圖、HKD 價錢/特價、有冇貨），Google 每個鐘可以嚟攞。

【部署】同之前一樣：GitHub 上傳 zip 全部檔案 overwrite，Render 自己 build。

【放完之後你要做】
A. 即試（手機）：首頁四掣逐粒撳；直播頁撳「去 Facebook 睇」；
   註冊頁揀順豐站試「用我位置搵最近」。
B. 上 Google 購物（15 分鐘，唔使技術）：
   1. 去 https://merchants.google.com 用公司 Google 帳戶開 Merchant Center
   2. 填商家資料（RedCode HK Limited、redcode.red）；網站驗證——如果你已經
      做咗 Search Console 驗證，呢度會自動認到，撳一下就過
   3. 左邊「產品」→「動態饋給」→ 新增 → 揀「使用連結」→ 貼：
      https://redcode.red/merchant-feed.xml → 佢會自己每日嚟攞
   4. 「運送同退貨」設定：填你嘅順豐自取/送貨安排同退貨政策（網站已經有
      私隱同條款頁，審核要睇）
   5. 等 1-3 日審核，產品就會出喺 Google 購物搜尋
C. Search Console：sitemap 依家有埋 /products /live /about 等 7 頁，
   如果之前提交咗，佢會自己更新。

【鐵律確認】BillPage／推播／sw.js／金額邏輯全部無郁；動畫全部 GPU
opacity/transform；中文無 italic；log 無敏感資料。
