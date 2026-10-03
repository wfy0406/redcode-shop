redcode.shop v2.2.44 — Android 廠牌識別 + 每部手機推送紀錄
================================================================

老闆要求：
1) 依家綁定手機清單 Android 全部寫「其他 Android」，讀唔到品牌 → 要讀到
2) 撳落去某部綁定手機 → 彈窗睇該機推送紀錄（成功/失敗），50 筆一頁

----------------------------------------------------------------
【點解之前讀唔到 Android 品牌】（技術原因，一次過講清）
----------------------------------------------------------------
Chrome 107 之後（2022 年起）Android 手機嘅 User-Agent 入面嘅
型號欄全部被凍結成「K」——即係話伺服器收到嘅 UA 永遠係
「Android 10; K」，根本冇型號可以讀。呢個係 Google 嘅
UA Reduction 政策，全世界網站都係咁，唔係我哋寫錯。

真正型號而家只可以透過 Client Hints 攞：
  - 伺服器回應加 Accept-CH 標頭（今次已加）
  - 瀏覽器下次請求就會帶 Sec-CH-UA-Model（真型號，例如 SM-S918B）
  - 訂閱推送嗰陣伺服器將型號存入資料庫新欄 deviceModel
pushClient.ts 係唔准郁嘅檔案，所以全程喺伺服器側攞標頭，
前端一個位都冇改。

----------------------------------------------------------------
【今次改咗乜】
----------------------------------------------------------------
1. 廠牌識別（api/membersRouter.ts）
   - 新增 brandFromAndroidModel()：用型號開頭判斷品牌
     SM-*→Samsung、Pixel→Google、2201123C/Redmi/POCO→Xiaomi、
     VOG-/ANA-/ELE-→Huawei、CPH*→OPPO、RMX*→realme、
     V2xxx/IQOO→vivo、OnePlus、Sony、LG、Moto、Nothing、ASUS…
     認唔到先顯示「其他 Android」
   - deviceInfoFromUserAgent() 加 deviceModel 參數：
     有型號用型號，冇型號先行返舊 UA 邏輯（iPhone/舊 Android UA 照舊準）
   - 清單多返一個 model 欄，前台會喺廠牌下面用細字顯示真型號

2. 伺服器攞真型號
   - api/boot.ts：全部回應加 Accept-CH 標頭（叫瀏覽器交型號出嚟）
   - api/pushRouter.ts：subscribe 時讀 sec-ch-ua-model 落 deviceModel
     （舊裝置重新訂閱時都會補返）

3. 推送紀錄（新表 pushDeliveries）
   - db/schema.ts + api/boot-migrate.ts：
     pushSubscriptions 加 deviceModel 欄；
     新表 pushDeliveries（subscriptionId / campaignId / ok / reason / sentAt）
     加索引（subscriptionId, sentAt DESC）
     → boot-migrate 開機自動加欄建表，唔使你手工落 SQL
   - api/livePush.ts：每次推送成功/失敗都寫一筆
     （寫唔到都唔會影響發送，catch 咗）
     失敗原因：gone（訂閱失效，已自動停用）/ http_xxx / unknown

4. 後台介面（src/components/admin/BoundDeviceList.tsx）
   - 「綁定手機」清單每行可以撳（mouse hover 會变色，有提示字）
   - 撳落去彈窗（createPortal 去 body，唔會被裁切）：
     標題：客戶名 + 品牌(型號)・瀏覽器 + 綁定時間
     內容：每筆推送 — 綠色「成功」/ 粉紅「失敗(原因)」+ 場次標題 +
           直播日期 + 場次 + 發送時間
     底部：上一頁 / 第 X 頁・每頁 50 筆 / 下一頁（冇下一頁會禁制）
   - 新手機冇紀錄會顯示「呢部裝置仲未有推送紀錄」

----------------------------------------------------------------
【要知嘅限制（老實講）】
----------------------------------------------------------------
1. 舊有綁定冇存型號：佢哋會繼續顯示「其他 Android」，
   直至客人喺部手機撳返「接收直播開播通知」（關再開都得），
   訂閱更新時就會補返型號。冇得返轉頭補，係 Chrome 限制。
2. Client Hints 係 Chrome/Edge 先有：iPhone Safari 唔使理
   （本來就讀到 Apple iPhone）；Android 用 Chrome 佔大多數。
   客人第一次入網站嗰下未必即刻帶型號，第二次請求先有——
   所以係「重新訂閱嗰下」先至一定攞到。
3. 推送紀錄由今次上線先開始計，之前發過嘅推送冇歷史可補。
4. reason 只有 gone / http_狀態碼 / unknown 三類，
   頁面會翻譯做中文顯示。

----------------------------------------------------------------
【部署步驟】
----------------------------------------------------------------
1. 將 zip 入面 7 個檔案按路徑覆蓋 repo（db/、api/、src/ 底下）
2. git add / commit / push 上 master（你推）
3. Render auto-deploy；開機時 boot-migrate 會自動：
   - pushSubscriptions 加 deviceModel 欄
   - 建 pushDeliveries 表 + 索引
   （全部 IF NOT EXISTS，重複跑唔會爆）
4. 唔使郁任何設定檔

----------------------------------------------------------------
【驗收步驟】
----------------------------------------------------------------
A. 廠牌
   1. 用 Android Chrome 開 redcode.red，撳「接收直播開播通知」
      （已綁定嘅話：關咗再開）
   2. 後台 → 綁定手機 → 嗰行廠牌應該顯示真正品牌
      （例如 Samsung），下面細字係型號（例如 SM-S918B）
B. 推送紀錄彈窗
   1. 開一場直播（或等下一場），等推送發出
   2. 後台 → 綁定手機 → 撳嗰部機 → 彈窗列出每筆推送
   3. 超過 50 筆後「下一頁」制會著，撳去第二頁
C. 舊資料
   - 未重新訂閱嘅舊裝置顯示「其他 Android」係正常（見限制1）

----------------------------------------------------------------
檔案清單（7 個）：
  db/schema.ts
  api/boot-migrate.ts
  api/boot.ts
  api/pushRouter.ts
  api/livePush.ts
  api/membersRouter.ts
  src/components/admin/BoundDeviceList.tsx

唔准郁嘅檔案（BillPage / sw.js / pushClient.ts / live-go*.html /
package.json）一個都冇掂。冇任何 endpoint/key/URL 落 log。
