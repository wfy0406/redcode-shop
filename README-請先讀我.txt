【redcode-shop】SEO 補欄位：送貨時間＋退貨運費（2026-10-08）
================================================

回應 Search Console「商家資訊」兩個新建議（黃色警告，唔係錯誤）：
①「returnShippingFeesAmount 欄位未填」→ 退貨政策補埋退貨運費金額 HK$30（買家付順豐到付）
②「deliveryTime 欄位未填」→ 運送資料補埋送貨時間，跟足你 Merchant Center 填嘅：
   處理時間 3–12 天（一至五）＋ 運送時間 2–4 天（一至日）＝ 總共 5–16 個工作天
另外順手加埋 merchantReturnLink 指去 https://redcode.red/returns 政策頁。

兩邊數字一致好緊要——Google 會對網站資料同 Merchant Center 設定，唔一致會出警告。

================================================
檔案清單（1 個，GitHub Desktop 應該只顯示 1 個 change）：

  解壓出的文件        →  覆蓋到項目根目錄的路徑
  api/lib/og.ts       →  api/lib/og.ts

部署後驗證：
1. 等 Render 部署完（約 30–40 分鐘）
2. 開任何一個產品頁 → 右擊「檢視網頁原始碼」→ Ctrl+F 搵「deliveryTime」，見到即上咗
3. 返 Search Console「商家資訊」→ 嗰兩個警告撳「驗證修正」
（剩返嗰 1 個「shippingDetails / hasMerchantReturnPolicy 未填」係 Google 未 crawl 到嗰頁，會自己好返。）
