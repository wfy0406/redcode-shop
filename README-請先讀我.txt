RedCode 官網 — SEO 產品資料補強（2026-10-06）
==================================================

【今次改咗乜】
清走 Google Search Console「商家資訊」嗰 2 個警告（共 8 個項目）：
  ⚠「hasMerchantReturnPolicy」欄位未填（位於「offers」）
  ⚠「shippingDetails」欄位未填（位於「offers」）

1. api/lib/og.ts（覆蓋）
   產品頁嘅 Google 結構化資料（JSON-LD）加咗：
   — 退貨政策：7 天內、郵寄退貨（同你個 /returns 政策頁一致）
   — 運費資料：香港區 HK$30 順豐基準價
   效果：警告會消失，產品喺 Google 搜尋有機會顯示埋退貨/運費賣點。

2. api/boot.ts（覆蓋）
   sitemap.xml 加咗 /returns 呢版，Google 更容易搵到退換貨政策頁。

【點樣安裝】
1. 解壓 zip
2. 兩個檔按路徑覆蓋：
   api/lib/og.ts  → api/lib/og.ts
   api/boot.ts    → api/boot.ts
3. GitHub Desktop 應該只顯示 2 個 changes（2 個 modified）
   數目唔對即係解壓位置錯，先問我，唔好 push。
4. Commit message 建議：SEO 補產品退貨政策＋運費結構化資料，sitemap 加 /returns
5. Push 後 Render 約 30–40 分鐘部署

【部署後點驗證】
1. 開 https://redcode.red/sitemap.xml — 應該見到 /returns 嗰行
2. 開任何一件產品頁（例如 https://redcode.red/products/18），
   右撳 →「檢視網頁原始碼」→ 搵 hasMerchantReturnPolicy，見到就係咗
3. 返 Search Console「商家資訊」版，撳嗰兩個警告入去按「驗證修正」，
   Google 會喺幾日內覆核，通過後警告消失

【備注】
— 之前「aggregateRating／review」嗰 2 個警告仲喺度嘅話屬正常：
  嗰啲要真客人評價功能先清到，唔可以造假。想做嘅話話我知，我幫你起。
— Merchant Center 嗰 28 件產品審查照舊進行中，唔受今次改動影響。
