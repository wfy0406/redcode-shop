RedCode 官網 v2.2.2（2026-09-30）點放說明
==========================================

今次打包入口：成個 repo 完整一份（同 v2.2.1 一樣係 full pack）。
照舊：Render 直接 redeploy 就得，開機會自動做晒 DB 補欄＋坐標回填。

────────────────────────────────────────
一、今次改咗乜（對應老闆逐條指令）
────────────────────────────────────────

【1】GPS／打地址搵站點（「我按GPS佢完全搵唔到」「打屋邨、屋苑、大廈名都要有資料」）
  ・順豐官方坐標快照落碼：api/data/sfStationCoords.ts（1741 個站點，2026-09-30 官方抓取）
    開機自動回填晒啲冇坐標嘅站點行，唔使再等每日同步先用到 GPS。
    → Render log 會見到：[boot-migrate] 順豐坐標快照回填完成：補咗 N 個站點
  ・地址搜尋改三源鏈：
    ① 香港政府地址識別服務 ALS（官方庫，屋邨／屋苑／大廈名全部有，例如「土瓜灣傲雲峰」）
    ② Nominatim（原有，街道地標）
    ③ Photon（模糊匹配後備）
    澳門關鍵字會自動跳過 ALS（佢淨係香港庫）。
  ・中英文地址都打得：ALS 官方 API 雙語，中文 query 回中文 label、英文 query 回英文 label
    （例如打 "Sky Tower To Kwa Wan" → "To Kwa Wan Substation, 82 To Kwa Wan Road, Kowloon City District"）；
    Nominatim／Photon 嘅語言參數亦跟 query 自動轉。
  ・每日定時同步照舊（開機後 30 秒跑一次，之後每 24 小時）；
    同步寫入坐標／電話／營業時間，新站點同步完即刻可以按 GPS／打地址搵到。
  ・認親邏輯修正：以往簡轉繁異體字（葵涌→葵湧、皇后→皇後、里→裏）對唔上種子名會
    當新站再插一行（重複站就係咁嚟）；而家會試晒異體變體認親，並自動停用歷史重複殘影行。
    → 同步 log 會見到：清重 N（第一次會停用約幾十個歷史重複行，之後係 0）
  ・順豐站點頁新增「地區下拉」：揀完香港/澳門可以再揀區（中西區、觀塘區…），
    選項淨顯示有站嘅區＋站數。

【2】直播顯示（「一推送就 1.5 小時喺官網」「要可以取消」）
  ・官網後台 → 直播推送：頂部新增「官網而家顯示緊」卡＋【立即落畫】掣，
    一撳首頁同直播頁即時唔再顯示該場直播（已發出嘅通知唔受影響，紀錄保留）。
  ・後台操作會審計落 log（push.endLiveNow）。

【3】直播區高度美化（「好醜，無美化過咁，請高度美化，要好生動好動感」）
  ・直播區全新設計：紅金光暈呼吸、斜向掃光、EQ 聲波條跳動、
    海報卡慢浮＋播放掣雙環擴散（全部淨 opacity/transform 動畫，合鐵律；
    客戶設咗減少動畫會自動全停）。
  ・首頁最頂新增直播 Banner：直播緊一入首頁就見到「🔴 直播開始咗啦！」，
    撳咗會 smooth scroll 落直播區塊。

【4】撳入直播直去 Facebook app（「按入去係跳去facebook app，無裝就跳網頁版」）
  ・「立即入直播」掣＋海報卡：手機自動開 Facebook app（fb:// 深鏈），
    冇裝 app 自動落網頁版；桌面機直接開網頁版新分頁。
  ・推播通知撳入去都一樣：新增跳板頁 /live-go.html，推播 click 先落跳板，
    即刻試開 FB app，開唔到先落網頁版（推播本身唔可以直接開 app，一定要經跳板頁）。
  ・後台通知預覽卡而家撳得：撳一下＝試真通知嘅跳轉，行為同真推播完全一致。

【5】推播圖示（「點解推播logo係chrome logo」）
  ・舊版直接用 /logo.png（1242×698 闊幅），Android 睇唔過跌返 Chrome 預設圖。
  ・新增 /push-icon.png（192² 方形深底 RedCode logo，通知大圖）
    ＋ /push-badge.png（96² 白色剪影，狀態欄小圖）。
  ・留意：已訂閱嘅舊裝置，瀏覽器會自行更新 service worker 先換到新圖，
    一般下次推送就見到；個別裝置可能要開一次個網站先更新到。

【6】首頁會員招呼＋VIP 三級色調（「一入到黎首頁想見到xxx寶寶，歡迎黎到RedCode！」
    「普通會員、銀會員、金會員有唔同風格同色調」）
  ・登入會員一入首頁 Hero 頂部見到：「xxx寶寶，歡迎嚟到 RedCode！」
    ＋級別徽章（普通會員／銀會員 SILVER／金會員 GOLD ✦）＋VIP 有效期至（如有）。
  ・全首頁色調跟級別轉：普通＝品牌原色；銀＝冷冽銀月色系；金＝璀璨金色系
    （全頁金色位——CTA、金線、標題色——自動轉，唔影響其他頁）。

────────────────────────────────────────
二、點放（同以往一樣）
────────────────────────────────────────
1. Render → redcode-shop → Manual Deploy → 上傳呢個 repo zip（或 Clear build cache & deploy）。
2. 開機等 1–2 分鐘，去 Render Logs 確認呢幾行：
   [boot-migrate] tables ok
   [boot-migrate] 順豐坐標快照回填完成：補咗 N 個站點
   [boot-migrate] users 核心欄位齊全
   [sf-sync] 完成：…（開機 30 秒後會自動跑第一次同步）
3. 驗收清單：
   □ 首頁最頂見唔見到直播 Banner（有直播緊先出）
   □ 直播區新動感設計；撳「立即入直播」手機直去 FB app
   □ 後台 → 直播推送 → 「立即落畫」撳完首頁直播區即刻消失
   □ 順豐站點頁：揀香港 → 地區下拉揀「九龍城區」→ 列表即篩
   □ 打「土瓜灣傲雲峰」搵最近站點 → 有結果
   □ 發一次測試推播：通知圖示係 RedCode logo；撳通知直去 FB app
   □ 登入會員首頁見到「xxx寶寶，歡迎嚟到 RedCode！」＋級別徽章

────────────────────────────────────────
三、技術備忘（比以後嘅我）
────────────────────────────────────────
・pushCampaigns 加咗 endedAt 欄（boot-migrate ALTER 自動補）；currentLive 過濾 endedAt IS NULL。
・推播 payload data.url 而家指去 siteUrl()/live-go.html?u=<enc>（淨 FB 系連結先跳板）。
・sw.js icon/badge 換咗 /push-icon.png、/push-badge.png（方形＋單色剪影，Android 至肯顯示）。
・LiveNowSection 棄用 FB plugins/video.php iframe：直播完結／群組直播／非公開影片會顯示
  「影片不存在」，老闆以為壞咗。而家係品牌海報卡＋fb:// 深鏈。
・geocodeAddress 三源鏈：ALS（HK 官方）→ Nominatim → Photon；query 明文繼續永遠唔落 log。
・sfSync 認親試異體字變體（nameVariants），同步尾段停用異體重複殘影行（stats.deduped）。
・sfStationCoords.ts 係自動生成快照，唔好手改；回填 UPDATE 淨填 NULL 位，唔會蓋過每日同步。
