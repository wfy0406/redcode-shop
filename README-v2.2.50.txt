RedCode Shop v2.2.50 — 緊急修：刪除中獎紀錄／獎品失敗
================================================================

你截圖嗰兩個「Failed query」錯誤，原因搵到兼修好：

1. 刪中獎紀錄炸（delete from "orders" ... params: 77）
   - 原因：luckyDraws.orderId 本身有 FK 指住 orders.id，舊碼先刪 orders
     先刪 luckyDraws 行，FK 即刻頂死，成個 transaction rollback。
   - 修：單筆刪除＋成日刪除都調啱次序——luckyDraws 先，跟住訂單仔行
     （orderItems／paymentProofs／wmsSyncLog），最後先刪 orders 本行。

2. 刪獎品炸（delete from "luckyPrizes" ...）
   - 件獎品有抽獎紀錄參照住，本應彈友善提示「先刪嗰日紀錄先刪得」，
     但 drizzle 將 PG error 收埋喺 cause 度，舊 catch 捉錯位捉唔到 23503，
     生錯誤直出。
   - 修：e.code 同 e.cause.code 兩處都捉。而家會正常彈人話提示。
   - 流程照舊：要刪有紀錄嘅獎品，先去「刪除」嗰日嘅中獎紀錄，返嚟就刪得。

3. fmtErr 加料：萬一再有 drizzle 生錯誤（Failed query: 開頭），
   toast 唔會再原句晒出 SQL，會顯示人話「資料庫拒絕咗呢個操作…」。

■ 檔案（2 + README）
api/luckyDrawRouter.ts                  刪除次序 + 23503 捕捉
src/components/admin/LuckyDrawPanel.tsx fmtErr 生錯誤轉人話

■ 注意
- 套用順序：46 → 47 → 48 → 49 → 50。
- 唔使落 SQL，純 code 修。
