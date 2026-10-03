RedCode Shop v2.2.49 — 直播抽獎大執 + 小精靈重做 + 中獎推送紀錄
================================================================

老闆六點 feedback + 後續三句指令，全部做齊。套用順序：46 → 47 → 48 → 49。

■ 今包有咩
1. 自訂名單淨揀官網會員唔再炸
   - names 唔再必填，名單起碼「一個名 或 一位會員」；zod 錯誤 toast 顯示人話（fmtErr）。

2. 獎品名／圖選填
   - 淨填貨號＋價錢得；名留空自動用貨號商品名，圖留空用商品官網圖。
   - DB：luckyPrizes.imagePath 改 nullable（boot 自動 migrate）。

3. 小精靈重做（同款・全身・拍手恭喜）
   - 用返官網現有 Glo Glo 精靈做參考重新生成，兩幀「張開手→拍手＋閃閃」，
     全身造型，透明底三件套：fairy-clap-alpha.webm（VP9 alpha）／
     fairy-clap-anim.webp（拍手 loop）／fairy-clap-poster.webp（定格）。
   - 彈窗小精靈唔再移位：改做企正卡頂邊置中（唔再 absolute 掛角），
     由左下飛入動畫保留，reduced-motion 自動靜態。

4. FAQ 教學片改直式
   - 播放器改 9:16 直式（max-width 380 置中），iPhone/Android 兩條片都係。

5. 中獎名單成日刪除
   - 紀錄每個日期 group header 右邊「刪除成日」（admin 先得）。

6. 獎品大執
   - 獎品任何狀態都刪得（有紀錄參照住會話你點做）。
   - 獎品分場次：面板頂下拉轉場次，新增獎品自動入當前場，剩餘計數按場計。
   - 重抽邏輯：當次重抽踢走岩岩中嗰個；但佢無接受（取消/拒絕）之後放返出嚟可再中。
     已接受/等緊接受嘅客人當日唔會再被抽中。
   - 參加名單加四款條件：本月消費滿$X／本月新客戶／指定日期前註冊／指定日期後註冊。

7. 刪除中獎紀錄＝連官網張單一併刪（老闆原話：WMS 佢哋自己處理）
   - 單筆刪除、成日刪除都係：orderItems→paymentProofs→wmsSyncLog→orders→luckyDraws
     transaction 順序硬刪；冇晒「已批核唔准刪」嘅阻擋。
   - 取消中獎：官網訂單寫返「已取消」（原本已做，今次補埋已出貨極端情況照取消中獎）。

8. 中獎推送終於有紀錄（你截圖嗰單）
   - 原因：sendPrizeWinPush 一直冇寫 pushDeliveries 表，彈窗又只 join 直播 campaign。
   - 而家逐部裝置成功/失敗都落 log；綁定手機→撳部機→推送紀錄會見到
     「🎉 中獎通知」行，成功綠字／失敗連原因（訂閱失效/HTTP 碼/未知）。
   - DB：pushDeliveries.campaignId 改 nullable（boot 自動 migrate）。

■ 檔案清單（12 + 呢個 README）
api/luckyDrawRouter.ts          抽獎後端（六點 feedback + 硬刪單 + 成日刪）
api/livePush.ts                 中獎推送落 pushDeliveries
api/membersRouter.ts            推送紀錄 query 改 leftJoin（中獎行 campaignId=null）
api/boot-migrate.ts             DB 自動遷移三項（session 欄／imagePath nullable／campaignId nullable）
db/schema.ts                    表結構對齊
src/components/admin/LuckyDrawPanel.tsx   面板（場次下拉／選填名圖／永遠可刪／四款條件／刪除成日／fmtErr）
src/components/admin/BoundDeviceList.tsx  推送紀錄彈窗顯示「🎉 中獎通知」
src/components/PrizeWinModal.tsx          小精靈定位修正＋換新素材路徑
src/pages/Faq.tsx                         教學片改 9:16 直式
public/fairy-clap-alpha.webm              新精靈拍手（透明底影片）
public/fairy-clap-anim.webp               新精靈拍手（動圖 fallback）
public/fairy-clap-poster.webp             新精靈定格（poster）

■ 注意
- DB 遷移開機自動跑，唔使人手落 SQL。
- 新精靈三件套喺 public/，如 CDN 有 cache 記得清/等佢過期。
- 獎品如果連貨號商品都冇圖，中獎框會淨係冇圖（唔會炸），係預期。
- 禁區檔案（BillPage／sw.js／pushClient.ts／live-go*.html／package.json）冇掂過。
- 全部改動過咗 esbuild 語法驗證。
