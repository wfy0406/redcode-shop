redcode-shop v2.2.54（2026-10-03）
================================

老闆兩條指令：
1) 「重抽係拎翻件商品重新抽過，岩岩既抽獎紀錄唔算數」
2) 「按第1場會出1，係官網直播回顧要顯示係第1場，推播都要寫第1場」

改動內容
--------
1) 重抽唔留舊紀錄（api/luckyDrawRouter.ts）
   - adminRedraw 兩條路徑（自訂名單／會員池）：舊 pending 紀錄由「轉 cancelled 留底」
     改做同一個 transaction 入面直接刪除。中獎紀錄頁唔會再見到「已取消」嘅重抽底，
     淨係見到新抽嗰筆。審計線索照舊喺 audit log（#舊 → #新）。
   - 新紀錄 redrawOfId 照舊記低取代咗邊個號（顯示「特別重抽（取代 #N）」）。
   - 舊中獎人照舊踢出重抽池（重抽就係要換人）；池空照舊唔郁手，舊中獎保留。

2) 場次顯示「第N場」
   - api/livePush.ts：buildLivePushBody 加 fmtLiveSession——推播內文
     「📅 2026-10-03 1」→「📅 2026-10-03 第1場」。官網後台直發同 WMS 代理
     發送都行呢個函數，兩邊推播一齊好。
   - src/components/push/LiveNowSection.tsx：直播中區塊「日期・第N場」。
   - src/components/push/LiveTopBanner.tsx：首頁頂直播 banner「日期・第N場」。
   - src/components/admin/BoundDeviceList.tsx：裝置推送紀錄標題用 fmtSession
     （舊文字場次唔會再變「第朝早場場」）。
   - 直播回顧（LiveHistorySection）同上版 v2.2.52 已經有 fmtSession，唔使郁。

規則照舊
--------
- 唔准郁嘅檔案（BillPage、sw.js、pushClient.ts、live-go*.html、package.json）冇郁。
- endpoint/keys/secret 冇落任何 log。
- 全部檔案過咗 esbuild 語法檢查。

安裝：解壓覆蓋 repo 相對路徑，照常 deploy（vite build && esbuild api/boot.ts）。
