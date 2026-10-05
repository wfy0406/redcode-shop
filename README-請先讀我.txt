RedCode 官網 — 退換貨政策頁（2026-10-06）
==================================================

【今次改咗乜】
1. 新增「退換貨政策」頁面（網址：https://redcode.red/#/returns）
   — 內容按你口述嘅規矩寫：7 天內退換、寄出前拍照紀錄、
     破損核實後可換可退、尺寸不合原則上可換、
     非損壞不設退款、切勿人為損壞
   — 版面同「服務條款」「私隱政策」同一款式
2. 全站頁尾（Footer）加咗「退換貨政策（Returns Policy）」連結
3. 加咗頁面 SEO 標題同描述（Google 搜尋會顯示「退換貨政策｜RedCode」）

【點解要做】
Google Merchant Center 免費刊登規定網站必須有公開嘅退貨政策頁，
整好之後你先可以喺 Google 填返政策網址，完成審批。

【點樣安裝】（同之前一樣，覆蓋就得）
1. 解壓呢個 zip
2. 將入面嘅檔案按下面路徑覆蓋到 redcode-shop 項目根目錄：

   解壓出的文件                        → 覆蓋到
   src/pages/Returns.tsx              → src/pages/Returns.tsx（新檔，直接放入去）
   src/App.tsx                        → src/App.tsx（覆蓋）
   src/components/Footer.tsx          → src/components/Footer.tsx（覆蓋）
   src/lib/seo.ts                     → src/lib/seo.ts（覆蓋）

3. GitHub Desktop 應該只顯示 4 個 changes
   （3 個 modified：App.tsx / Footer.tsx / seo.ts；1 個新檔：Returns.tsx）
   如果數目唔對，即係解壓位置錯咗，先問我，唔好 push。
4. Commit message 建議：新增退換貨政策頁＋頁尾連結（Google Shopping 審批用）
5. Push 之後 Render 大約 30–40 分鐘部署完成

【部署後點驗證】
1. 開 https://redcode.red/#/returns — 應該見到「退換貨政策」頁
2. 任何一頁碌到最底，頁尾應該多咗「退換貨政策（Returns Policy）」
3. 確認見到之後，返 Google Merchant Center 退貨政策嗰格填：
   https://redcode.red/#/returns

【Google 嗰邊跟住填】
退貨期限：7 天
退貨方式：郵寄退貨
退貨運費：買家支付（破損個案我哋內部酌情處理）
政策網址：https://redcode.red/#/returns
