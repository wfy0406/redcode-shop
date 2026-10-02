RedCode 官網（redcode-shop）v2.2.37
直播推送三功能（老闆指令）
=================================================

今次改咗咩
-------------------------------------------------
1. 剔選「不發送直播通知」
   後台直播推送表單多咗個剔選框。剔咗之後：
   - 一個 push 通知都唔會送出
   - 首頁／直播頁照樣顯示「直播中」90 分鐘

2. 剔選「直接放入直播回顧」
   - 唔會送通知，亦唔會出現「直播中」
   - 直接就落入直播頁嘅「直播回顧」清單
   （兩個剔選互斥：剔咗其中一個，另一個即刻唔俾剔；
     取消剔選先可以揀返）

3. 直播中「延長 60 分鐘」
   - 「而家顯示緊」卡多咗一個金色掣「延長 60 分鐘」
   - 90 分鐘窗口到咗可以自己延，每撳一掣 +60 分鐘
   - 累計上限 240 分鐘（即最長 90＋240＝330 分鐘）
   - 張卡會顯示「已延長 X 分鐘」；到上限個掣會熄
   - 落播／刪除守衛／回顧清單全部跟延長後嘅窗口計，
     延長緊嘅場次唔會提早跌入回顧、亦唔俾刪

額外睇得到嘅嘢
-------------------------------------------------
- 發送紀錄表：「無發通知」／「直入回顧」／「已延長 X 分鐘」徽章
- 待批申請卡：審批人會見到申請人剔咗邊個選項
- 通知預覽下面：剔咗選項會有黃字講明實際效果
- 審計 log（audit）會留低剔選同延長紀錄

檔案清單（覆蓋 repo 內相同路徑就得）
-------------------------------------------------
api/boot-migrate.ts        開機自動加三個新欄（見下）
api/boot.ts                註冊 WMS 延長 endpoint
api/livePush.ts            發送引擎：剔咗就唔送；窗口常數＋延長計法
api/pushRouter.ts          新欄入 schema、extendLiveNow mutation、窗口逐行計
api/wmsLivePush.ts         WMS 直通：flags、/extend endpoint、守衛跟延長
db/schema.ts               pushCampaigns 加三個欄
src/components/admin/LivePushPanel.tsx   後台 UI（剔選框＋延長掣＋徽章）

資料庫
-------------------------------------------------
唔使人手做 migration。開機 boot-migrate 會自動行：
  ALTER TABLE "pushCampaigns" ADD COLUMN IF NOT EXISTS "skipNotify" boolean NOT NULL DEFAULT false;
  ALTER TABLE "pushCampaigns" ADD COLUMN IF NOT EXISTS "directReplay" boolean NOT NULL DEFAULT false;
  ALTER TABLE "pushCampaigns" ADD COLUMN IF NOT EXISTS "extendedMinutes" integer NOT NULL DEFAULT 0;
舊資料全部預設 false／0，即係同而家行為一模一樣，唔會影響舊場次。

點樣上
-------------------------------------------------
1. 將 zip 入面嘅檔案照路徑覆蓋落 redcode-shop repo
2. git add -A
3. git commit -m "v2.2.37 直播推送：唔送通知剔選／直入回顧剔選／延長60分鐘"
4. git push
5. Render 會自動 build＋deploy

驗收步驟（deploy 完之後）
-------------------------------------------------
A. 直入回顧：
   1. 後台直播推送 → 剔「直接放入直播回顧」→ 立即發送
   2. 手機唔會收到通知；首頁唔會出現直播中
   3. 直播頁「直播回顧」即刻見到呢場
B. 唔送通知：
   1. 剔「不發送直播通知」→ 立即發送
   2. 手機唔會收到通知；首頁即刻出現「直播中」
C. 延長：
   1. 正常發送一場（唔剔任何嘢）
   2. 「而家顯示緊」卡撳「延長 60 分鐘」→ 見到「已延長 60 分鐘」
   3. 發送紀錄表嗰場會出現「已延長 60 分鐘」徽章
D. 落播照舊：撳「立即落畫」即停顯示。

WMS 嗰邊
-------------------------------------------------
WMS 官網中心都有同樣三個功能，喺另一個 zip（red-code-wms-live-push）。
記住：要先上咗官網呢個包，WMS 個「延長 60 分鐘」掣先會 work
（WMS 係打官網新 endpoint；舊官網會回 404，個掣會彈錯誤提示，唔會整壞嘢）。
