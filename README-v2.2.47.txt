RedCode 官網 v2.2.47 —— 常見問題 FAQ 頁
==================================================

【今次更新內容】
1. 新頁「常見問題」（/#/faq），導覽列「更多」入面有入口（電話版 drawer 一樣有）。
2. 接收通知教學放咗喺頁面第一個大區塊：
   - 自動偵測客人部機——iPhone/iPad 預設播 iPhone 教學片，其他預設 Android 片；
   - 客人想睇第2條可以自己撳 tab 轉（iPhone 教學 / Android 教學）。
   - 兩條片已包喺 zip 入面（public/faq/），跟住 build 會自動入 static。
   - 教學區下面寫明：訂閱咗只會收到開播通知，唔會收到購買通知；想取消就去我嘅帳戶頁撳熄。
3. 主頁「接收開播通知」制下面加咗條細字金link「接收通知教學」，直達 FAQ 教學區（自動碌落去）。
4. 十條 Q&A 手風琴：付款方便嗎／落單過程（購買→付款→審批→確認訂單）／出貨 7–12 個工作天／
   即時支付安全（Airwallex 持牌平台，我哋接觸唔到卡資料）／瑕疵品收貨後 7 天內退換／會員制度／
   順豐站點查詢（GPS 搵最近站＋即時預設做收貨站）／滿 $350 包郵／通知只收開播／點樣取消通知。
5. 設計：高貴金紫風——serif 標題、髮絲金線分隔（唔用卡片盒）、重點字鍍金粗體＋金底 highlight
   （老人家睇得清）、答案 16–17px 大行距、＋/× 旋轉開合動畫、同時間只開一條、支援 reduced-motion。

【檔案清單】（照 repo 相對路徑覆蓋／新增）
  - src/pages/Faq.tsx
  - src/App.tsx
  - src/components/Navbar.tsx
  - src/pages/Home.tsx
  - public/faq/notify-iphone.mp4
  - public/faq/notify-android.mp4

【部署步驟】
1. 解壓照路徑覆蓋（兩條片係新檔，放入 public/faq/）。
2. 正常 build 部署就得，冇 database 改動。

【老實備註】
- 影片標題同說明係通用寫法，想對返片入面嘅具體步驟字眼可以話我知再改。
- 兩條片共約 27MB，首次載入 FAQ 頁唔會即刻 download（preload="metadata"），撳播先正式拉。
