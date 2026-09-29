═══════════════════════════════════════════════════════════════
redcode-shop v2.2.1 — 緊急修復（會員登入／順豐站點／WMS 直播紀錄 500）
═══════════════════════════════════════════════════════════════
【今次修咩】（你 2026-09-30 凌晨報嘅三個問題，同一個根源）
1. 官網會員登入失敗（畫面出現一大段 Failed query 紅字）
2. 順豐站點查詢頁「站點清單載入失敗」
3. WMS 官網中心「載入發送紀錄失敗：官網回應 HTTP 500」

根源：v2.2.0 開機自動建表程式入面，有一條一次性更新 SQL（金門檻 $5000→$8000 嗰條）
表名漏咗引號，資料庫當咗佢係另一張表 → 成批開機建表語句一齊回滾 →
v2.2.0 嘅新欄位（vipThresholdCents、livePushOptIn 等）同新表（pushSubscriptions、
pushCampaigns）全部建唔到，所以登入、站點、直播紀錄齊齊炸。

點修：
- 開機建表改做**逐句獨立執行**：以後任何一句失敗都唔會拖冧其他語句，
  失敗嗰句會喺 Render log 大聲列出嚟。
- 嗰條出事嘅一次性更新搬咗落程式碼做（唔再經 SQL 直踩，唔會再炸）。
- 加咗**開機自檢**：開機後自動核對 users 表核心欄位齊唔齊，Render log 會見到
  「[boot-migrate] users 核心欄位齊全」；如果缺會即刻紅字提你。
- 你重新部署之後，開機會自動補建晒 v2.2.0 嘅欄位同表（全部 IF NOT EXISTS，
  唔會郁到任何現有數據），三個問題齊齊好返。金門檻 $5000→$8000 嗰個一次性
  更新會一併補做（如果你後台冇自己改過其他數先會郁）。

【點放】（同之前一樣）
1. 解壓後係成個網站 repo（已剔除 .git/node_modules/dist）。
2. GitHub 網頁開 wfy0406/redcode-shop（master）→ Add file → Upload files
   → 將解壓出嚟嘅**全部嘢**拖入去（覆蓋舊檔）→ Commit changes。
3. Render 自動重新 build＋開機。開機後去 Render logs 搵
   「[boot-migrate] users 核心欄位齊全」呢行字，見到＝搞掂。
4. 環境變數唔使郁（VAPID 三條如果你 v2.2.0 未加就照 v2.2.0 README 加返）：
   VAPID_PUBLIC_KEY=BLbdWdzmRmc3Zsb7I3XcHGPfcbyuyrn8wNcKW6F7Zu7Boq_5mJY8e7fkSxu63luW5cf62EIQpefX8SvPSzBR_D4
   VAPID_PRIVATE_KEY=wb43hCF9Ze06BnnNqjy6KZPEWa-3-S6bkjxN8l0Qsz4
   VAPID_SUBJECT=mailto:redcode@redcode.red
   （私密鑰唔好外傳；WMS_CALLBACK_SECRET 之前已設；JWT_SECRET 千祈唔好改）

【順便做埋】（你上一單要求嘅 §9 會員管理升級——官網後台部分）
- 官網後台會員卡而家真係睇到：VIP 級別＋**幾時到期**、直接促銷（接受/唔接受）、
  **直播推播通知狀態＋綁定咗邊幾部電話/裝置**（iPhone・Safari 款描述＋綁定日期）。
- 管理員可以直接：逐部「移除」裝置、一撳「全部拒絕接收」、設促銷接受/唔接受、
  改 VIP 級別（升級照寄證書 email，門檻照凍結）。
- 客人自己綁定/取消綁定裝置時，WMS 嗰邊即時同步最新狀態。
- 新增 WMS→官網會員管理接口（POST /api/wms/member-admin，同退款/直播推送
  用同一條 WMS_CALLBACK_SECRET）——WMS patch 會配合用呢個口。

【WMS 嗰邊】
- 會員資料頁嘅推送狀態顯示同操作掣喺另外一個 WMS patch zip（v2.2.1 patch），
  兩個 zip 都要上先齊。
═══════════════════════════════════════════════════════════════
